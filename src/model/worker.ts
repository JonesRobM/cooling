// Voxelises off the main thread so that dragging stays smooth.
import { voxelise } from './geometry';
import type { Grid } from './grid';
import type { Layout } from './types';

export interface VoxeliseRequest {
  sequence: number;
  layout: Layout;
  grid: Grid;
}

self.onmessage = ({ data }: MessageEvent<VoxeliseRequest>) => {
  const geometry = voxelise(data.layout, data.grid);
  const buffers = [geometry.flags.buffer, geometry.fixed.buffer, geometry.drag.buffer];
  (self as unknown as Worker).postMessage({ sequence: data.sequence, geometry }, buffers as ArrayBuffer[]);
};
