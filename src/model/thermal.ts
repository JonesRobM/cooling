import type { Layout, Part } from './types';

// Lumped heatsink estimate: T = T_air + P (R_die + k / v^0.8).
// Constants are chosen to give typical figures for coolers of this class; they are not measured.
export interface HeatsinkSpec {
  rDie: number; // K/W
  k: number; // K/W at 1 m/s through the fins
}

export const HEATSINKS: Record<'cpu' | 'gpu', HeatsinkSpec> = {
  cpu: { rDie: 0.12, k: 0.21 },
  gpu: { rDie: 0.08, k: 0.25 },
};

const STILL_AIR = 0.25; // m/s, stands in for natural convection

/** Above this the real part would slow itself down, so the estimate stops meaning anything. */
export const THROTTLE_C: Record<'cpu' | 'gpu', number> = { cpu: 95, gpu: 90 };

/** CPU and GPU estimates from the air each heatsink sees. gpu2C only means something with two cards. */
export function estimateComponents(layout: Layout, air: Record<Part, { airC: number; speed: number }>) {
  const { power, scenario } = layout;
  const loaded = (part: 'cpu' | 'gpu') => scenario === part || scenario === 'both';
  const watts = {
    cpu: loaded('cpu') ? power.cpuLoad : power.cpuIdle,
    gpu: loaded('gpu') ? power.gpuLoad : power.gpuIdle,
  };
  const of = (part: Part) => {
    const kind = part === 'cpu' ? 'cpu' : 'gpu';
    return componentTemperature(HEATSINKS[kind], watts[kind], air[part].airC, air[part].speed);
  };
  return { cpuC: of('cpu'), gpuC: of('gpu'), gpu2C: of('gpu2') };
}

export function componentTemperature(spec: HeatsinkSpec, watts: number, airC: number, speed: number): number {
  return airC + watts * (spec.rDie + spec.k / Math.max(speed, STILL_AIR) ** 0.8);
}
