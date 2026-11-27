import type { Geometry } from '../model/geometry';
import type { Grid } from '../model/grid';
import shader from './solver.wgsl?raw';

export const DT = 0.004; // s
const PRESSURE_ITERATIONS = 24;
const TEMPERATURE_SUBSTEPS = 3;

export interface Fields {
  /** vec4 per index: face velocities, m/s. */
  vel: Float32Array;
  /** Cell temperatures, °C. */
  temp: Float32Array;
  /** Cell pressures as p·dt/(ρh), m/s. */
  phi: Float32Array;
}

export interface Solver {
  readonly grid: Grid;
  setGeometry(g: Geometry, ambientC: number): void;
  /** Upload only the fixed face values, after the fan factors have changed. */
  setFixed(g: Geometry): void;
  step(count: number): void;
  read(): Promise<Fields>;
  reset(ambientC: number): void;
  destroy(): void;
}

export async function requestDevice(): Promise<GPUDevice> {
  if (!navigator.gpu) throw new Error('This browser does not support WebGPU. Use a current Chrome or Edge.');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No WebGPU adapter is available. Check that hardware acceleration is enabled.');
  return adapter.requestDevice();
}

export async function createSolver(device: GPUDevice, grid: Grid): Promise<Solver> {
  const { count, dims } = grid;
  const workgroups: [number, number, number] = [
    Math.ceil(dims[0] / 8),
    Math.ceil(dims[1] / 8),
    Math.ceil(dims[2] / 4),
  ];
  const module = device.createShaderModule({ code: shader });
  const pipeline = (entryPoint: string, constants?: Record<string, number>) =>
    device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint, constants } });

  const [advect, divergence, red, black, project, temperature] = await Promise.all([
    pipeline('advect'),
    pipeline('divergence'),
    pipeline('pressure', { COLOUR: 0 }),
    pipeline('pressure', { COLOUR: 1 }),
    pipeline('project'),
    pipeline('temperature'),
  ]);

  const buffer = (size: number, usage: number) => device.createBuffer({ size, usage });
  const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
  const vecBytes = count * 16;
  const scalarBytes = count * 4;

  const params = buffer(48, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
  const flags = buffer(scalarBytes, storage);
  const fixed = buffer(vecBytes, storage);
  const drag = buffer(vecBytes, storage);
  const vel = buffer(vecBytes, storage);
  const velNext = buffer(vecBytes, storage);
  const temp = buffer(scalarBytes, storage);
  const tempNext = buffer(scalarBytes, storage);
  const phi = buffer(scalarBytes, storage);
  const div = buffer(scalarBytes, storage);
  const weights = buffer(vecBytes, storage);
  const staging = buffer(vecBytes + 2 * scalarBytes, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST);

  const bind = (p: GPUComputePipeline, entries: [number, GPUBuffer][]) =>
    device.createBindGroup({
      layout: p.getBindGroupLayout(0),
      entries: entries.map(([binding, b]) => ({ binding, resource: { buffer: b } })),
    });

  const groups = {
    advect: bind(advect, [[0, params], [1, flags], [2, fixed], [3, drag], [4, vel], [5, velNext], [6, temp], [10, weights]]),
    divergence: bind(divergence, [[0, params], [4, vel], [9, div]]),
    red: bind(red, [[0, params], [1, flags], [8, phi], [9, div], [10, weights]]),
    black: bind(black, [[0, params], [1, flags], [8, phi], [9, div], [10, weights]]),
    project: bind(project, [[0, params], [1, flags], [5, vel], [8, phi], [10, weights]]),
    temperature: bind(temperature, [[0, params], [1, flags], [2, fixed], [4, vel], [6, temp], [7, tempNext]]),
  };

  const run = (encoder: GPUCommandEncoder, work: [GPUComputePipeline, GPUBindGroup][]) => {
    const pass = encoder.beginComputePass();
    for (const [p, group] of work) {
      pass.setPipeline(p);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(...workgroups);
    }
    pass.end();
  };

  let ventLoss = 0;
  const writeParams = (ambientC: number) => {
    const data = new ArrayBuffer(48);
    new Uint32Array(data, 0, 3).set(dims);
    const f = new Float32Array(data);
    f[3] = DT;
    f[4] = grid.h;
    f[5] = 3e-4; // eddy viscosity, m²/s
    f[6] = 3e-4; // eddy diffusivity, m²/s
    f[7] = ambientC;
    f[8] = 9.81 / (273.15 + ambientC);
    f[9] = 1.7;
    f[10] = ventLoss;
    device.queue.writeBuffer(params, 0, data);
  };

  let reading: Promise<Fields> | null = null;

  return {
    grid,

    setFixed(g) {
      device.queue.writeBuffer(fixed, 0, g.fixed);
    },

    setGeometry(g, ambientC) {
      ventLoss = g.ventLoss;
      writeParams(ambientC);
      device.queue.writeBuffer(flags, 0, g.flags);
      device.queue.writeBuffer(fixed, 0, g.fixed);
      device.queue.writeBuffer(drag, 0, g.drag);
    },

    step(count) {
      const encoder = device.createCommandEncoder();
      for (let n = 0; n < count; n++) {
        run(encoder, [[advect, groups.advect]]);
        encoder.copyBufferToBuffer(velNext, 0, vel, 0, vecBytes);
        const solve: [GPUComputePipeline, GPUBindGroup][] = [[divergence, groups.divergence]];
        for (let i = 0; i < PRESSURE_ITERATIONS; i++) solve.push([red, groups.red], [black, groups.black]);
        solve.push([project, groups.project]);
        run(encoder, solve);
        for (let s = 0; s < TEMPERATURE_SUBSTEPS; s++) {
          run(encoder, [[temperature, groups.temperature]]);
          encoder.copyBufferToBuffer(tempNext, 0, temp, 0, scalarBytes);
        }
      }
      device.queue.submit([encoder.finish()]);
    },

    read() {
      reading ??= (async () => {
        const encoder = device.createCommandEncoder();
        encoder.copyBufferToBuffer(vel, 0, staging, 0, vecBytes);
        encoder.copyBufferToBuffer(temp, 0, staging, vecBytes, scalarBytes);
        encoder.copyBufferToBuffer(phi, 0, staging, vecBytes + scalarBytes, scalarBytes);
        device.queue.submit([encoder.finish()]);
        await staging.mapAsync(GPUMapMode.READ);
        const data = staging.getMappedRange().slice(0);
        staging.unmap();
        reading = null;
        return {
          vel: new Float32Array(data, 0, count * 4),
          temp: new Float32Array(data, vecBytes, count),
          phi: new Float32Array(data, vecBytes + scalarBytes, count),
        };
      })();
      return reading;
    },

    reset(ambientC) {
      writeParams(ambientC);
      const encoder = device.createCommandEncoder();
      for (const b of [vel, velNext, phi, div]) encoder.clearBuffer(b);
      device.queue.submit([encoder.finish()]);
      const still = new Float32Array(count).fill(ambientC);
      device.queue.writeBuffer(temp, 0, still);
      device.queue.writeBuffer(tempNext, 0, still);
    },

    destroy() {
      for (const b of [params, flags, fixed, drag, vel, velNext, temp, tempNext, phi, div, weights, staging]) b.destroy();
    },
  };
}
