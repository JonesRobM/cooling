import { describe, expect, it } from 'vitest';
import { operatingFraction, updateFanFactors } from '../src/model/backpressure';
import { fanFlow, FAN_MODELS } from '../src/model/fans';
import { FIXED_U, MESH_U, SOLID, STRIDE, applyFanFactors, voxelise } from '../src/model/geometry';
import { createGrid, index, wallPlane } from '../src/model/grid';
import { History } from '../src/model/history';
import { parseLayout, serialiseLayout } from '../src/model/layout';
import { SECOND_GPU_DROP, defaultLayout } from '../src/model/machine';
import { computeMetrics } from '../src/model/metrics';
import { componentTemperature, HEATSINKS } from '../src/model/thermal';
import { sourceMix } from '../src/model/trace';
import { AIR_CP, AIR_DENSITY, type Fan, type Layout } from '../src/model/types';

const grid = createGrid(0.005);
const only = (...fans: Fan[]): Layout => ({ ...defaultLayout(), fans });
const midFan: Fan = { id: 'a', role: 'case', model: 'p12', rpm: 2000, pos: [0.3, 0.1, 0.095], dir: [-1, 0, 0] };

describe('grid', () => {
  it('surrounds the case with air', () => {
    expect(grid.inner).toEqual([88, 92, 38]);
    expect(grid.origin).toEqual([16, 5, 0]);
    expect(grid.cells).toEqual([120, 117, 48]);
  });
});

describe('voxelise', () => {
  it('gives an axis-aligned fan a flux of Q, scaled by its factor', () => {
    const g = voxelise(only(midFan), grid);
    const q = fanFlow(FAN_MODELS.p12, 2000);
    const layerFluxes = () => {
      const byLayer = new Map<number, number>();
      for (const slot of g.fans[0].slots) {
        if (slot % STRIDE !== 0) continue;
        const layer = Math.floor(slot / STRIDE) % grid.dims[0];
        byLayer.set(layer, (byLayer.get(layer) ?? 0) - g.fixed[slot] * grid.h ** 2);
      }
      return [...byLayer.values()];
    };
    expect(layerFluxes().length).toBeGreaterThan(0);
    for (const f of layerFluxes()) expect(Math.abs(f - q) / q).toBeLessThan(0.01);
    applyFanFactors(g, new Map([['a', 0.5]]));
    for (const f of layerFluxes()) expect(Math.abs(f - q / 2) / q).toBeLessThan(0.01);
  });
  it('closes the tray and glass, meshes the front and top, and leaves the surroundings open', () => {
    const g = voxelise(only(), grid);
    const mid = [grid.origin[0] + 40, grid.origin[1] + 40, grid.origin[2] + 19];
    const glass = index(grid, mid[0], mid[1], wallPlane(grid, 2, 1));
    expect(g.flags[glass] & (FIXED_U << 2)).toBeTruthy();
    const front = index(grid, wallPlane(grid, 0, 1), mid[1], mid[2]);
    expect(g.flags[front] & FIXED_U).toBeFalsy();
    expect(g.flags[front] & MESH_U).toBeTruthy();
    const top = index(grid, mid[0], wallPlane(grid, 1, 1), mid[2]);
    expect(g.flags[top] & (MESH_U << 1)).toBeTruthy();
    const edge = index(grid, grid.cells[0], mid[1], mid[2]);
    expect(g.flags[edge] & (FIXED_U | MESH_U)).toBeFalsy();
  });
  it('lets solids win over fans', () => {
    const g = voxelise(only({ ...midFan, pos: [0.1, 0.2, 0.07], dir: [0, 1, 0] }), grid);
    const step = [1, grid.dims[0], grid.dims[0] * grid.dims[1]];
    let open = 0;
    let driven = 0;
    let solids = 0;
    for (let c = 0; c < g.flags.length; c++) {
      if (!(g.flags[c] & SOLID)) continue;
      solids++;
      for (let a = 0; a < 3; a++)
        for (const face of [c, c + step[a]]) {
          if (!(g.flags[face] & (FIXED_U << a))) open++;
          if (g.fixed[face * STRIDE + a] !== 0) driven++;
        }
    }
    expect(solids).toBeGreaterThan(0);
    expect([open, driven]).toEqual([0, 0]);
  });
  it('has no driven faces without fans, or with a fan far outside', () => {
    for (const layout of [only(), only({ ...midFan, pos: [2, 2, 2] })]) {
      const g = voxelise(layout, grid);
      expect(g.fans).toEqual([]);
      expect(g.fixed.every((v, i) => i % STRIDE === 3 || v === 0)).toBe(true);
    }
  });
  it('distributes exactly the configured heat, at either resolution', () => {
    const layout = { ...defaultLayout(), scenario: 'both' as const };
    for (const h of [0.005, 0.004]) {
      const g = voxelise(layout, createGrid(h));
      let kelvinPerSecond = 0;
      for (let c = 0; c < g.flags.length; c++) kelvinPerSecond += g.fixed[c * STRIDE + 3];
      expect(kelvinPerSecond * 1.2 * 1005 * h ** 3).toBeCloseTo(layout.power.cpuLoad + layout.power.gpuLoad, 0);
    }
  });
});

describe('back-pressure', () => {
  it('delivers free-air flow against nothing, none at stall, less through mesh', () => {
    expect(operatingFraction(10, 0, 0)).toBe(1);
    expect(operatingFraction(10, 10, 0)).toBe(0);
    expect(operatingFraction(10, 20, 0)).toBe(0);
    expect(operatingFraction(10, 0, 30)).toBeCloseTo(0.5);
    expect(operatingFraction(10, -100, 0)).toBe(1.2);
  });
  it('leaves fans without a pressure curve alone', () => {
    const g = voxelise(defaultLayout(), grid);
    const factors = new Map<string, number>();
    updateFanFactors(g, new Float32Array(grid.count), 0.004, factors);
    expect(factors.has('gpu-1')).toBe(false);
    expect(factors.get('front-1')).toBeLessThan(1); // mesh in front of it
  });
});

describe('thermal', () => {
  const s = HEATSINKS.cpu;
  it('rises with power and falls with air speed', () => {
    expect(componentTemperature(s, 200, 25, 2)).toBeGreaterThan(componentTemperature(s, 100, 25, 2));
    expect(componentTemperature(s, 200, 25, 3)).toBeLessThan(componentTemperature(s, 200, 25, 1));
  });
  it('stays finite with still air', () => {
    expect(Number.isFinite(componentTemperature(s, 200, 25, 0))).toBe(true);
  });
});

describe('metrics', () => {
  it('finds no net flux or heat for still ambient air', () => {
    const g = voxelise(only(), grid);
    const m = computeMetrics(g, new Float32Array(grid.count * 4), new Float32Array(grid.count).fill(21), 21);
    expect(m.netFlux).toBe(0);
    expect(m.heatOut).toBe(0);
    expect(m.exhaustTempC).toBe(21);
    expect(m.intakeTempC).toBe(21);
  });
  it('balances a uniform wind from front to rear', () => {
    const g = voxelise(only(), grid);
    const vel = new Float32Array(grid.count * 4);
    for (let c = 0; c < grid.count; c++) vel[c * 4 + 1] = 1; // upwards: in at the bottom, out at the top
    const m = computeMetrics(g, vel, new Float32Array(grid.count).fill(25), 21);
    expect(m.netFlux).toBeCloseTo(0);
    expect(m.outflow).toBeCloseTo(0.44 * 0.19);
    expect(m.intakeTempC).toBeCloseTo(25);
    expect(m.heatOut).toBeCloseTo(0);
  });
});

describe('air sources', () => {
  it('traces a front-to-rear wind back to the front', () => {
    const layout = only({ ...midFan, id: 'front-1', group: 'front', pos: [0.4275, 0.325, 0.095], rpm: 2000 });
    const g = voxelise(layout, grid);
    const vel = new Float32Array(grid.count * 4);
    for (let c = 0; c < grid.count; c++) vel[c * 4] = -2;
    const mix = sourceMix(g, layout, vel, 'cpu');
    expect(mix.reduce((s, m) => s + m.fraction, 0)).toBeCloseTo(1);
    const fromFront = mix.filter((m) => m.label.startsWith('front')).reduce((s, m) => s + m.fraction, 0);
    expect(fromFront).toBeGreaterThan(0.8);
  });
});

describe('history', () => {
  it('undoes and redoes, and a new change drops the redo branch', () => {
    const h = new History('a');
    h.commit('b');
    h.commit('b');
    h.commit('c');
    expect([h.undo(), h.undo(), h.undo()]).toEqual(['b', 'a', null]);
    expect(h.redo()).toBe('b');
    h.commit('d');
    expect(h.redo()).toBeNull();
  });
});

describe('second GPU', () => {
  const both: Layout = { ...defaultLayout(), secondGpu: true };
  const backplateCell = () => {
    const [x, y, z] = [0.1, 0.2025 - SECOND_GPU_DROP, 0.07].map((v, a) => Math.floor(v / grid.h) + grid.origin[a]);
    return index(grid, x, y, z);
  };
  it('adds a second card and heatsink without leaking into single-GPU layouts', () => {
    const two = voxelise(both, grid);
    expect(two.regions.gpu2.length).toBe(two.regions.gpu.length);
    expect(two.flags[backplateCell()] & SOLID).toBeTruthy();
    const one = voxelise(defaultLayout(), grid);
    expect(one.regions.gpu2).toEqual([]);
    expect(one.flags[backplateCell()] & SOLID).toBeFalsy();
  });
  it('releases the load of each card', () => {
    const g = voxelise(both, grid);
    let watts = 0;
    for (let c = 0; c < grid.count; c++) watts += g.fixed[c * STRIDE + 3] * AIR_DENSITY * AIR_CP * grid.h ** 3;
    expect(watts).toBeCloseTo(200 + 180 + 180, 0);
  });
  it('is off in layouts saved before it existed', () => {
    const old = JSON.parse(serialiseLayout(defaultLayout()));
    delete old.secondGpu;
    expect(parseLayout(JSON.stringify(old)).secondGpu).toBe(false);
  });
});
