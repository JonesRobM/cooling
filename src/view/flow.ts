// Particles, streamlines, slice map and velocity arrows, drawn from the latest fields.
import * as THREE from 'three';
import { FAN_MODELS, fanDuty } from '../model/fans';
import { discSamples } from '../model/geometry';
import { lowerBound, upperBound, type Grid } from '../model/grid';
import { resolveFan } from '../model/layout';
import { SIZE } from '../model/machine';
import { scalarAt, velocityAt } from '../model/sample';
import type { Layout, Vec3 } from '../model/types';
import type { Fields } from '../sim/solver';
import { SOURCE_COLOURS, SPEED_SPAN, TEMPERATURE_SPAN, colourMap } from './colour';

export interface ViewOptions {
  particles: boolean;
  particleColour: 'temperature' | 'source';
  streamlines: boolean;
  slice: boolean;
  arrows: boolean;
  sliceAxis: 0 | 1 | 2;
  /** 0 to 1 across the whole region. */
  slicePosition: number;
  sliceQuantity: 'temperature' | 'speed';
}

const PARTICLES = 9000;
const BACKGROUND = new THREE.Color(0x14161a).toArray();
const PLAYBACK = 0.15; // simulated seconds of air movement per displayed second
const LIFETIME = 2.2; // s of air movement

interface Source {
  pos: Vec3;
  dir: Vec3;
  radius: number;
  intake: boolean;
  colour: Vec3;
}

const inCase = (p: Vec3) => p.every((v, a) => v >= 0 && v <= SIZE[a]);

function dynamic(vertices: number): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  for (const name of ['position', 'color']) {
    const attribute = new THREE.BufferAttribute(new Float32Array(vertices * 3), 3);
    attribute.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute(name, attribute);
  }
  return g;
}

const arrayOf = (g: THREE.BufferGeometry, name: string) => g.getAttribute(name).array as Float32Array;

function markUpdated(g: THREE.BufferGeometry, vertices: number) {
  g.getAttribute('position').needsUpdate = true;
  g.getAttribute('color').needsUpdate = true;
  g.setDrawRange(0, vertices);
}

export class FlowView {
  readonly group = new THREE.Group();
  private fields: Fields | null = null;
  private ambient = 21;
  private sources: Source[] = [];
  private position: Vec3[];
  private origin: Vec3[]; // colour of where each particle entered the case
  private age = new Float32Array(PARTICLES);
  private low: Vec3;
  private high: Vec3;

  private points: THREE.Points;
  private lines: THREE.LineSegments;
  private arrows: THREE.LineSegments;
  private slice: THREE.Mesh;

  constructor(
    private grid: Grid,
    private options: ViewOptions,
  ) {
    this.low = lowerBound(grid);
    this.high = upperBound(grid);
    const lineMaterial = () => new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85 });
    this.points = new THREE.Points(dynamic(PARTICLES), new THREE.PointsMaterial({ size: 0.004, vertexColors: true }));
    this.lines = new THREE.LineSegments(dynamic(120000), lineMaterial());
    this.arrows = new THREE.LineSegments(dynamic(90000), lineMaterial());
    this.slice = new THREE.Mesh(
      dynamic(Math.max(...grid.cells) ** 2),
      new THREE.MeshBasicMaterial({
        vertexColors: true,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.65,
        depthWrite: false,
      }),
    );
    for (const object of [this.points, this.lines, this.arrows, this.slice]) {
      object.frustumCulled = false;
      object.visible = false;
      this.group.add(object);
    }
    this.position = Array.from({ length: PARTICLES }, () => [Infinity, 0, 0] as Vec3);
    this.origin = Array.from({ length: PARTICLES }, () => SOURCE_COLOURS.surroundings);
    for (let i = 0; i < PARTICLES; i++) this.age[i] = Math.random() * LIFETIME;
  }

  setLayout(layout: Layout) {
    this.ambient = layout.ambientC;
    this.sources = layout.fans.flatMap((fan, i) => {
      if (fan.rpm <= 0) return [];
      const { pos, dir } = resolveFan(fan, layout.cooler);
      return [
        {
          pos,
          dir,
          radius: FAN_MODELS[fan.model].diameter / 2,
          intake: fanDuty(layout, i) === 'intake',
          colour: SOURCE_COLOURS[fan.group ?? ''] ?? SOURCE_COLOURS.other,
        },
      ];
    });
  }

  setFields(fields: Fields) {
    this.fields = fields;
    this.rebuild();
  }

  /** Redraw everything that changes only when the fields or view options change. */
  rebuild() {
    if (!this.fields) return;
    this.points.visible = this.options.particles;
    this.lines.visible = this.options.streamlines;
    this.slice.visible = this.options.slice;
    this.arrows.visible = this.options.arrows;
    if (this.options.streamlines) this.buildStreamlines(this.fields);
    if (this.options.slice) this.buildSlice(this.fields);
    if (this.options.arrows) this.buildArrows(this.fields);
  }

  /** Blend into the background towards the region's edge, so the flow tails off with no visible box. */
  private fade(p: Vec3, colours: Float32Array, at: number) {
    let weight = 1;
    for (let a = 0; a < 3; a++) {
      const beyond =
        p[a] < 0 ? p[a] / this.low[a] : p[a] > SIZE[a] ? (p[a] - SIZE[a]) / (this.high[a] - SIZE[a]) : 0;
      const t = Math.min(Math.max(beyond, 0), 1);
      weight *= 1 - t * t * (3 - 2 * t);
    }
    for (let c = 0; c < 3; c++) colours[at + c] = BACKGROUND[c] + (colours[at + c] - BACKGROUND[c]) * weight;
  }

  private temperatureColour(temp: number, out: Float32Array, at: number) {
    colourMap((temp - this.ambient) / TEMPERATURE_SPAN, out, at);
  }

  private inRegion(p: Vec3) {
    return p.every((v, a) => v >= this.low[a] && v <= this.high[a]);
  }

  /** A point on a random fan, or anywhere in the region. */
  private spawn(i: number) {
    const bySource = this.options.particleColour === 'source';
    const pool = bySource ? this.sources.filter((s) => s.intake) : this.sources;
    this.origin[i] = SOURCE_COLOURS.surroundings;
    this.age[i] = Math.random() * 0.2;
    if (pool.length && Math.random() < (bySource ? 0.65 : 0.4)) {
      const s = pool[Math.floor(Math.random() * pool.length)];
      const ring = discSamples(s.pos, s.dir, s.radius, 0);
      const edge = ring[Math.floor(Math.random() * ring.length)];
      const jitter = () => (Math.random() - 0.5) * 0.02;
      this.position[i] = edge.map((v) => v + jitter()) as Vec3;
      if (s.intake) this.origin[i] = s.colour;
      return;
    }
    let p: Vec3;
    do p = this.low.map((lo, a) => lo + Math.random() * (this.high[a] - lo)) as Vec3;
    while (bySource && inCase(p)); // inside air of unknown origin would only confuse
    this.position[i] = p;
  }

  /** Colour a particle that has just crossed into the case by where it came in. */
  private enter(i: number, p: Vec3) {
    const near = this.sources.find(
      (s) => s.intake && Math.hypot(p[0] - s.pos[0], p[1] - s.pos[1], p[2] - s.pos[2]) < s.radius + 0.025,
    );
    this.origin[i] = near ? near.colour : SOURCE_COLOURS.other;
  }

  /** Move the particles by dt seconds of wall-clock time. */
  animate(dt: number) {
    if (!this.fields || !this.options.particles) return;
    const { vel, temp } = this.fields;
    const g = this.points.geometry;
    const positions = arrayOf(g, 'position');
    const colours = arrayOf(g, 'color');
    const step = Math.min(dt, 0.05) * PLAYBACK;
    const bySource = this.options.particleColour === 'source';
    const v: Vec3 = [0, 0, 0];
    for (let i = 0; i < PARTICLES; i++) {
      this.age[i] += step;
      if (this.age[i] > LIFETIME || !this.inRegion(this.position[i])) {
        this.spawn(i);
      } else {
        const p = this.position[i];
        const wasInside = inCase(p);
        velocityAt(this.grid, vel, p, v);
        for (let a = 0; a < 3; a++) p[a] += v[a] * step;
        if (!wasInside && inCase(p)) this.enter(i, p);
      }
      const p = this.position[i];
      positions.set(p, i * 3);
      if (bySource) colours.set(this.origin[i], i * 3);
      else this.temperatureColour(scalarAt(this.grid, temp, p), colours, i * 3);
      this.fade(p, colours, i * 3);
    }
    markUpdated(g, PARTICLES);
  }

  private buildStreamlines({ vel, temp }: Fields) {
    const g = this.lines.geometry;
    const positions = arrayOf(g, 'position');
    const colours = arrayOf(g, 'color');
    const capacity = positions.length / 3;
    let n = 0;
    const v: Vec3 = [0, 0, 0];
    const push = (p: Vec3) => {
      positions.set(p, n * 3);
      this.temperatureColour(scalarAt(this.grid, temp, p), colours, n * 3);
      this.fade(p, colours, n * 3);
      n++;
    };
    for (const s of this.sources.filter((x) => x.intake)) {
      // Start just downstream of the fan.
      for (let p of discSamples(s.pos, s.dir, s.radius, 0.016)) {
        for (let k = 0; k < 300 && n + 2 <= capacity; k++) {
          velocityAt(this.grid, vel, p, v);
          const speed = Math.hypot(...v);
          if (speed < 0.05) break;
          const half = p.map((c, a) => c + (v[a] / speed) * 0.003) as Vec3;
          velocityAt(this.grid, vel, half, v);
          const midSpeed = Math.hypot(...v) || 1;
          const next = p.map((c, a) => c + (v[a] / midSpeed) * 0.006) as Vec3;
          if (!this.inRegion(next)) break;
          push(p);
          push(next);
          p = next;
        }
      }
    }
    markUpdated(g, n);
  }

  /** The two axes spanning the slice, and the slice's coordinate in metres. */
  private plane() {
    const axis = this.options.sliceAxis;
    const [b, d] = [0, 1, 2].filter((a) => a !== axis);
    const { h, cells } = this.grid;
    const at = this.low[axis] + h / 2 + this.options.slicePosition * (cells[axis] - 1) * h;
    const centre = (a: number, i: number) => this.low[a] + (i + 0.5) * h;
    return { axis, b, d, at, centre, cells };
  }

  private buildSlice({ vel, temp }: Fields) {
    const { axis, b, d, at, centre, cells } = this.plane();
    const g = this.slice.geometry;
    const positions = arrayOf(g, 'position');
    const colours = arrayOf(g, 'color');
    const [nb, nd] = [cells[b], cells[d]];
    const v: Vec3 = [0, 0, 0];
    for (let j = 0; j < nd; j++)
      for (let i = 0; i < nb; i++) {
        const p: Vec3 = [0, 0, 0];
        p[axis] = at;
        p[b] = centre(b, i);
        p[d] = centre(d, j);
        const k = (i + j * nb) * 3;
        positions.set(p, k);
        if (this.options.sliceQuantity === 'temperature')
          this.temperatureColour(scalarAt(this.grid, temp, p), colours, k);
        else colourMap(Math.hypot(...velocityAt(this.grid, vel, p, v)) / SPEED_SPAN, colours, k);
        this.fade(p, colours, k);
      }
    if (g.userData.axis !== axis) {
      const indices: number[] = [];
      for (let j = 0; j + 1 < nd; j++)
        for (let i = 0; i + 1 < nb; i++) {
          const k = i + j * nb;
          indices.push(k, k + 1, k + nb, k + 1, k + nb + 1, k + nb);
        }
      g.setIndex(indices);
      g.userData.axis = axis;
    }
    g.getAttribute('position').needsUpdate = true;
    g.getAttribute('color').needsUpdate = true;
    g.setDrawRange(0, g.index!.count);
  }

  private buildArrows({ vel }: Fields) {
    const { axis, b, d, at, centre, cells } = this.plane();
    const g = this.arrows.geometry;
    const positions = arrayOf(g, 'position');
    const colours = arrayOf(g, 'color');
    const capacity = positions.length / 3;
    let n = 0;
    const v: Vec3 = [0, 0, 0];
    const line = (from: Vec3, to: Vec3, speed: number) => {
      for (const p of [from, to]) {
        positions.set(p, n * 3);
        colourMap(speed / SPEED_SPAN, colours, n * 3);
        this.fade(p, colours, n * 3);
        n++;
      }
    };
    for (let j = 1; j < cells[d]; j += 3)
      for (let i = 1; i < cells[b] && n + 6 <= capacity; i += 3) {
        const p: Vec3 = [0, 0, 0];
        p[axis] = at;
        p[b] = centre(b, i);
        p[d] = centre(d, j);
        velocityAt(this.grid, vel, p, v);
        const speed = Math.hypot(...v);
        if (speed < 0.05) continue;
        const length = Math.min(speed / SPEED_SPAN, 1) * 0.025 + 0.004;
        const unit = v.map((x) => x / speed) as Vec3;
        const tip = p.map((x, a) => x + unit[a] * length) as Vec3;
        line(p, tip, speed);
        // Arrow head, drawn in the plane of the slice.
        const side: Vec3 = [0, 0, 0];
        side[b] = -unit[d];
        side[d] = unit[b];
        for (const s of [1, -1]) {
          const barb = tip.map((x, a) => x - unit[a] * length * 0.35 + s * side[a] * length * 0.2) as Vec3;
          line(tip, barb, speed);
        }
      }
    markUpdated(g, n);
  }
}
