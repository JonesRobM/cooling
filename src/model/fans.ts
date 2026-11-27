import type { FanModelKey, Layout } from './types';
import { resolveFan } from './layout';
import { SIZE } from './machine';

export const CFM = 0.000471947; // m³/s

export interface FanModel {
  name: string;
  /** Swept diameter, m. */
  diameter: number;
  thickness: number;
  ratedRpm: number;
  ratedCfm: number;
  minRpm: number;
  /** Stall pressure at rated speed, Pa. Null: no curve, the rated flow is what gets delivered. */
  maxPressure: number | null;
}

const MM_H2O = 9.81; // Pa

export const FAN_MODELS: Record<FanModelKey, FanModel> = {
  // Pressure from a Cybenetics test of the case version; NZXT's retail F120Q differs.
  f120q: { name: 'NZXT F120Q', diameter: 0.115, thickness: 0.025, ratedRpm: 1350, ratedCfm: 60.2, minRpm: 0, maxPressure: 0.77 * MM_H2O },
  p12: { name: 'Arctic P12 Pro LN', diameter: 0.115, thickness: 0.025, ratedRpm: 2000, ratedCfm: 49, minRpm: 450, maxPressure: 3.5 * MM_H2O },
  tlc12c: { name: 'Thermalright TL-C12C', diameter: 0.115, thickness: 0.025, ratedRpm: 1550, ratedCfm: 66.2, minRpm: 0, maxPressure: 1.53 * MM_H2O },
  // The flow is a guess at what gets through the card's own heatsink. No pressure data exists,
  // and a guessed curve would decide the GPU temperature by itself, so there is none.
  gpu90: { name: 'GPU 90 mm (estimated)', diameter: 0.09, thickness: 0.013, ratedRpm: 3000, ratedCfm: 35, minRpm: 0, maxPressure: null },
};

/** Set a fan's speed. Fans in the same group share its duty cycle. */
export function setSpeed(layout: Layout, id: string, rpm: number): void {
  const source = layout.fans.find((f) => f.id === id);
  if (!source) return;
  const duty = rpm / FAN_MODELS[source.model].ratedRpm;
  for (const fan of layout.fans) {
    if (fan !== source && (!source.group || fan.group !== source.group)) continue;
    const model = FAN_MODELS[fan.model];
    const own = fan === source ? rpm : Math.round((duty * model.ratedRpm) / 10) * 10;
    fan.rpm = own > 0 ? Math.min(model.ratedRpm, Math.max(model.minRpm, own)) : 0;
  }
}

/** First fan affinity law: flow is proportional to speed. Returns m³/s. */
export function fanFlow(model: FanModel, rpm: number): number {
  return (model.ratedCfm * CFM * rpm) / model.ratedRpm;
}

export type FanDuty = 'intake' | 'exhaust' | 'internal';

/** A case fan against a wall is an intake if it blows inwards, an exhaust if outwards. */
export function fanDuty(layout: Layout, index: number): FanDuty {
  const fan = layout.fans[index];
  if (fan.role !== 'case') return 'internal';
  const { pos, dir } = resolveFan(fan, layout.cooler);
  // Tray and glass (z) have no openings, so only x and y walls count.
  for (const axis of [0, 1]) {
    for (const [wall, inward] of [[0, 1], [SIZE[axis], -1]]) {
      const along = dir[axis] * inward;
      if (Math.abs(pos[axis] - wall) < 0.04 && Math.abs(along) > 0.5) return along > 0 ? 'intake' : 'exhaust';
    }
  }
  return 'internal';
}

/** Case fan flows; `factors` is the fraction of free-air flow each fan is delivering. */
export function flowTotals(
  layout: Layout,
  factors?: ReadonlyMap<string, number>,
): { intake: number; exhaust: number; balance: number } {
  let intake = 0;
  let exhaust = 0;
  layout.fans.forEach((fan, i) => {
    const q = fanFlow(FAN_MODELS[fan.model], fan.rpm) * (factors?.get(fan.id) ?? 1);
    const duty = fanDuty(layout, i);
    if (duty === 'intake') intake += q;
    if (duty === 'exhaust') exhaust += q;
  });
  return { intake, exhaust, balance: intake - exhaust };
}
