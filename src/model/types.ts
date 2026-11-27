export type Vec3 = [number, number, number];
export type Role = 'case' | 'cpu' | 'gpu';
export type Slot = 'inlet' | 'middle' | 'outlet';
export type Rotation = 0 | 90 | 180 | 270;
export type Scenario = 'idle' | 'cpu' | 'gpu' | 'both';
export type FanModelKey = 'f120q' | 'p12' | 'tlc12c' | 'gpu90';

export interface Fan {
  id: string;
  role: Role;
  model: FanModelKey;
  rpm: number;
  /** Centre in metres. Ignored for CPU fans, which follow the cooler. */
  pos: Vec3;
  /** Unit vector the air is pushed along. Ignored for CPU fans. */
  dir: Vec3;
  slot?: Slot;
  reversed?: boolean;
  /** Fans sharing a group (a motherboard header) take speed changes together. */
  group?: string;
}

export interface Cooler {
  rotation: Rotation;
}

export interface Power {
  cpuIdle: number;
  cpuLoad: number;
  gpuIdle: number;
  gpuLoad: number;
}

export interface Layout {
  version: 1;
  fans: Fan[];
  cooler: Cooler;
  scenario: Scenario;
  ambientC: number;
  power: Power;
  /** Loss coefficient K of the vented walls: pressure drop = K · ½ρv². Zero is a bare hole. */
  ventLoss: number;
  /** Whether fans lose flow against resistance, following their pressure curves. */
  backPressure: boolean;
  /** A second, identical graphics card in the lower long slot. */
  secondGpu: boolean;
}

/** The parts that give off heat. */
export type Part = 'cpu' | 'gpu' | 'gpu2';

export const AIR_DENSITY = 1.2; // kg/m³
export const AIR_CP = 1005; // J/(kg·K)
