// The 3D case, its components and the fans, with selection and drag editing.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { FAN_MODELS, fanDuty } from '../model/fans';
import { lowerBound, upperBound, type Grid } from '../model/grid';
import { resolveFan } from '../model/layout';
import { MOUNTS, SIZE, SOLIDS, gpuSolids, heatsinks, type Box } from '../model/machine';
import type { Fan, Layout, Vec3 } from '../model/types';

const FORWARD = new THREE.Vector3(0, 0, 1);
const COLOURS = { intake: 0x4aa3ff, exhaust: 0xff8a3d, internal: 0x7ddc8a, off: 0x666a70, selected: 0xffe14d };

export type ViewPreset = 'angle' | 'side' | 'tray' | 'front' | 'rear' | 'top';

// Camera direction from the case centre for each preset.
const PRESETS: Record<ViewPreset, Vec3> = {
  angle: [0.18, 0.12, 1],
  side: [0, 0, 1],
  tray: [0, 0, -1],
  front: [1, 0, 0],
  rear: [-1, 0, 0],
  top: [0, 1, 0.001],
};

export interface SceneEvents {
  select(id: string | null): void;
  /** A fan was moved or turned with the gizmo. `finished` marks the end of a drag. */
  transform(id: string, pos: Vec3, dir: Vec3, finished: boolean): void;
}

function boxMesh(box: Box, material: THREE.Material): THREE.Mesh {
  const size = box.max.map((v, a) => v - box.min[a]) as Vec3;
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
  mesh.position.set(...(box.min.map((v, a) => v + size[a] / 2) as Vec3));
  return mesh;
}

function outline(mesh: THREE.Mesh, colour: number, opacity = 1): THREE.LineSegments {
  const material = new THREE.LineBasicMaterial({ color: colour, transparent: opacity < 1, opacity });
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry), material);
  edges.position.copy(mesh.position);
  return edges;
}

const seeThrough = (color: number, opacity: number) =>
  new THREE.MeshStandardMaterial({ color, transparent: true, opacity, depthWrite: false });

/** A fan; the rotor is a child so that it can spin about the fan's axis. */
function fanObject(fan: Fan, colour: number): { group: THREE.Group; rotor: THREE.Group } {
  const model = FAN_MODELS[fan.model];
  const radius = model.diameter / 2;
  const group = new THREE.Group();
  const rotor = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({ color: colour, roughness: 0.6, side: THREE.DoubleSide });
  for (const z of [-model.thickness / 2, model.thickness / 2]) {
    const ring = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.0022, 8, 40), material);
    ring.position.z = z;
    group.add(ring);
  }
  rotor.add(new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.01, 16).rotateX(Math.PI / 2), material));
  for (let i = 0; i < 7; i++) {
    const blade = new THREE.Mesh(new THREE.BoxGeometry(radius - 0.014, 0.014, 0.0015), material);
    blade.geometry.translate((radius + 0.01) / 2, 0, 0).rotateX(0.5).rotateZ((i * 2 * Math.PI) / 7);
    rotor.add(blade);
  }
  // One pale blade tip, so that rotation reads even when slow.
  const mark = new THREE.Mesh(new THREE.SphereGeometry(0.004), new THREE.MeshBasicMaterial({ color: 0xffffff }));
  mark.position.set(radius - 0.01, 0, 0.004);
  rotor.add(mark);
  group.add(rotor);
  group.add(new THREE.ArrowHelper(FORWARD, new THREE.Vector3(), 0.055, colour, 0.018, 0.012));
  // Invisible disc so that clicking anywhere on the fan selects it.
  const hit = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, model.thickness, 24).rotateX(Math.PI / 2),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
  );
  group.add(hit);
  group.userData.id = fan.id;
  return { group, rotor };
}

export class SceneView {
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(40, 1, 0.01, 10);
  private renderer = new THREE.WebGLRenderer({ antialias: true });
  private orbit: OrbitControls;
  private gizmo: TransformControls;
  private fans = new THREE.Group();
  private sinks = new THREE.Group();
  private rotors = new Map<string, THREE.Group>();
  private angles = new Map<string, number>();
  private selected: string | null = null;
  private gizmoBusy = false;

  constructor(
    private host: HTMLElement,
    private grid: Grid,
    flow: THREE.Group,
    private events: SceneEvents,
  ) {
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    host.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color(0x14161a);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x333844, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1);
    sun.position.set(0.4, 0.8, 1);
    this.scene.add(sun);

    this.orbit = new OrbitControls(this.camera, this.renderer.domElement);
    this.setView('angle');

    this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
    this.gizmo.setSize(0.8);
    this.scene.add(this.gizmo.getHelper(), this.fans, this.sinks, flow);
    this.gizmo.addEventListener('dragging-changed', (e) => {
      this.gizmoBusy = e.value as boolean;
      this.orbit.enabled = !this.gizmoBusy;
      if (!this.gizmoBusy) this.report(true);
    });
    this.gizmo.addEventListener('objectChange', () => this.report(false));

    this.buildCase();
    this.listenForClicks();
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
  }

  setView(preset: ViewPreset) {
    const target = new THREE.Vector3(SIZE[0] / 2, SIZE[1] / 2, SIZE[2] / 2);
    const direction = new THREE.Vector3(...PRESETS[preset]).normalize();
    this.camera.position.copy(target).addScaledVector(direction, 1.2);
    this.orbit.target.copy(target);
    this.orbit.update();
  }

  private buildCase() {
    const shell = boxMesh({ min: [0, 0, 0], max: SIZE }, new THREE.MeshBasicMaterial());
    this.scene.add(outline(shell, 0x8b93a1));
    // The desk under the case. The simulated region around it is deliberately not outlined.
    const low = lowerBound(this.grid);
    const high = upperBound(this.grid);
    this.scene.add(boxMesh({ min: [low[0], low[1] - 0.004, low[2]], max: [high[0], low[1], high[2]] }, seeThrough(0x6b5a48, 0.18)));

    const tray = boxMesh({ min: [0, 0, -0.002], max: [SIZE[0], SIZE[1], 0] }, seeThrough(0x3a4050, 0.28));
    this.scene.add(tray);
    for (const { name, box } of SOLIDS) {
      const mesh = boxMesh(box, seeThrough(0x6a7280, name === 'Motherboard' ? 0.35 : 0.8));
      this.scene.add(mesh, outline(mesh, 0x737b88));
    }
    const mountMaterial = new THREE.MeshBasicMaterial({ color: 0x555c68 });
    for (const mount of MOUNTS) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.058, 0.0008, 6, 40), mountMaterial);
      ring.position.set(...mount.pos);
      ring.quaternion.setFromUnitVectors(FORWARD, new THREE.Vector3(...mount.inward));
      this.scene.add(ring);
    }
    for (const [text, x, y] of [['REAR', -0.11, SIZE[1] / 2], ['FRONT', SIZE[0] + 0.11, SIZE[1] / 2]] as const) {
      const canvas = document.createElement('canvas');
      canvas.width = 256;
      canvas.height = 64;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#9aa3b2';
      ctx.font = '40px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText(text, 128, 46);
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas) }));
      sprite.scale.set(0.08, 0.02, 1);
      sprite.position.set(x, y, SIZE[2] / 2);
      this.scene.add(sprite);
    }
  }

  sync(layout: Layout, selected: string | null) {
    this.selected = selected;
    // Leave the object being dragged alone; rebuilding it would drop the drag.
    if (this.gizmoBusy) return;
    this.gizmo.detach();
    this.fans.clear();
    this.sinks.clear();
    this.rotors.clear();
    layout.fans.forEach((fan, i) => {
      const duty = fanDuty(layout, i);
      const colour = fan.id === selected ? COLOURS.selected : fan.rpm <= 0 ? COLOURS.off : COLOURS[duty];
      const { group, rotor } = fanObject(fan, colour);
      const { pos, dir } = resolveFan(fan, layout.cooler);
      group.position.set(...pos);
      group.quaternion.setFromUnitVectors(FORWARD, new THREE.Vector3(...dir));
      rotor.rotation.z = this.angles.get(fan.id) ?? 0;
      this.rotors.set(fan.id, rotor);
      this.fans.add(group);
      if (fan.id === selected && fan.role !== 'cpu') this.gizmo.attach(group);
    });
    for (const { box } of gpuSolids(layout.secondGpu)) {
      const mesh = boxMesh(box, seeThrough(0x6a7280, 0.8));
      this.sinks.add(mesh, outline(mesh, 0x737b88));
    }
    for (const sink of heatsinks(layout.cooler.rotation, layout.secondGpu)) {
      const colour = sink.part === 'cpu' ? 0xc9a36a : 0x9a86c9;
      const mesh = boxMesh(sink.box, seeThrough(colour, 0.14));
      this.sinks.add(mesh, outline(mesh, colour));
    }
  }

  /** Turn each rotor at `rate` times its real speed, scaled by the flow it is delivering. */
  spin(dt: number, layout: Layout, factors: ReadonlyMap<string, number>, rate: number) {
    for (const fan of layout.fans) {
      const rotor = this.rotors.get(fan.id);
      if (!rotor) continue;
      const revolutions = (fan.rpm / 60) * (factors.get(fan.id) ?? 1) * rate * dt;
      const angle = ((this.angles.get(fan.id) ?? 0) + 2 * Math.PI * revolutions) % (2 * Math.PI);
      this.angles.set(fan.id, angle);
      rotor.rotation.z = angle;
    }
  }

  setMode(mode: 'translate' | 'rotate') {
    this.gizmo.setMode(mode);
  }

  setSnap(on: boolean) {
    this.gizmo.setTranslationSnap(on ? 0.005 : null);
    this.gizmo.setRotationSnap(on ? Math.PI / 2 : null);
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }

  private report(finished: boolean) {
    const object = this.gizmo.object;
    if (!object || !this.selected) return;
    const p = object.position;
    const d = FORWARD.clone().applyQuaternion(object.quaternion).normalize();
    const tidy = (v: number) => Math.round(v * 1e4) / 1e4 + 0;
    this.events.transform(this.selected, [tidy(p.x), tidy(p.y), tidy(p.z)], [tidy(d.x), tidy(d.y), tidy(d.z)], finished);
  }

  private listenForClicks() {
    const raycaster = new THREE.Raycaster();
    let down: [number, number] | null = null;
    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointerdown', (e) => {
      down = this.gizmo.axis ? null : [e.clientX, e.clientY];
    });
    canvas.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return;
      const rect = canvas.getBoundingClientRect();
      const pointer = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(pointer, this.camera);
      let hit: THREE.Object3D | null = raycaster.intersectObjects(this.fans.children, true)[0]?.object ?? null;
      while (hit && !hit.userData.id) hit = hit.parent;
      this.events.select(hit?.userData.id ?? null);
    });
  }

  private resize() {
    const { clientWidth: w, clientHeight: h } = this.host;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
}
