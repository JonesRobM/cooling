// Runs one layout to a settled state without any display, and averages the readings.
import { updateFanFactors } from '../model/backpressure';
import { flowTotals } from '../model/fans';
import { applyFanFactors, voxelise, type Geometry } from '../model/geometry';
import { computeMetrics, type Metrics } from '../model/metrics';
import { estimateComponents } from '../model/thermal';
import type { Layout } from '../model/types';
import { DT, type Fields, type Solver } from './solver';

const CHUNK = 50; // steps between fan updates, 0.2 s of simulated time
const SETTLE_STEPS = 1600;
const SAMPLES = 8;

export interface RunResult {
  cpuC: number;
  gpuC: number;
  gpu2C: number;
  secondGpu: boolean;
  exhaustC: number;
  intakeC: number;
  /** Delivered case fan flows, m³/s. */
  intake: number;
  exhaust: number;
  netFlux: number;
  heatOut: number;
  outflow: number;
  factors: Map<string, number>;
  geometry: Geometry;
  fields: Fields;
}

export async function runLayout(
  solver: Solver,
  layout: Layout,
  progress: (fraction: number) => void = () => {},
  cancelled: () => boolean = () => false,
): Promise<RunResult | null> {
  const geometry = voxelise(layout, solver.grid);
  const factors = new Map<string, number>();
  solver.reset(layout.ambientC);
  solver.setGeometry(geometry, layout.ambientC);

  const total = SETTLE_STEPS + SAMPLES * CHUNK;
  const samples: Metrics[] = [];
  let fields!: Fields;
  for (let done = CHUNK; done <= total; done += CHUNK) {
    if (cancelled()) return null;
    solver.step(CHUNK);
    fields = await solver.read();
    if (layout.backPressure) {
      updateFanFactors(geometry, fields.phi, DT, factors);
      applyFanFactors(geometry, factors);
      solver.setFixed(geometry);
    }
    if (done > SETTLE_STEPS) samples.push(computeMetrics(geometry, fields.vel, fields.temp, layout.ambientC));
    progress(done / total);
  }

  const mean = (pick: (m: Metrics) => number) => samples.reduce((s, m) => s + pick(m), 0) / samples.length;
  const components = estimateComponents(layout, {
    cpu: { airC: mean((m) => m.cpu.airC), speed: mean((m) => m.cpu.speed) },
    gpu: { airC: mean((m) => m.gpu.airC), speed: mean((m) => m.gpu.speed) },
    gpu2: { airC: mean((m) => m.gpu2.airC), speed: mean((m) => m.gpu2.speed) },
  });
  const flows = flowTotals(layout, factors);
  return {
    ...components,
    secondGpu: layout.secondGpu,
    exhaustC: mean((m) => m.exhaustTempC),
    intakeC: mean((m) => m.intakeTempC),
    intake: flows.intake,
    exhaust: flows.exhaust,
    netFlux: mean((m) => m.netFlux),
    heatOut: mean((m) => m.heatOut),
    outflow: mean((m) => m.outflow),
    factors,
    geometry,
    fields,
  };
}
