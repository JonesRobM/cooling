import { SOLID, STRIDE, type Geometry } from './geometry';
import { index, wallPlane } from './grid';
import { AIR_CP, AIR_DENSITY, type Vec3 } from './types';

export interface Region {
  airC: number;
  speed: number;
}

export interface Metrics {
  /** Net volume flux out through the case walls, m³/s. Zero for a converged solution. */
  netFlux: number;
  outflow: number;
  /** Net heat carried out of the case, W. */
  heatOut: number;
  /** Flux-weighted temperatures of the air leaving and entering the case. */
  exhaustTempC: number;
  intakeTempC: number;
  cpu: Region;
  gpu: Region;
  gpu2: Region;
}

export function cellSpeed(geometry: Geometry, vel: Float32Array, c: number): number {
  const { dims } = geometry.grid;
  const step = [1, dims[0], dims[0] * dims[1]];
  let sq = 0;
  for (let a = 0; a < 3; a++) sq += (0.5 * (vel[c * STRIDE + a] + vel[(c + step[a]) * STRIDE + a])) ** 2;
  return Math.sqrt(sq);
}

export function computeMetrics(
  geometry: Geometry,
  vel: Float32Array,
  temp: Float32Array,
  ambientC: number,
): Metrics {
  const g = geometry.grid;
  const area = g.h * g.h;
  let netFlux = 0;
  let outflow = 0;
  let inflow = 0;
  let leaving = 0; // Σ q ΔT, outward
  let entering = 0;
  for (let a = 0; a < 3; a++) {
    const [b, d] = [0, 1, 2].filter((x) => x !== a);
    for (const side of [0, 1] as const) {
      const face = wallPlane(g, a, side);
      const sign = side ? 1 : -1;
      // Cells either side of the wall. The tray plane has nothing beyond it.
      const inside = side ? face - 1 : face;
      const beyond = side ? face : face - 1;
      for (let s = 0; s < g.inner[b]; s++)
        for (let t = 0; t < g.inner[d]; t++) {
          const p: Vec3 = [0, 0, 0];
          p[b] = g.origin[b] + s;
          p[d] = g.origin[d] + t;
          p[a] = face;
          const q = vel[index(g, ...p) * STRIDE + a] * sign * area;
          if (q === 0) continue;
          netFlux += q;
          p[a] = q > 0 ? inside : beyond;
          const excess = p[a] >= 0 && p[a] < g.cells[a] ? temp[index(g, ...p)] - ambientC : 0;
          if (q > 0) {
            outflow += q;
            leaving += q * excess;
          } else {
            inflow -= q;
            entering -= q * excess;
          }
        }
    }
  }
  const region = (cells: number[]): Region => {
    let airC = 0;
    let speed = 0;
    let n = 0;
    for (const c of cells) {
      if (geometry.flags[c] & SOLID) continue;
      airC += temp[c];
      speed += cellSpeed(geometry, vel, c);
      n++;
    }
    return n ? { airC: airC / n, speed: speed / n } : { airC: ambientC, speed: 0 };
  };
  return {
    netFlux,
    outflow,
    heatOut: AIR_DENSITY * AIR_CP * (leaving - entering),
    exhaustTempC: outflow > 1e-6 ? ambientC + leaving / outflow : ambientC,
    intakeTempC: inflow > 1e-6 ? ambientC + entering / inflow : ambientC,
    cpu: region(geometry.regions.cpu),
    gpu: region(geometry.regions.gpu),
    gpu2: region(geometry.regions.gpu2),
  };
}
