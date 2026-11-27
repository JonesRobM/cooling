// A uniform grid covering the case and a region of air around it. Plain data, so it can
// cross to a worker. Positions are in metres with the origin at the case's inner corner.
import { SIZE } from './machine';
import type { Vec3 } from './types';

export interface Grid {
  h: number;
  /** Cells inside the case. */
  inner: Vec3;
  /** Cells of surrounding air below the case's low corner along each axis. */
  origin: Vec3;
  /** Cells in the whole domain. */
  cells: Vec3;
  /** Array size: cells + 1 along each axis, for the high faces. */
  dims: Vec3;
  count: number;
}

// Air around the case, m: [low side, high side]. The low side of y is the gap to the desk,
// and nothing lies beyond the tray side (the PSU chamber).
const MARGIN: [number, number][] = [
  [0.08, 0.08],
  [0.025, 0.1],
  [0, 0.05],
];

export function createGrid(h: number): Grid {
  const inner = SIZE.map((s) => Math.round(s / h)) as Vec3;
  const origin = MARGIN.map(([low]) => Math.round(low / h)) as Vec3;
  const cells = inner.map((n, a) => n + origin[a] + Math.round(MARGIN[a][1] / h)) as Vec3;
  const dims = cells.map((n) => n + 1) as Vec3;
  return { h, inner, origin, cells, dims, count: dims[0] * dims[1] * dims[2] };
}

export const index = (g: Grid, i: number, j: number, k: number) => i + g.dims[0] * (j + g.dims[1] * k);

/** Domain bounds in metres. */
export const lowerBound = (g: Grid): Vec3 => g.origin.map((o) => -o * g.h + 0) as Vec3;
export const upperBound = (g: Grid): Vec3 => g.cells.map((n, a) => (n - g.origin[a]) * g.h) as Vec3;

/** Grid index of the case wall plane on the low (side 0) or high (side 1) end of an axis. */
export const wallPlane = (g: Grid, axis: number, side: 0 | 1) => g.origin[axis] + side * g.inner[axis];
