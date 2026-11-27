// Keeps named layouts and runs them all under the same conditions.
import { CFM } from '../model/fans';
import { createGrid } from '../model/grid';
import { parseLayout, serialiseLayout } from '../model/layout';
import { THROTTLE_C } from '../model/thermal';
import type { Layout } from '../model/types';
import { runLayout, type RunResult } from '../sim/run';
import { createSolver, type Solver } from '../sim/solver';
import { el, select } from './dom';

const STORAGE_KEY = 'airflow-saved';

interface Kept {
  name: string;
  layout: Layout;
}

export interface CompareHost {
  current(): Layout;
  open(layout: Layout): void;
  /** Stop the live view and lend out the GPU; the returned function gives it back. */
  borrow(): { device: GPUDevice; solver: Solver; release(): void } | null;
}

function load(): Kept[] {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as { name: string; layout: unknown }[];
    return stored.map((k) => ({ name: String(k.name), layout: parseLayout(JSON.stringify(k.layout)) }));
  } catch {
    return [];
  }
}

export class ComparePanel {
  private kept = load();
  private root: HTMLElement;
  private list = el('div');
  private results = el('div');
  private status = el('div', { className: 'muted' });
  private name = el('input', { type: 'text', placeholder: 'Name for the current layout' });
  private resolution = select([['0.005', '5 mm grid'], ['0.004', '4 mm grid (slower)']], '0.005', () => {});
  private runButton = el('button', { click: () => void this.run() }, 'Run all');
  private cancelled = false;
  private running = false;

  constructor(
    parent: HTMLElement,
    private host: CompareHost,
  ) {
    this.root = el(
      'div',
      { id: 'compare', hidden: true },
      el(
        'div',
        { className: 'row' },
        el('strong', {}, 'Compare layouts'),
        el('button', { click: () => this.toggle(false) }, 'Close'),
      ),
      el(
        'div',
        { className: 'row' },
        this.name,
        el('button', { click: () => this.keep() }, 'Keep current layout'),
      ),
      this.list,
      el(
        'div',
        { className: 'row' },
        this.resolution,
        this.runButton,
        el('button', { click: () => (this.cancelled = true) }, 'Cancel run'),
      ),
      this.status,
      this.results,
      el(
        'p',
        { className: 'muted' },
        'Every layout runs under the load, room temperature, mesh loss and back-pressure setting of the current one, ' +
          'so only fans and cooler differ. Grid checks suggest treating CPU differences under about 2 K, ' +
          'and GPU differences under about 3 K, as no difference.',
      ),
    );
    parent.append(this.root);
    this.refresh();
  }

  toggle(show = this.root.hidden) {
    if (!show) this.cancelled = true;
    this.root.hidden = !show;
  }

  private store() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.kept));
    } catch {
      this.status.textContent = 'The browser would not store the list; it will be lost on reload.';
    }
    this.refresh();
  }

  private keep() {
    const name = this.name.value.trim() || `Layout ${this.kept.length + 1}`;
    const layout = parseLayout(serialiseLayout(this.host.current()));
    this.kept = [...this.kept.filter((k) => k.name !== name), { name, layout }];
    this.name.value = '';
    this.store();
  }

  private refresh() {
    this.list.replaceChildren(
      ...(this.kept.length
        ? this.kept.map((k) =>
            el(
              'div',
              { className: 'row' },
              el('span', { className: 'grow' }, k.name),
              el('button', { click: () => this.host.open(parseLayout(serialiseLayout(k.layout))) }, 'Open'),
              el(
                'button',
                {
                  click: () => {
                    this.kept = this.kept.filter((x) => x !== k);
                    this.store();
                  },
                },
                'Remove',
              ),
            ),
          )
        : [el('p', { className: 'muted' }, 'Nothing kept yet. Keep a layout, change the fans, then run them against each other.')]),
    );
  }

  private async run() {
    if (this.running) return;
    const lent = this.host.borrow();
    if (!lent) {
      this.status.textContent = 'The simulation is not running, so there is nothing to compare with.';
      return;
    }
    this.running = true;
    this.runButton.disabled = true;
    this.cancelled = false;
    const now = this.host.current();
    const { scenario, power, ambientC, ventLoss, backPressure } = now;
    const entries: Kept[] = [{ name: 'Current', layout: now }, ...this.kept];
    const h = Number(this.resolution.value);
    let solver = lent.solver;
    const rows: { name: string; result: RunResult }[] = [];
    try {
      if (h !== solver.grid.h) solver = await createSolver(lent.device, createGrid(h));
      for (const [n, entry] of entries.entries()) {
        const layout = { ...entry.layout, scenario, power, ambientC, ventLoss, backPressure };
        const result = await runLayout(
          solver,
          layout,
          (f) => (this.status.textContent = `${entry.name} (${n + 1} of ${entries.length}): ${(100 * f).toFixed(0)} %`),
          () => this.cancelled,
        );
        if (!result) break;
        rows.push({ name: entry.name, result });
        this.show(rows, h);
      }
      this.status.textContent = this.cancelled ? 'Cancelled.' : 'Done.';
    } catch (error) {
      this.status.textContent = `The run failed: ${error instanceof Error ? error.message : error}`;
    } finally {
      if (solver !== lent.solver) solver.destroy();
      lent.release();
      this.running = false;
      this.runButton.disabled = false;
    }
  }

  private show(rows: { name: string; result: RunResult }[], h: number) {
    const first = rows[0].result;
    const twoCards = rows.some((r) => r.result.secondGpu);
    const cell = (text: string, delta = '') =>
      el('td', {}, text, ...(delta ? [el('span', { className: 'muted' }, ` ${delta}`)] : []));
    const change = (now: number, then: number) => (now === then ? '' : `${now > then ? '+' : ''}${(now - then).toFixed(1)}`);
    const component = (value: number, reference: number, limit: number) =>
      value > limit ? cell(`over ${limit}`) : cell(value.toFixed(1), reference > limit ? '' : change(value, reference));
    this.results.replaceChildren(
      el(
        'table',
        { className: 'readings' },
        el('caption', { className: 'muted' }, `${h * 1000} mm grid; small figures are the change from Current`),
        el(
          'tr',
          {},
          ...['Layout', 'CPU °C', 'GPU °C', ...(twoCards ? ['GPU 2 °C'] : []), 'Air in °C', 'Air out °C', 'Intake CFM', 'Exhaust CFM'].map((t) => el('th', {}, t)),
        ),
        ...rows.map(({ name, result: r }) =>
          el(
            'tr',
            {},
            el('td', {}, name),
            component(r.cpuC, first.cpuC, THROTTLE_C.cpu),
            component(r.gpuC, first.gpuC, THROTTLE_C.gpu),
            ...(twoCards
              ? [
                  r.secondGpu
                    ? component(r.gpu2C, first.secondGpu ? first.gpu2C : r.gpu2C, THROTTLE_C.gpu)
                    : cell('none'),
                ]
              : []),
            cell(r.intakeC.toFixed(1)),
            cell(r.exhaustC.toFixed(1)),
            cell((r.intake / CFM).toFixed(0)),
            cell((r.exhaust / CFM).toFixed(0)),
          ),
        ),
      ),
    );
  }
}
