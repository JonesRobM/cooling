// Side panels: fan controls on the left, readings and view settings on the right.
import { CFM, FAN_MODELS, fanDuty, fanFlow, flowTotals } from '../model/fans';
import { resolveFan } from '../model/layout';
import { SECOND_GPU_DROP, gpuFans } from '../model/machine';
import { THROTTLE_C } from '../model/thermal';
import type { Source } from '../model/trace';
import type { Fan, Layout, Rotation, Scenario, Slot, Vec3 } from '../model/types';
import { SOURCE_COLOURS, SPEED_SPAN, TEMPERATURE_SPAN } from '../view/colour';
import type { ViewOptions } from '../view/flow';
import type { ViewPreset } from '../view/scene';
import { el, select } from './dom';

export type AddKind = 'f120q' | 'p12' | 'cpu' | 'gpu';

export interface Readings {
  cpuC: number;
  gpuC: number;
  gpu2C: number;
  exhaustC: number;
  intakeC: number;
  settled: boolean;
}

export interface Baseline {
  cpuC: number;
  gpuC: number;
  gpu2C: number | null;
  exhaustC: number;
  intakeC: number;
  balance: number;
  scenario: Scenario;
}

export interface PanelActions {
  select(id: string | null): void;
  /** Mutate the layout and re-run. */
  edit(change: (layout: Layout) => void): void;
  setSpeed(id: string, rpm: number): void;
  add(kind: AddKind): void;
  remove(id: string): void;
  undo(): void;
  redo(): void;
  setMode(mode: 'translate' | 'rotate'): void;
  setSnap(on: boolean): void;
  setView(preset: ViewPreset): void;
  setSpin(rate: number): void;
  viewChanged(): void;
  togglePause(): boolean;
  restartFlow(): void;
  pinBaseline(): void;
  clearBaseline(): void;
  compare(): void;
  save(): void;
  load(file: File): void;
  reset(): void;
}

const DIRECTIONS: [string, Vec3][] = [
  ['towards front', [1, 0, 0]],
  ['towards rear', [-1, 0, 0]],
  ['upwards', [0, 1, 0]],
  ['downwards', [0, -1, 0]],
  ['towards glass', [0, 0, 1]],
  ['towards tray', [0, 0, -1]],
];

const GROUPS = ['front', 'bottom', 'top', 'rear', 'CPU_FAN', 'CPU_OPT', 'AIO_PUMP', 'CHA_FAN1', 'CHA_FAN2', 'CHA_FAN3', 'CHA_FAN4', 'GPU', 'GPU2'];

const cfm = (q: number) => q / CFM;

export class Panel {
  private fanList = el('div', { className: 'fan-list' });
  private fanDetail = el('div');
  private delivery = el('div', { className: 'muted' });
  private totals = el('div', { className: 'muted' });
  private readings = el('table', { className: 'readings' });
  private sources = el('div');
  private status = el('div', { className: 'muted' });
  private baselineNote = el('div', { className: 'muted' });
  private pin = el('button', { disabled: true, click: () => this.actions.pinBaseline() }, 'Pin as baseline');
  private conditions = el('div');
  private rotation!: HTMLSelectElement;
  private detailKey = '';
  private layout!: Layout;
  private selected: string | null = null;
  private factors: ReadonlyMap<string, number> = new Map();

  constructor(
    left: HTMLElement,
    right: HTMLElement,
    private view: ViewOptions,
    private actions: PanelActions,
  ) {
    this.buildLeft(left);
    this.buildRight(right);
  }

  private buildLeft(root: HTMLElement) {
    const addKind = select(
      [
        ['p12', 'Case fan: Arctic P12 Pro LN'],
        ['f120q', 'Case fan: NZXT F120Q'],
        ['cpu', 'CPU cooler fan'],
        ['gpu', 'GPU fan'],
      ],
      'p12',
      () => {},
    );
    const move = el('button', { className: 'active', click: () => mode('translate') }, 'Move (T)');
    const turn = el('button', { click: () => mode('rotate') }, 'Rotate (R)');
    const mode = (m: 'translate' | 'rotate') => {
      move.classList.toggle('active', m === 'translate');
      turn.classList.toggle('active', m === 'rotate');
      this.actions.setMode(m);
    };
    addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement && e.target.type !== 'checkbox' && e.target.type !== 'range') return;
      const key = e.key.toLowerCase();
      if (e.ctrlKey || e.metaKey) {
        if (key === 'z' && !e.shiftKey) this.actions.undo();
        else if (key === 'y' || (key === 'z' && e.shiftKey)) this.actions.redo();
        else return;
        e.preventDefault();
        return;
      }
      if (key === 't') mode('translate');
      if (key === 'r') mode('rotate');
    });
    this.rotation = select(
      [
        ['0', 'towards rear (as built)'],
        ['90', 'upwards'],
        ['180', 'towards front'],
        ['270', 'downwards'],
      ],
      '0',
      (v) => this.actions.edit((l) => (l.cooler.rotation = Number(v) as Rotation)),
    );
    root.append(
      el(
        'div',
        { className: 'row' },
        el('button', { click: () => this.actions.undo(), title: 'Ctrl+Z' }, 'Undo'),
        el('button', { click: () => this.actions.redo(), title: 'Ctrl+Y' }, 'Redo'),
        el('button', { click: () => this.actions.compare() }, 'Compare layouts…'),
      ),
      el('h2', {}, 'Fans'),
      this.fanList,
      el('div', { className: 'row' }, addKind, el('button', { click: () => this.actions.add(addKind.value as AddKind) }, 'Add')),
      this.totals,
      el('h2', {}, 'Selected fan'),
      el('div', { className: 'row' }, move, turn),
      el(
        'label',
        {},
        'Snap to mounts, 90° and 5 mm',
        el('input', {
          type: 'checkbox',
          checked: true,
          change: (e) => this.actions.setSnap((e.target as HTMLInputElement).checked),
        }),
      ),
      this.fanDetail,
      el('h2', {}, 'CPU cooler'),
      el('label', {}, 'Blows', this.rotation),
    );
  }

  private buildRight(root: HTMLElement) {
    const setView = (change: () => void) => {
      change();
      this.actions.viewChanged();
    };
    const toggle = (key: 'particles' | 'streamlines' | 'slice' | 'arrows', text: string) =>
      el(
        'label',
        {},
        text,
        el('input', {
          type: 'checkbox',
          checked: this.view[key],
          change: (e) => setView(() => (this.view[key] = (e.target as HTMLInputElement).checked)),
        }),
      );
    const pause = el('button', { click: () => (pause.textContent = this.actions.togglePause() ? 'Resume' : 'Pause') }, 'Pause');
    const file = el('input', {
      type: 'file',
      accept: '.json,application/json',
      hidden: true,
      change: () => {
        if (file.files?.[0]) this.actions.load(file.files[0]);
        file.value = '';
      },
    });
    const swatch = (name: string, text: string) => {
      const dot = el('span', { className: 'dot' });
      dot.style.background = `rgb(${SOURCE_COLOURS[name].map((c) => Math.round(c * 255)).join(',')})`;
      return el('span', { className: 'swatch' }, dot, text);
    };

    root.append(
      el('h2', {}, 'Estimates'),
      this.readings,
      this.status,
      el('div', { className: 'row' }, this.pin, el('button', { click: () => this.actions.clearBaseline() }, 'Clear')),
      this.baselineNote,
      this.sources,
      el(
        'p',
        { className: 'muted' },
        'Indicative only: nothing is calibrated against your machine. Compare layouts rather than trusting a single figure.',
      ),
      el('h2', {}, 'Conditions'),
      this.conditions,
      el('h2', {}, 'View'),
      el(
        'div',
        { className: 'row' },
        ...(['angle', 'side', 'tray', 'front', 'rear', 'top'] as ViewPreset[]).map((p) =>
          el('button', { click: () => this.actions.setView(p) }, p),
        ),
      ),
      el(
        'label',
        {},
        'Fan rotation',
        select([['0.01', '1/100 speed'], ['0.001', '1/1000 speed'], ['0', 'stopped']], '0.01', (v) =>
          this.actions.setSpin(Number(v)),
        ),
      ),
      toggle('particles', 'Particles (air slowed to 0.15×)'),
      el(
        'label',
        {},
        'Particle colour',
        select([['temperature', 'temperature'], ['source', 'which intake']], this.view.particleColour, (v) =>
          setView(() => (this.view.particleColour = v as ViewOptions['particleColour'])),
        ),
      ),
      el(
        'div',
        { className: 'muted' },
        swatch('front', 'front'),
        swatch('bottom', 'bottom'),
        swatch('top', 'top'),
        swatch('rear', 'rear'),
        swatch('other', 'other opening'),
        swatch('surroundings', 'outside or unknown'),
      ),
      toggle('streamlines', 'Streamlines from intakes'),
      toggle('slice', 'Slice colour map'),
      toggle('arrows', 'Velocity arrows on slice'),
      el(
        'label',
        {},
        'Slice faces',
        select([['2', 'side (glass)'], ['0', 'front'], ['1', 'top']], String(this.view.sliceAxis), (v) =>
          setView(() => (this.view.sliceAxis = Number(v) as 0 | 1 | 2)),
        ),
      ),
      el('input', {
        type: 'range',
        min: '0',
        max: '1',
        step: '0.01',
        value: String(this.view.slicePosition),
        'aria-label': 'Slice position',
        input: (e) => setView(() => (this.view.slicePosition = Number((e.target as HTMLInputElement).value))),
      }),
      el(
        'label',
        {},
        'Slice shows',
        select([['temperature', 'temperature'], ['speed', 'speed']], this.view.sliceQuantity, (v) =>
          setView(() => (this.view.sliceQuantity = v as ViewOptions['sliceQuantity'])),
        ),
      ),
      el('div', { className: 'scale' }),
      el('div', { className: 'scale-labels' }, el('span', {}, 'ambient / still'), el('span', {}, `+${TEMPERATURE_SPAN} K / ${SPEED_SPAN} m/s`)),
      el('h2', {}, 'Simulation and layouts'),
      el('div', { className: 'row' }, pause, el('button', { click: () => this.actions.restartFlow() }, 'Restart flow')),
      el(
        'div',
        { className: 'row' },
        el('button', { click: () => this.actions.save() }, 'Save…'),
        el('button', { click: () => file.click() }, 'Load…'),
        el('button', { click: () => this.actions.reset() }, 'Reset to My PC'),
        file,
      ),
    );
  }

  /** Forget the built fan controls, after the layout has been replaced wholesale. */
  invalidate() {
    this.detailKey = '-';
    (document.activeElement as HTMLElement | null)?.blur();
  }

  /** Refresh everything that depends on the layout. */
  refresh(layout: Layout, selected: string | null) {
    this.layout = layout;
    this.selected = selected;
    this.rotation.value = String(layout.cooler.rotation);
    this.refreshList();
    this.refreshDetail();
    this.refreshConditions();
    this.refreshFlows(this.factors);
  }

  /** Update the delivered flows as the fans find their operating points. */
  refreshFlows(factors: ReadonlyMap<string, number>) {
    this.factors = factors;
    const t = flowTotals(this.layout, factors);
    this.totals.textContent =
      `Delivered by case fans: intake ${cfm(t.intake).toFixed(0)} CFM, exhaust ${cfm(t.exhaust).toFixed(0)} CFM: ` +
      `${Math.abs(cfm(t.balance)) < 1 ? 'neutral' : t.balance > 0 ? 'positive' : 'negative'} pressure ` +
      `(${t.balance >= 0 ? '+' : ''}${cfm(t.balance).toFixed(0)} CFM)`;
    const fan = this.layout.fans.find((f) => f.id === this.selected);
    if (!fan) return;
    const free = fanFlow(FAN_MODELS[fan.model], fan.rpm);
    const factor = factors.get(fan.id) ?? 1;
    const q = free * factor;
    this.delivery.textContent =
      `Delivers ${cfm(q).toFixed(1)} CFM · ${(q * 3600).toFixed(0)} m³/h ` +
      `(${(100 * factor).toFixed(0)} % of free-air ${cfm(free).toFixed(1)} CFM)`;
  }

  private refreshList() {
    const layout = this.layout;
    this.fanList.replaceChildren(
      ...layout.fans.map((fan, i) => {
        const duty = fanDuty(layout, i);
        return el(
          'button',
          { className: fan.id === this.selected ? 'active' : '', click: () => this.actions.select(fan.id) },
          el('span', {}, fan.id),
          el('span', { className: 'muted' }, `${duty === 'internal' ? '' : `${duty} · `}${fan.rpm > 0 ? `${fan.rpm} RPM` : 'off'}`),
        );
      }),
    );
  }

  private refreshDetail() {
    const layout = this.layout;
    const fan = layout.fans.find((f) => f.id === this.selected);
    // Speed is left out of the key: only the slider changes it, and it must survive a drag.
    const key = fan ? `${fan.id}|${fan.slot}|${fan.group}|${resolveFan(fan, layout.cooler).dir}` : '';
    if (key === this.detailKey) return;
    this.detailKey = key;
    if (!fan) {
      this.fanDetail.replaceChildren(el('p', { className: 'muted' }, 'Click a fan in the view or in the list.'));
      return;
    }
    const model = FAN_MODELS[fan.model];
    const id = fan.id;
    const change = (apply: (f: Fan) => void) =>
      this.actions.edit((l) => {
        const target = l.fans.find((f) => f.id === id);
        if (target) apply(target);
      });
    const mates = fan.group ? layout.fans.filter((f) => f.group === fan.group).length : 1;
    const rpmLabel = el('span', {}, `${fan.rpm} RPM`);
    const slider = el('input', {
      type: 'range',
      min: '0',
      max: String(model.ratedRpm),
      step: '10',
      value: String(fan.rpm),
      'aria-label': 'Fan speed',
      input: () => {
        let rpm = Number(slider.value);
        if (rpm > 0 && rpm < model.minRpm) rpm = model.minRpm;
        rpmLabel.textContent = `${rpm} RPM`;
        this.actions.setSpeed(id, rpm);
      },
      change: () => slider.blur(), // so that T and R work again
    });

    const dir = resolveFan(fan, layout.cooler).dir;
    const flip = el(
      'button',
      {
        click: () =>
          change((f) => {
            if (f.role === 'cpu') f.reversed = !f.reversed;
            else f.dir = f.dir.map((v) => -v + 0) as Vec3;
          }),
      },
      'Flip',
    );

    let orientation: Node;
    if (fan.role === 'cpu') {
      orientation = el(
        'label',
        {},
        'Position on cooler',
        select(
          [['inlet', 'inlet (push)'], ['middle', 'middle'], ['outlet', 'outlet (pull)']],
          fan.slot ?? 'middle',
          (v) => change((f) => (f.slot = v as Slot)),
        ),
      );
    } else {
      const current = DIRECTIONS.findIndex(([, d]) => d.every((v, i) => Math.abs(v - dir[i]) < 0.01));
      const options: [string, string][] = DIRECTIONS.map(([name], i) => [String(i), name]);
      if (current < 0) options.push(['-1', 'tilted']);
      orientation = el(
        'label',
        {},
        'Blows',
        select(options, String(current), (v) => {
          if (v !== '-1') change((f) => (f.dir = [...DIRECTIONS[Number(v)][1]]));
        }),
      );
    }

    const groups = fan.group && !GROUPS.includes(fan.group) ? [fan.group, ...GROUPS] : GROUPS;
    this.fanDetail.replaceChildren(
      el('div', {}, `${fan.id}: ${model.name}`),
      el('label', {}, mates > 1 ? `Speed (moves ${mates} fans)` : 'Speed', rpmLabel),
      slider,
      this.delivery,
      el(
        'label',
        {},
        'Speed group',
        select([['', 'on its own'], ...groups.map((g): [string, string] => [g, g])], fan.group ?? '', (v) =>
          change((f) => {
            if (v) f.group = v;
            else delete f.group;
          }),
        ),
      ),
      orientation,
      el('div', { className: 'row' }, flip, el('button', { click: () => this.actions.remove(id) }, 'Delete')),
    );
  }

  private refreshConditions() {
    if (this.conditions.contains(document.activeElement)) return;
    const layout = this.layout;
    const number = (text: string, value: number, apply: (l: Layout, v: number) => void, lo: number, hi: number) =>
      el(
        'label',
        {},
        text,
        el('input', {
          type: 'number',
          value: String(value),
          min: String(lo),
          max: String(hi),
          change: (e) => {
            const input = e.target as HTMLInputElement;
            const v = Math.min(hi, Math.max(lo, Number(input.value) || 0));
            input.value = String(v);
            input.blur();
            this.actions.edit((l) => apply(l, v));
          },
        }),
      );
    this.conditions.replaceChildren(
      el(
        'label',
        {},
        'Load',
        select(
          [['idle', 'idle'], ['cpu', 'CPU flat out'], ['gpu', 'GPU busy'], ['both', 'CPU and GPU']],
          layout.scenario,
          (v) => this.actions.edit((l) => (l.scenario = v as Scenario)),
        ),
      ),
      number('CPU idle, W', layout.power.cpuIdle, (l, v) => (l.power.cpuIdle = v), 0, 1000),
      number('CPU loaded, W', layout.power.cpuLoad, (l, v) => (l.power.cpuLoad = v), 0, 1000),
      number('GPU idle, W', layout.power.gpuIdle, (l, v) => (l.power.gpuIdle = v), 0, 1000),
      number('GPU loaded, W', layout.power.gpuLoad, (l, v) => (l.power.gpuLoad = v), 0, 1000),
      number('Room, °C', layout.ambientC, (l, v) => (l.ambientC = v), 0, 45),
      el(
        'label',
        {},
        'Second GPU below the first',
        el('input', {
          type: 'checkbox',
          checked: layout.secondGpu,
          change: (e) => {
            const input = e.target as HTMLInputElement;
            input.blur();
            this.actions.edit((l) => {
              l.secondGpu = input.checked;
              l.fans = l.fans.filter((f) => f.group !== 'GPU2');
              if (l.secondGpu) l.fans.push(...gpuFans(3, SECOND_GPU_DROP, 'GPU2'));
            });
          },
        }),
      ),
      number('Mesh loss K (0 = open)', layout.ventLoss, (l, v) => (l.ventLoss = v), 0, 50),
      el(
        'label',
        {},
        'Fans lose flow to resistance',
        el('input', {
          type: 'checkbox',
          checked: layout.backPressure,
          change: (e) => {
            const input = e.target as HTMLInputElement;
            input.blur();
            this.actions.edit((l) => (l.backPressure = input.checked));
          },
        }),
      ),
    );
  }

  showSources(mixes: { cpu: Source[]; gpu: Source[]; gpu2: Source[] } | null) {
    if (!mixes) {
      this.sources.replaceChildren();
      return;
    }
    const line = (name: string, mix: Source[]) =>
      el(
        'div',
        { className: 'muted' },
        el('strong', {}, `${name} air comes from: `),
        mix
          .filter((s) => s.fraction >= 0.03)
          .map((s) => `${s.label} ${(100 * s.fraction).toFixed(0)} %`)
          .join(', '),
      );
    this.sources.replaceChildren(
      line('CPU', mixes.cpu),
      line('GPU', mixes.gpu),
      ...(mixes.gpu2.length ? [line('GPU 2', mixes.gpu2)] : []),
    );
  }

  showReadings(r: Readings, baseline: Baseline | null) {
    const layout = this.layout;
    const balance = flowTotals(layout, this.factors).balance;
    const row = (text: string, value: string, delta: string) =>
      el('tr', {}, el('td', {}, text), el('td', {}, value), el('td', { className: 'muted' }, delta));
    const diff = (now: number, then: number | undefined, digits: number, unit: string) =>
      then === undefined ? '' : `${now - then >= 0 ? '+' : ''}${(now - then).toFixed(digits)} ${unit}`;
    const component = (name: string, part: 'cpu' | 'gpu', now: number, then: number | undefined) => {
      const limit = THROTTLE_C[part];
      if (now > limit) return row(name, `over ${limit} °C: would throttle`, '');
      return row(name, `${now.toFixed(0)} °C`, then !== undefined && then > limit ? '' : diff(now, then, 1, 'K'));
    };
    this.readings.replaceChildren(
      component('CPU', 'cpu', r.cpuC, baseline?.cpuC),
      component('GPU', 'gpu', r.gpuC, baseline?.gpuC),
      ...(layout.secondGpu ? [component('GPU 2', 'gpu', r.gpu2C, baseline?.gpu2C ?? undefined)] : []),
      row('Air entering case', `${r.intakeC.toFixed(1)} °C`, diff(r.intakeC, baseline?.intakeC, 1, 'K')),
      row('Air leaving case', `${r.exhaustC.toFixed(1)} °C`, diff(r.exhaustC, baseline?.exhaustC, 1, 'K')),
      row('Pressure balance', `${cfm(balance).toFixed(0)} CFM`, diff(cfm(balance), baseline ? cfm(baseline.balance) : undefined, 0, '')),
    );
    this.status.textContent = r.settled ? 'Settled' : 'Settling…';
    this.pin.disabled = !r.settled;
    this.baselineNote.textContent = !baseline
      ? ''
      : baseline.scenario === layout.scenario
        ? 'Third column: change from the baseline.'
        : `Baseline was pinned under a different load (${baseline.scenario}), so the differences are not like for like.`;
  }
}
