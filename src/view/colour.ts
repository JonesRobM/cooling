// Colour maps shared by the flow visuals and the legend.
import type { Vec3 } from '../model/types';

const STOPS: Vec3[] = [
  [0.19, 0.36, 0.88],
  [0.1, 0.72, 0.84],
  [0.35, 0.82, 0.42],
  [0.96, 0.8, 0.2],
  [0.9, 0.22, 0.15],
];

export function colourMap(value: number, out: Float32Array, at: number): void {
  const x = Math.min(Math.max(value, 0), 1) * (STOPS.length - 1);
  const i = Math.min(Math.floor(x), STOPS.length - 2);
  for (let c = 0; c < 3; c++) out[at + c] = STOPS[i][c] + (STOPS[i + 1][c] - STOPS[i][c]) * (x - i);
}

export const TEMPERATURE_SPAN = 12; // K above ambient at the top of the colour scale
export const SPEED_SPAN = 3; // m/s at the top of the colour scale

/** Colours for air by where it entered the case. */
export const SOURCE_COLOURS: Record<string, Vec3> = {
  front: [0.29, 0.64, 1],
  bottom: [0.49, 0.86, 0.54],
  top: [1, 0.54, 0.24],
  rear: [0.85, 0.45, 0.95],
  other: [1, 0.88, 0.3],
  surroundings: [0.45, 0.48, 0.53],
};
