// Geometry of the modelled PC. x: rear to front, y: bottom to top, z: tray to glass. Metres.
// Interior dimensions and component positions are estimates.
import type { Fan, Layout, Part, Rotation, Vec3 } from './types';

export const SIZE: Vec3 = [0.44, 0.46, 0.19];

export interface Box {
  min: Vec3;
  max: Vec3;
}

export const SOLIDS: { name: string; box: Box }[] = [
  { name: 'Motherboard', box: { min: [0.005, 0.09, 0], max: [0.25, 0.395, 0.01] } },
  { name: 'CPU block', box: { min: [0.125, 0.305, 0.01], max: [0.165, 0.345, 0.035] } },
  { name: 'RAM', box: { min: [0.24, 0.265, 0.01], max: [0.25, 0.4, 0.055] } },
  { name: 'RAM', box: { min: [0.26, 0.265, 0.01], max: [0.27, 0.4, 0.055] } },
];

/** Three expansion slots. Assumed: check where the board's second long slot really is. */
export const SECOND_GPU_DROP = 3 * 0.02032;

const GPU_BACKPLATE: Box = { min: [0.005, 0.2, 0.01], max: [0.225, 0.205, 0.13] };
const GPU_FINS: Box = { min: [0.01, 0.18, 0.015], max: [0.22, 0.2, 0.13] };

const lowered = (box: Box, by: number): Box => ({
  min: [box.min[0], box.min[1] - by, box.min[2]],
  max: [box.max[0], box.max[1] - by, box.max[2]],
});

/** The solid parts that come with the graphics cards. */
export function gpuSolids(secondGpu: boolean): { name: string; box: Box }[] {
  const first = { name: 'GPU backplate', box: GPU_BACKPLATE };
  return secondGpu ? [first, { name: 'GPU 2 backplate', box: lowered(GPU_BACKPLATE, SECOND_GPU_DROP) }] : [first];
}

/** A graphics card's own two fans, numbered from `first` and `drop` metres below the top card. */
export function gpuFans(first: number, drop: number, group: string): Fan[] {
  return [0.06, 0.165].map((x, i) => ({
    id: `gpu-${first + i}`,
    role: 'gpu',
    model: 'gpu90',
    rpm: 1800,
    pos: [x, 0.1725 - drop, 0.07],
    dir: [0, 1, 0],
    group,
  }));
}

export const COOLER_CENTRE: Vec3 = [0.145, 0.325, 0.095];
export const COOLER_AXES: Record<Rotation, Vec3> = {
  0: [-1, 0, 0],
  90: [0, 1, 0],
  180: [1, 0, 0],
  270: [0, -1, 0],
};
export const SLOT_OFFSETS = { inlet: -0.072, middle: 0, outlet: 0.072 };

/** Drag rates in 1/s: low along the fins, high across them. */
export const DRAG_OPEN = 30;
export const DRAG_BLOCKED = 2000;

export interface Heatsink {
  part: Part;
  box: Box;
  drag: Vec3;
}

export function heatsinks(rotation: Rotation, secondGpu: boolean): Heatsink[] {
  const alongX = COOLER_AXES[rotation][0] !== 0;
  const towers: Heatsink[] = [-1, 1].map((side) => {
    const centre = [...COOLER_CENTRE] as Vec3;
    centre[alongX ? 0 : 1] += side * 0.037;
    const half: Vec3 = alongX ? [0.0225, 0.06, 0] : [0.06, 0.0225, 0];
    return {
      part: 'cpu',
      box: {
        min: [centre[0] - half[0], centre[1] - half[1], 0.035],
        max: [centre[0] + half[0], centre[1] + half[1], 0.155],
      },
      drag: [DRAG_OPEN, DRAG_OPEN, DRAG_BLOCKED],
    };
  });
  const card = (part: Part, drop: number): Heatsink => ({
    part,
    box: lowered(GPU_FINS, drop),
    drag: [DRAG_BLOCKED, DRAG_OPEN, DRAG_OPEN],
  });
  return [...towers, card('gpu', 0), ...(secondGpu ? [card('gpu2', SECOND_GPU_DROP)] : [])];
}

export interface Mount {
  pos: Vec3;
  /** Axis pointing into the case. */
  inward: Vec3;
}

const front = [0.085, 0.215, 0.345].map((y): Mount => ({ pos: [0.4275, y, 0.095], inward: [-1, 0, 0] }));
const top = [0.08, 0.205, 0.33].map((x): Mount => ({ pos: [x, 0.4475, 0.095], inward: [0, -1, 0] }));
const bottom = [0.09, 0.215, 0.34].map((x): Mount => ({ pos: [x, 0.0125, 0.095], inward: [0, 1, 0] }));
const rear: Mount = { pos: [0.0125, 0.325, 0.095], inward: [1, 0, 0] };

export const MOUNTS: Mount[] = [...front, ...top, ...bottom, rear];

/** Vented areas of the rear wall. Front, top and bottom are open all over. */
export const REAR_VENTS: Box[] = [
  { min: [0, 0.26, 0.035], max: [0, 0.39, 0.155] },
  { min: [0, 0.05, 0.01], max: [0, 0.22, 0.13] },
];

/**
 * Roughly a thin perforated plate with half its area open (Idelchik, Handbook of Hydraulic
 * Resistance). Not measured for this case.
 */
export const DEFAULT_VENT_LOSS = 4;

export function defaultLayout(): Layout {
  const caseFan = (id: string, model: 'f120q' | 'p12', rpm: number, mount: Mount, intake: boolean): Fan => ({
    id,
    role: 'case',
    model,
    rpm,
    group: id.split('-')[0],
    pos: [...mount.pos],
    dir: mount.inward.map((v) => (intake || v === 0 ? v : -v)) as Vec3,
  });
  const cooler = (id: string, slot: 'inlet' | 'middle'): Fan => ({
    id,
    role: 'cpu',
    model: 'tlc12c',
    rpm: 1300,
    pos: [0, 0, 0],
    dir: [-1, 0, 0],
    slot,
    group: 'CPU_FAN',
  });
  return {
    version: 1,
    fans: [
      ...front.map((m, i) => caseFan(`front-${i + 1}`, 'f120q', 1000, m, true)),
      ...bottom.slice(0, 2).map((m, i) => caseFan(`bottom-${i + 1}`, 'p12', 1200, m, true)),
      ...top.slice(0, 2).map((m, i) => caseFan(`top-${i + 1}`, 'p12', 1200, m, false)),
      caseFan('rear', 'p12', 1200, rear, false),
      cooler('cpu-1', 'inlet'),
      cooler('cpu-2', 'middle'),
      ...gpuFans(1, 0, 'GPU'),
    ],
    cooler: { rotation: 0 },
    scenario: 'both',
    ambientC: 21,
    power: { cpuIdle: 40, cpuLoad: 200, gpuIdle: 15, gpuLoad: 180 },
    ventLoss: DEFAULT_VENT_LOSS,
    backPressure: true,
    secondGpu: false,
  };
}
