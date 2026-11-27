// Finds each fan's operating point from the pressure the flow puts across it.
import type { FanFaces, Geometry } from './geometry';
import { scalarAt } from './sample';
import { AIR_DENSITY } from './types';

const RELAXATION = 0.25;
const MOST = 1.2; // a fan helped by others can exceed its free-air flow, but not by much

/**
 * Fraction of free-air flow from the curve Δp = P_max (1 − x²).
 * `external` is the pressure rise the surroundings demand, Pa; `mesh` is the extra loss
 * through a mesh at the free-air speed, which itself scales as x².
 */
export function operatingFraction(maxPressure: number, external: number, mesh: number): number {
  const squared = (maxPressure - external) / (maxPressure + mesh);
  return Math.min(MOST, Math.sqrt(Math.max(0, squared)));
}

/** Move each fan's factor towards its operating point. `phi` is p·dt/(ρh) from the solver. */
export function updateFanFactors(
  geometry: Geometry,
  phi: Float32Array,
  dt: number,
  factors: Map<string, number>,
): void {
  const toPascals = (AIR_DENSITY * geometry.grid.h) / dt;
  const mean = (points: FanFaces['upstream']) =>
    (points.reduce((s, p) => s + scalarAt(geometry.grid, phi, p), 0) / points.length) * toPascals;
  for (const fan of geometry.fans) {
    if (fan.maxPressure === null) continue;
    const current = factors.get(fan.id) ?? 1;
    const speed = fan.freeSpeed * current;
    // Static pressure downstream against total pressure upstream, as fan curves are quoted.
    const external = mean(fan.downstream) - (mean(fan.upstream) + 0.5 * AIR_DENSITY * speed ** 2);
    const mesh = fan.atMesh ? geometry.ventLoss * 0.5 * AIR_DENSITY * fan.freeSpeed ** 2 : 0;
    const target = operatingFraction(fan.maxPressure, external, mesh);
    factors.set(fan.id, current + RELAXATION * (target - current));
  }
}
