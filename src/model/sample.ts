// Trilinear sampling of read-back fields at positions in metres.
import { STRIDE } from './geometry';
import type { Grid } from './grid';
import type { Vec3 } from './types';

function trilinear(g: Grid, data: Float32Array, stride: number, comp: number, p: Vec3, staggered: number): number {
  const step1 = g.dims[0];
  const step2 = g.dims[0] * g.dims[1];
  let c = 0;
  let fx = 0;
  let fy = 0;
  let fz = 0;
  for (let a = 0; a < 3; a++) {
    const count = g.cells[a] + (a === staggered ? 1 : 0);
    const q = Math.min(Math.max(p[a] / g.h + g.origin[a] - (a === staggered ? 0 : 0.5), 0), count - 1);
    const base = Math.min(Math.floor(q), count - 2);
    if (a === 0) {
      fx = q - base;
      c += base;
    } else if (a === 1) {
      fy = q - base;
      c += base * step1;
    } else {
      fz = q - base;
      c += base * step2;
    }
  }
  const at = (offset: number) => data[(c + offset) * stride + comp];
  const x0 = at(0) + (at(1) - at(0)) * fx;
  const x1 = at(step1) + (at(step1 + 1) - at(step1)) * fx;
  const x2 = at(step2) + (at(step2 + 1) - at(step2)) * fx;
  const x3 = at(step2 + step1) + (at(step2 + step1 + 1) - at(step2 + step1)) * fx;
  const y0 = x0 + (x1 - x0) * fy;
  const y1 = x2 + (x3 - x2) * fy;
  return y0 + (y1 - y0) * fz;
}

/** Velocity (m/s) at a point, written into `out`. */
export function velocityAt(g: Grid, vel: Float32Array, p: Vec3, out: Vec3): Vec3 {
  for (let a = 0; a < 3; a++) out[a] = trilinear(g, vel, STRIDE, a, p, a);
  return out;
}

/** A cell-centred scalar (temperature, pressure) at a point. */
export function scalarAt(g: Grid, data: Float32Array, p: Vec3): number {
  return trilinear(g, data, 1, 0, p, -1);
}
