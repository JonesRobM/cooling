// Turns a layout into the solver's buffers on a staggered grid.
// Face a of index (i,j,k) is the low face of that cell along axis a.
import { FAN_MODELS, fanDuty, fanFlow } from './fans';
import { index, wallPlane, type Grid } from './grid';
import { resolveFan } from './layout';
import { REAR_VENTS, SOLIDS, gpuSolids, heatsinks, type Box } from './machine';
import { AIR_CP, AIR_DENSITY, type Layout, type Part, type Vec3 } from './types';

export const STRIDE = 4;
export const SOLID = 1;
export const FIXED_U = 2; // FIXED_U << axis for v and w
export const MESH_U = 16; // MESH_U << axis: the face crosses a vented wall

export interface FanFaces {
  id: string;
  /** Entries into the fixed buffer: index * STRIDE + axis. */
  slots: Int32Array;
  /** Face velocities when delivering the free-air flow. */
  base: Float32Array;
  /** Points just outside the disc, for the pressure rise across it. */
  upstream: Vec3[];
  downstream: Vec3[];
  /** Free-air flow at this speed (m³/s) and mean velocity through the disc (m/s). */
  freeFlow: number;
  freeSpeed: number;
  /** Stall pressure at this speed, Pa; null if the fan has no pressure curve. */
  maxPressure: number | null;
  /** Whether the fan sits against a vented wall and so also pushes through the mesh. */
  atMesh: boolean;
}

export interface Geometry {
  grid: Grid;
  flags: Uint32Array;
  /** xyz: fixed face velocities (m/s). w: cell heating rate (K/s). */
  fixed: Float32Array;
  /** xyz: cell drag rates (1/s). */
  drag: Float32Array;
  regions: Record<Part, number[]>;
  fans: FanFaces[];
  ventLoss: number;
}

/** Visit the indices of a grid region, clipped to the array. */
function visit(g: Grid, lo: Vec3, hi: Vec3, fn: (i: number, j: number, k: number, c: number) => void) {
  const a = lo.map((v) => Math.max(0, v));
  const b = hi.map((v, d) => Math.min(g.dims[d] - 1, v));
  for (let k = a[2]; k <= b[2]; k++)
    for (let j = a[1]; j <= b[1]; j++)
      for (let i = a[0]; i <= b[0]; i++) fn(i, j, k, index(g, i, j, k));
}

/** Visit the cells whose centres lie inside a box (metres). */
function cellsIn(g: Grid, box: Box, fn: (c: number, i: number, j: number, k: number) => void) {
  const lo = box.min.map((v, a) => Math.ceil(v / g.h - 0.5 - 1e-6) + g.origin[a]) as Vec3;
  const hi = box.max.map((v, a) => Math.floor(v / g.h - 0.5 + 1e-6) + g.origin[a]) as Vec3;
  visit(g, lo, hi, (i, j, k, c) => fn(c, i, j, k));
}

function rearIsVented(g: Grid, j: number, k: number): boolean {
  const y = (j - g.origin[1] + 0.5) * g.h;
  const z = (k - g.origin[2] + 0.5) * g.h;
  return REAR_VENTS.some((v) => y >= v.min[1] && y <= v.max[1] && z >= v.min[2] && z <= v.max[2]);
}

interface Shell {
  flags: Uint32Array;
  /** Slots of faces that stay closed whatever the fans do. */
  solid: number[];
}

/** The parts no fan can change: the domain edge, case walls and solid components. */
function buildShell(g: Grid, secondGpu: boolean): Shell {
  const flags = new Uint32Array(g.count);
  const solid: number[] = [];

  visit(g, [0, 0, 0], g.cells, (i, j, k, c) => {
    const p = [i, j, k];
    for (let a = 0; a < 3; a++) {
      const exists = p.every((v, d) => v < g.cells[d] + (d === a ? 1 : 0));
      // The desk (y = 0) and the tray plane (z = 0) are closed; the other edges are open air.
      const closedEdge = a !== 0 && p[a] === 0;
      if (!exists || closedEdge) flags[c] |= FIXED_U << a;
    }
  });

  // Case walls: thin barriers between the inside and the surrounding air.
  for (let a = 0; a < 3; a++) {
    for (const side of [0, 1] as const) {
      const lo = [...g.origin] as Vec3;
      const hi = g.origin.map((o, d) => o + g.inner[d] - 1) as Vec3;
      lo[a] = hi[a] = wallPlane(g, a, side);
      visit(g, lo, hi, (_, j, k, c) => {
        // Front, top and bottom are mesh; the rear has vents; tray and glass are solid.
        const vented = a === 1 || (a === 0 && (side === 1 || rearIsVented(g, j, k)));
        if (vented) flags[c] |= MESH_U << a;
        else {
          flags[c] |= FIXED_U << a;
          if (a === 2) solid.push(c * STRIDE + a);
        }
      });
    }
  }

  for (const { box } of [...SOLIDS, ...gpuSolids(secondGpu)]) {
    cellsIn(g, box, (c, i, j, k) => {
      flags[c] |= SOLID;
      for (let a = 0; a < 3; a++) {
        const next = index(g, i + (a === 0 ? 1 : 0), j + (a === 1 ? 1 : 0), k + (a === 2 ? 1 : 0));
        solid.push(c * STRIDE + a, next * STRIDE + a);
      }
    });
  }
  for (const slot of solid) flags[Math.floor(slot / STRIDE)] |= FIXED_U << slot % STRIDE;
  return { flags, solid };
}

const shells = new Map<string, Shell>();

/** Points on rings across a fan's disc, `offset` metres along its axis from the centre. */
export function discSamples(pos: Vec3, dir: Vec3, radius: number, offset: number): Vec3[] {
  const helper: Vec3 = Math.abs(dir[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const cross = (a: Vec3, b: Vec3): Vec3 => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const u = cross(helper, dir);
  const length = Math.hypot(...u);
  u.forEach((_, i) => (u[i] /= length));
  const v = cross(dir, u);
  const points: Vec3[] = [];
  for (const r of [0.4, 0.75])
    for (let n = 0; n < 8; n++) {
      const angle = (n * Math.PI) / 4 + r;
      points.push(
        pos.map(
          (p, i) => p + dir[i] * offset + radius * r * (u[i] * Math.cos(angle) + v[i] * Math.sin(angle)),
        ) as Vec3,
      );
    }
  return points;
}

export function voxelise(layout: Layout, g: Grid): Geometry {
  const key = `${g.h}|${layout.secondGpu}`;
  let shell = shells.get(key);
  if (!shell) shells.set(key, (shell = buildShell(g, layout.secondGpu)));
  const flags = shell.flags.slice();
  const fixed = new Float32Array(g.count * STRIDE);
  const drag = new Float32Array(g.count * STRIDE);
  const regions: Geometry['regions'] = { cpu: [], gpu: [], gpu2: [] };
  const closed = new Set(shell.solid);
  const fans: FanFaces[] = [];
  const h = g.h;

  // Fans drive the faces inside their swept disc.
  layout.fans.forEach((fan, n) => {
    const model = FAN_MODELS[fan.model];
    const flow = fanFlow(model, fan.rpm);
    if (flow <= 0) return;
    const { pos, dir } = resolveFan(fan, layout.cooler);
    const radius = model.diameter / 2;
    const half = model.thickness / 2 + 1e-9;
    const reach = Math.hypot(radius, half);
    const lo = pos.map((v, a) => Math.max(0, Math.floor((v - reach) / h) + g.origin[a] - 1));
    const hi = pos.map((v, a) => Math.min(g.cells[a], Math.ceil((v + reach) / h) + g.origin[a] + 1));
    const slots: number[] = [];
    const axes: number[] = [];
    const main = [0, 1, 2].reduce((best, a) => (Math.abs(dir[a]) > Math.abs(dir[best]) ? a : best), 0);
    const layers = new Set<number>();
    let mainCount = 0;
    // Plain loops with no allocation: this runs repeatedly while a fan is dragged.
    for (let k = lo[2]; k <= hi[2]; k++)
      for (let j = lo[1]; j <= hi[1]; j++)
        for (let i = lo[0]; i <= hi[0]; i++)
          for (let a = 0; a < 3; a++) {
            // Skip faces that do not exist.
            if (
              (i === g.cells[0] && a !== 0) ||
              (j === g.cells[1] && a !== 1) ||
              (k === g.cells[2] && a !== 2)
            )
              continue;
            const x = (i - g.origin[0] + (a === 0 ? 0 : 0.5)) * h - pos[0];
            const y = (j - g.origin[1] + (a === 1 ? 0 : 0.5)) * h - pos[1];
            const z = (k - g.origin[2] + (a === 2 ? 0 : 0.5)) * h - pos[2];
            const axial = x * dir[0] + y * dir[1] + z * dir[2];
            if (Math.abs(axial) > half || x * x + y * y + z * z - axial * axial > radius * radius) continue;
            const slot = index(g, i, j, k) * STRIDE + a;
            if (closed.has(slot)) continue; // solids, tray and glass win
            if (a === main) {
              layers.add(a === 0 ? i : a === 1 ? j : k);
              mainCount++;
            }
            slots.push(slot);
            axes.push(a);
          }
    if (mainCount === 0) return; // entirely outside the domain
    const area = (mainCount / layers.size) * h * h;
    const speed = flow / (area * Math.abs(dir[main]));
    const base = new Float32Array(slots.length);
    for (let s = 0; s < slots.length; s++) {
      base[s] = speed * dir[axes[s]];
      flags[(slots[s] - axes[s]) / STRIDE] |= FIXED_U << axes[s];
      fixed[slots[s]] = base[s];
    }
    const offset = model.thickness / 2 + 1.5 * h;
    fans.push({
      id: fan.id,
      slots: Int32Array.from(slots),
      base,
      upstream: discSamples(pos, dir, radius, -offset),
      downstream: discSamples(pos, dir, radius, offset),
      freeFlow: flow,
      freeSpeed: flow / area,
      maxPressure: model.maxPressure === null ? null : model.maxPressure * (fan.rpm / model.ratedRpm) ** 2,
      atMesh: fanDuty(layout, n) !== 'internal',
    });
  });

  // Heatsinks: drag and heat.
  const loaded = (part: 'cpu' | 'gpu') => layout.scenario === part || layout.scenario === 'both';
  const gpuWatts = loaded('gpu') ? layout.power.gpuLoad : layout.power.gpuIdle;
  const power = { cpu: loaded('cpu') ? layout.power.cpuLoad : layout.power.cpuIdle, gpu: gpuWatts, gpu2: gpuWatts };
  for (const sink of heatsinks(layout.cooler.rotation, layout.secondGpu)) {
    cellsIn(g, sink.box, (c) => {
      if (flags[c] & SOLID) return;
      drag.set(sink.drag, c * STRIDE);
      regions[sink.part].push(c);
    });
  }
  for (const part of ['cpu', 'gpu', 'gpu2'] as const) {
    const rate = power[part] / (AIR_DENSITY * AIR_CP * regions[part].length * h ** 3);
    for (const c of regions[part]) fixed[c * STRIDE + 3] = rate;
  }

  return { grid: g, flags, fixed, drag, regions, fans, ventLoss: layout.ventLoss };
}

/** Rewrite the fan face velocities for the given fraction of free-air flow per fan. */
export function applyFanFactors(geometry: Geometry, factors: ReadonlyMap<string, number>): void {
  for (const fan of geometry.fans) {
    const factor = factors.get(fan.id) ?? 1;
    for (let s = 0; s < fan.slots.length; s++) geometry.fixed[fan.slots[s]] = fan.base[s] * factor;
  }
}
