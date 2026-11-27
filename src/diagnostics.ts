// Runs the solver on known cases and reports mass and energy balance.
import { STRIDE } from './model/geometry';
import { createGrid, index } from './model/grid';
import { defaultLayout } from './model/machine';
import { sourceMix } from './model/trace';
import type { Layout } from './model/types';
import { runLayout, type RunResult } from './sim/run';
import { createSolver, requestDevice, type Solver } from './sim/solver';

const out = document.getElementById('out')!;
const log = (line: string) => {
  out.textContent += `\n${line}`;
  console.log(`[diag] ${line}`);
};
const verdict = (ok: boolean) => (ok ? 'PASS' : 'FAIL');
const CFM = 0.000471947;

const run = async (solver: Solver, layout: Layout) => (await runLayout(solver, layout)) as RunResult;

async function main() {
  const device = await requestDevice();
  const solver = await createSolver(device, createGrid(0.005));
  out.textContent = 'Solver diagnostics (5 mm grid)';

  const base = defaultLayout();
  const heatIn = base.power.cpuLoad + base.power.gpuLoad;

  const still = await run(solver, { ...base, fans: [], power: { cpuIdle: 0, cpuLoad: 0, gpuIdle: 0, gpuLoad: 0 } });
  const fastest = still.fields.vel.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  log(`No fans, no heat: fastest air ${fastest.toExponential(2)} m/s  ${verdict(fastest < 1e-3)}`);

  const started = performance.now();
  const mine = await run(solver, base);
  log(`My PC: ${((performance.now() - started) / 1000).toFixed(0)} s wall clock for 8 s simulated`);
  const net = Math.abs(mine.netFlux) / mine.outflow;
  log(`  net flux through case walls / outflow: ${(100 * net).toFixed(2)} %  ${verdict(net < 0.02)}`);
  const heat = mine.heatOut / heatIn;
  log(`  heat out / heat in: ${(100 * heat).toFixed(1)} %  ${verdict(Math.abs(heat - 1) < 0.1)}`);
  log(`  CPU ${mine.cpuC.toFixed(1)} °C, GPU ${mine.gpuC.toFixed(1)} °C, intake air ${mine.intakeC.toFixed(2)} °C, exhaust ${mine.exhaustC.toFixed(2)} °C`);
  log(`  delivered intake ${(mine.intake / CFM).toFixed(0)} CFM, exhaust ${(mine.exhaust / CFM).toFixed(0)} CFM`);
  log(`  flow delivered / free-air: ${base.fans.map((f) => `${f.id} ${(100 * (mine.factors.get(f.id) ?? 1)).toFixed(0)}%`).join(', ')}`);
  for (const part of ['cpu', 'gpu'] as const) {
    const mix = sourceMix(mine.geometry, base, mine.fields.vel, part);
    log(`  air at ${part}: ${mix.map((s) => `${s.label} ${(100 * s.fraction).toFixed(0)}%`).join(', ')}`);
  }

  const free = await run(solver, { ...base, backPressure: false });
  log(`Without back-pressure: CPU ${free.cpuC.toFixed(1)} °C, GPU ${free.gpuC.toFixed(1)} °C, intake ${(free.intake / CFM).toFixed(0)} CFM`);

  const open = await run(solver, { ...base, ventLoss: 0 });
  const tight = await run(solver, { ...base, ventLoss: 12 });
  log(
    `Front fans deliver ${[open, mine, tight].map((r) => `${(100 * (r.factors.get('front-2') ?? 1)).toFixed(0)}%`).join(', ')} ` +
      `at K = 0, 4, 12  ${verdict((open.factors.get('front-2') ?? 0) > (tight.factors.get('front-2') ?? 1))}`,
  );

  // A front fan flipped from intake to exhaust must reverse the flow through it.
  const front = base.fans[1];
  const g = solver.grid;
  const cell = index(
    g,
    Math.round(front.pos[0] / g.h) - 8 + g.origin[0],
    Math.round(front.pos[1] / g.h) + g.origin[1],
    Math.round(front.pos[2] / g.h) + g.origin[2],
  );
  const flows: number[] = [];
  for (const sense of [1, -1]) {
    const single = await run(solver, { ...base, fans: [{ ...front, dir: [-sense, 0, 0] }] });
    flows.push(single.fields.vel[cell * STRIDE]);
  }
  log(
    `Single front fan, flow inboard of it: ${flows[0].toFixed(2)} m/s as intake, ` +
      `${flows[1].toFixed(2)} m/s as exhaust  ${verdict(flows[0] < 0 && flows[1] > 0)}`,
  );
  log('Done.');
}

main().catch((error: unknown) => log(`ERROR: ${error instanceof Error ? error.message : String(error)}`));
