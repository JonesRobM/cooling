// "Which air feeds this heatsink?" Parcels are followed backwards from the fins, with a
// random walk for turbulent mixing, until they leave the case.
import { FAN_MODELS, fanDuty } from './fans';
import { SOLID, type Geometry } from './geometry';
import { index } from './grid';
import { resolveFan } from './layout';
import { SIZE } from './machine';
import { velocityAt } from './sample';
import type { Layout, Part, Vec3 } from './types';

const PARCELS = 300;
const MAX_STEPS = 1500;
const DIFFUSIVITY = 3e-4; // m²/s, as in the solver
const WALLS = [
  ['rear vents', 'front mesh'],
  ['bottom mesh', 'top mesh'],
  ['tray side', 'glass side'],
];

export interface Source {
  label: string;
  fraction: number;
}

/** Small seeded generator, so that the figures do not flicker between identical fields. */
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sourceMix(geometry: Geometry, layout: Layout, vel: Float32Array, part: Part): Source[] {
  const g = geometry.grid;
  const cells = geometry.regions[part];
  if (!cells.length) return [];
  const rand = random(1);
  const intakes = layout.fans.flatMap((fan, i) => {
    if (fanDuty(layout, i) !== 'intake' || fan.rpm <= 0) return [];
    return [{ ...resolveFan(fan, layout.cooler), radius: FAN_MODELS[fan.model].diameter / 2, label: fan.group || fan.id }];
  });
  const centreOf = (c: number): Vec3 => {
    const i = c % g.dims[0];
    const j = Math.floor(c / g.dims[0]) % g.dims[1];
    const k = Math.floor(c / (g.dims[0] * g.dims[1]));
    return [i, j, k].map((v, a) => (v - g.origin[a] + 0.5) * g.h) as Vec3;
  };
  const solidAt = (p: Vec3) => {
    const [i, j, k] = p.map((v, a) => Math.floor(v / g.h) + g.origin[a]);
    return (geometry.flags[index(g, i, j, k)] & SOLID) !== 0;
  };

  const counts = new Map<string, number>();
  const v: Vec3 = [0, 0, 0];
  const stepLength = g.h * 0.8;
  for (let n = 0; n < PARCELS; n++) {
    let p = centreOf(cells[Math.floor(rand() * cells.length)]);
    let label = 'still circulating inside';
    for (let s = 0; s < MAX_STEPS; s++) {
      velocityAt(g, vel, p, v);
      const speed = Math.hypot(...v);
      const dt = stepLength / Math.max(speed, 0.2);
      const spread = Math.sqrt(6 * DIFFUSIVITY * dt); // uniform step with the right variance
      const next = p.map((x, a) => x - v[a] * dt + (rand() - 0.5) * spread * Math.SQRT2) as Vec3;
      const wall = next.findIndex((x, a) => x < 0 || x > SIZE[a]);
      if (wall >= 0) {
        const side = next[wall] < 0 ? 0 : 1;
        if (wall === 2) continue; // tray and glass are solid
        const fan = intakes.find(
          (f) =>
            Math.abs(f.pos[wall] - side * SIZE[wall]) < 0.04 &&
            Math.hypot(...f.pos.map((c, a) => (a === wall ? 0 : next[a] - c))) < f.radius + 0.01,
        );
        label = fan ? `${fan.label} intake` : WALLS[wall][side];
        break;
      }
      if (!solidAt(next)) p = next;
    }
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].map(([label, c]) => ({ label, fraction: c / PARCELS })).sort((a, b) => b.fraction - a.fraction);
}
