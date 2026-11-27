import { updateFanFactors } from './model/backpressure';
import { flowTotals, setSpeed } from './model/fans';
import { applyFanFactors, type Geometry } from './model/geometry';
import { createGrid } from './model/grid';
import { History } from './model/history';
import { parseLayout, serialiseLayout } from './model/layout';
import { MOUNTS, SIZE, defaultLayout } from './model/machine';
import { computeMetrics } from './model/metrics';
import { estimateComponents } from './model/thermal';
import { sourceMix } from './model/trace';
import type { Fan, Layout, Vec3 } from './model/types';
import type { VoxeliseRequest } from './model/worker';
import { DT, createSolver, requestDevice, type Solver } from './sim/solver';
import { ComparePanel } from './ui/compare';
import { Panel, type AddKind, type Baseline, type Readings } from './ui/panel';
import { FlowView, type ViewOptions } from './view/flow';
import { SceneView } from './view/scene';

const STORAGE_KEY = 'airflow-layout';
const STEPS_PER_FRAME = 2;
const READ_INTERVAL = 300; // ms
const SNAP_DISTANCE = 0.04; // m
const GRID = createGrid(0.005);

const message = document.getElementById('message')!;
function showMessage(text: string) {
  message.textContent = text;
  message.hidden = !text;
}

function storedLayout(): Layout {
  try {
    const text = localStorage.getItem(STORAGE_KEY);
    if (text) return parseLayout(text);
  } catch {
    showMessage('The stored layout could not be read, so "My PC" has been loaded.');
  }
  return defaultLayout();
}

function remember(layout: Layout) {
  try {
    localStorage.setItem(STORAGE_KEY, serialiseLayout(layout));
  } catch {
    // Storage is a convenience; the app works without it.
  }
}

let layout = storedLayout();
let selected: string | null = null;
let snap = true;
let paused = false;
let borrowed = false; // the comparison is using the solver
let spinRate = 0.01;
let baseline: Baseline | null = null;
let device: GPUDevice | null = null;
let solver: Solver | null = null;
let geometry: Geometry | null = null;
const factors = new Map<string, number>();
const history = new History(serialiseLayout(layout));

const view: ViewOptions = {
  particles: true,
  particleColour: 'temperature',
  streamlines: false,
  slice: false,
  arrows: false,
  sliceAxis: 2,
  slicePosition: 0.4,
  sliceQuantity: 'temperature',
};

const flow = new FlowView(GRID, view);

// Readings are smoothed, then called settled once they stop drifting.
type Values = Omit<Readings, 'settled'>;
let smoothed: Values | null = null;
let recent: Values[] = [];
let simulatedSinceEdit = 0;
let generation = 0;
let reads = 0;
const readings = (): Readings | null => {
  if (!smoothed) return null;
  const steady = (['cpuC', 'gpuC', 'gpu2C', 'exhaustC'] as const).every((key) => {
    const values = recent.map((h) => h[key]);
    return Math.max(...values) - Math.min(...values) < 0.6;
  });
  return { ...smoothed, settled: simulatedSinceEdit > 4 && recent.length >= 10 && steady };
};

const scene = new SceneView(document.getElementById('view')!, GRID, flow.group, {
  select: (id) => choose(id),
  transform: (id, pos, dir, finished) => transform(id, pos, dir, finished),
});

const panel = new Panel(document.getElementById('left')!, document.getElementById('right')!, view, {
  select: (id) => choose(id),
  edit: (change) => {
    change(layout);
    apply();
  },
  setSpeed: (id, rpm) => {
    setSpeed(layout, id, rpm);
    apply();
  },
  add,
  remove: (id) => {
    layout.fans = layout.fans.filter((f) => f.id !== id);
    selected = null;
    apply();
  },
  undo: () => step(() => history.undo()),
  redo: () => step(() => history.redo()),
  setMode: (mode) => scene.setMode(mode),
  setSnap: (on) => {
    snap = on;
    scene.setSnap(on);
  },
  setView: (preset) => scene.setView(preset),
  setSpin: (rate) => (spinRate = rate),
  viewChanged: () => flow.rebuild(),
  togglePause: () => (paused = !paused),
  restartFlow: () => {
    factors.clear();
    solver?.reset(layout.ambientC);
    apply();
  },
  pinBaseline: () => {
    const r = readings();
    if (r) baseline = { ...r, gpu2C: layout.secondGpu ? r.gpu2C : null, balance: flowTotals(layout, factors).balance, scenario: layout.scenario };
  },
  clearBaseline: () => (baseline = null),
  compare: () => comparison.toggle(),
  save: () => {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([serialiseLayout(layout)], { type: 'application/json' }));
    link.download = 'layout.json';
    link.click();
    URL.revokeObjectURL(link.href);
  },
  load: async (file) => {
    try {
      replace(parseLayout(await file.text()));
      showMessage('');
    } catch (error) {
      showMessage(`Could not load ${file.name}: ${error instanceof Error ? error.message : error}`);
    }
  },
  reset: () => replace(defaultLayout()),
});

const comparison = new ComparePanel(document.getElementById('view')!, {
  current: () => layout,
  open: (next) => replace(next),
  borrow: () => {
    if (!device || !solver) return null;
    borrowed = true;
    generation++;
    return {
      device,
      solver,
      release: () => {
        borrowed = false;
        factors.clear();
        solver?.reset(layout.ambientC);
        apply();
      },
    };
  },
});

function replace(next: Layout) {
  const ambientChanged = next.ambientC !== layout.ambientC;
  layout = next;
  selected = null;
  factors.clear();
  panel.invalidate();
  if (ambientChanged && !borrowed) solver?.reset(layout.ambientC);
  apply();
}

// Undo: changes are committed once they stop arriving, so a drag is a single step.
let commitTimer: number | undefined;
function commit() {
  clearTimeout(commitTimer);
  commitTimer = undefined;
  history.commit(serialiseLayout(layout));
}

function step(move: () => string | null) {
  if (commitTimer !== undefined) commit();
  const state = move();
  if (state) replace(parseLayout(state));
}

function choose(id: string | null) {
  selected = id;
  scene.sync(layout, selected);
  panel.refresh(layout, selected);
}

// Voxelising happens in a worker; while it is busy only the newest layout is kept.
const worker = new Worker(new URL('./model/worker.ts', import.meta.url), { type: 'module' });
let sequence = 0;
let working = false;
let stale = false;

function requestGeometry() {
  if (working) {
    stale = true;
    return;
  }
  working = true;
  stale = false;
  const request: VoxeliseRequest = { sequence: ++sequence, layout, grid: GRID };
  worker.postMessage(request);
}

worker.onmessage = ({ data }: MessageEvent<{ geometry: Geometry }>) => {
  working = false;
  geometry = data.geometry;
  if (layout.backPressure) applyFanFactors(geometry, factors);
  else factors.clear();
  if (!borrowed) solver?.setGeometry(geometry, layout.ambientC);
  generation++;
  recent = [];
  simulatedSinceEdit = 0;
  if (stale) requestGeometry();
};
worker.onerror = (e) => showMessage(`Building the geometry failed: ${e.message}`);

/** Push the layout to the screen now and to the solver as soon as the worker is free. */
function apply() {
  scene.sync(layout, selected);
  panel.refresh(layout, selected);
  flow.setLayout(layout);
  remember(layout);
  requestGeometry();
  clearTimeout(commitTimer);
  commitTimer = window.setTimeout(commit, 400);
}

function snapToMount(fan: Fan) {
  if (fan.role !== 'case') return;
  const distance = (p: Vec3) => Math.hypot(...p.map((v, a) => v - fan.pos[a]));
  const mount = MOUNTS.find((m) => distance(m.pos) < SNAP_DISTANCE);
  if (!mount) return;
  const along = mount.inward.reduce((s, v, a) => s + v * fan.dir[a], 0);
  fan.pos = [...mount.pos];
  fan.dir = mount.inward.map((v) => (along < -0.5 ? -v : v) + 0) as Vec3;
}

function transform(id: string, pos: Vec3, dir: Vec3, finished: boolean) {
  const fan = layout.fans.find((f) => f.id === id);
  if (!fan || fan.role === 'cpu') return;
  const half = 0.0125;
  fan.pos = pos.map((v, a) => Math.min(SIZE[a] - half, Math.max(half, v))) as Vec3;
  const length = Math.hypot(...dir) || 1;
  fan.dir = dir.map((v) => v / length) as Vec3;
  if (finished && snap) snapToMount(fan);
  apply();
}

function add(kind: AddKind) {
  let n = 1;
  const prefix = kind === 'cpu' ? 'cpu' : kind === 'gpu' ? 'gpu' : 'case';
  while (layout.fans.some((f) => f.id === `${prefix}-${n}`)) n++;
  const id = `${prefix}-${n}`;
  const centre = SIZE.map((s) => s / 2) as Vec3;
  let fan: Fan;
  if (kind === 'cpu') {
    const used = layout.fans.filter((f) => f.role === 'cpu').map((f) => f.slot);
    const slot = (['outlet', 'inlet', 'middle'] as const).find((s) => !used.includes(s));
    if (!slot) return showMessage('The cooler already has a fan in all three positions.');
    fan = { id, role: 'cpu', model: 'tlc12c', rpm: 1300, pos: [0, 0, 0], dir: [-1, 0, 0], slot, group: 'CPU_FAN' };
  } else if (kind === 'gpu') {
    fan = { id, role: 'gpu', model: 'gpu90', rpm: 1800, pos: [0.115, 0.15, 0.07], dir: [0, 1, 0], group: 'GPU' };
  } else {
    const free = MOUNTS.find((m) => !layout.fans.some((f) => Math.hypot(...m.pos.map((v, a) => v - f.pos[a])) < 0.06));
    fan = {
      id,
      role: 'case',
      model: kind,
      rpm: kind === 'p12' ? 1200 : 1000,
      pos: [...(free?.pos ?? centre)],
      dir: [...(free?.inward ?? ([1, 0, 0] as Vec3))],
    };
  }
  showMessage('');
  layout.fans.push(fan);
  selected = id;
  apply();
}

async function read(active: Solver) {
  const started = generation;
  const fields = await active.read();
  if (started !== generation || !geometry || borrowed) return;
  flow.setFields(fields);
  if (layout.backPressure && simulatedSinceEdit > 0.1) {
    updateFanFactors(geometry, fields.phi, DT, factors);
    applyFanFactors(geometry, factors);
    active.setFixed(geometry);
  }
  panel.refreshFlows(factors);

  const m = computeMetrics(geometry, fields.vel, fields.temp, layout.ambientC);
  const now: Values = { ...estimateComponents(layout, m), exhaustC: m.exhaustTempC, intakeC: m.intakeTempC };
  const blend = (a: number, b: number) => a + 0.25 * (b - a);
  const previous = smoothed;
  smoothed = previous
    ? {
        cpuC: blend(previous.cpuC, now.cpuC),
        gpuC: blend(previous.gpuC, now.gpuC),
        gpu2C: blend(previous.gpu2C, now.gpu2C),
        exhaustC: blend(previous.exhaustC, now.exhaustC),
        intakeC: blend(previous.intakeC, now.intakeC),
      }
    : now;
  recent = [...recent.slice(-9), smoothed];
  panel.showReadings(readings()!, baseline);
  // Tracing is the dearest read-out, so it runs less often.
  if (reads++ % 8 === 4) {
    panel.showSources({
      cpu: sourceMix(geometry, layout, fields.vel, 'cpu'),
      gpu: sourceMix(geometry, layout, fields.vel, 'gpu'),
      gpu2: sourceMix(geometry, layout, fields.vel, 'gpu2'),
    });
  }
}

async function start() {
  scene.setSnap(snap);
  apply();

  try {
    device = await requestDevice();
    solver = await createSolver(device, GRID);
    solver.reset(layout.ambientC);
    if (geometry) solver.setGeometry(geometry, layout.ambientC);
    else requestGeometry();
    device.lost.then((info) => showMessage(`The GPU device was lost (${info.message}). Reload the page.`));
  } catch (error) {
    showMessage(`The simulation cannot run. ${error instanceof Error ? error.message : error}`);
  }

  let stepping = false;
  let reading = false;
  let lastRead = 0;
  let previous = performance.now();
  const frame = (time: number) => {
    const dt = Math.min((time - previous) / 1000, 0.1);
    previous = time;
    if (solver && device && geometry && !paused && !borrowed) {
      // Never queue more work than the GPU has finished.
      if (!stepping) {
        stepping = true;
        solver.step(STEPS_PER_FRAME);
        simulatedSinceEdit += STEPS_PER_FRAME * DT;
        device.queue.onSubmittedWorkDone().then(() => (stepping = false));
      }
      if (!reading && time - lastRead > READ_INTERVAL) {
        reading = true;
        lastRead = time;
        read(solver).finally(() => (reading = false));
      }
      flow.animate(dt);
    }
    if (!paused) scene.spin(dt, layout, factors, spinRate);
    scene.render();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

void start();
