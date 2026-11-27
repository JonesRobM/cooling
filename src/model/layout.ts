import { COOLER_AXES, COOLER_CENTRE, DEFAULT_VENT_LOSS, SLOT_OFFSETS } from './machine';
import type { Cooler, Fan, Layout, Vec3 } from './types';

export function resolveFan(fan: Fan, cooler: Cooler): { pos: Vec3; dir: Vec3 } {
  if (fan.role !== 'cpu') return { pos: fan.pos, dir: fan.dir };
  const axis = COOLER_AXES[cooler.rotation];
  const offset = SLOT_OFFSETS[fan.slot ?? 'middle'];
  const sense = fan.reversed ? -1 : 1;
  return {
    pos: axis.map((a, i) => COOLER_CENTRE[i] + a * offset) as Vec3,
    dir: axis.map((a) => a * sense + 0) as Vec3, // + 0 turns -0 into 0
  };
}

export function serialiseLayout(layout: Layout): string {
  return JSON.stringify(layout, null, 2);
}

function check(condition: unknown, what: string): asserts condition {
  if (!condition) throw new Error(`Invalid layout: ${what}`);
}

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isVec = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every(isNumber);

export function parseLayout(text: string): Layout {
  const l = JSON.parse(text) as Layout;
  check(l?.version === 1, 'unknown version');
  check(Array.isArray(l.fans) && l.fans.length <= 40, 'fan list');
  for (const f of l.fans) {
    check(typeof f.id === 'string', 'fan id');
    check(['case', 'cpu', 'gpu'].includes(f.role), 'fan role');
    check(['f120q', 'p12', 'tlc12c', 'gpu90'].includes(f.model), 'fan model');
    check(isNumber(f.rpm) && f.rpm >= 0 && f.rpm <= 5000, 'fan speed');
    check(isVec(f.pos) && isVec(f.dir) && Math.abs(Math.hypot(...f.dir) - 1) < 0.01, 'fan pose');
    check(f.slot === undefined || Object.hasOwn(SLOT_OFFSETS, f.slot), 'cooler slot');
  }
  check(Object.hasOwn(COOLER_AXES, l.cooler?.rotation), 'cooler rotation');
  check(['idle', 'cpu', 'gpu', 'both'].includes(l.scenario), 'scenario');
  check(isNumber(l.ambientC) && l.ambientC > -20 && l.ambientC < 60, 'ambient temperature');
  for (const key of ['cpuIdle', 'cpuLoad', 'gpuIdle', 'gpuLoad'] as const)
    check(isNumber(l.power?.[key]) && l.power[key] >= 0 && l.power[key] <= 1000, `power ${key}`);
  for (const f of l.fans) check(f.group === undefined || typeof f.group === 'string', 'fan group');
  l.backPressure ??= true;
  check(typeof l.backPressure === 'boolean', 'back-pressure switch');
  l.secondGpu ??= false;
  check(typeof l.secondGpu === 'boolean', 'second GPU switch');
  l.ventLoss ??= DEFAULT_VENT_LOSS;
  check(isNumber(l.ventLoss) && l.ventLoss >= 0 && l.ventLoss <= 50, 'vent loss');
  return l;
}
