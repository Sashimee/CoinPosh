import { clamp, exp, float, length, smoothstep, uniform, uv, vec4 } from 'three/tsl';
import {
  AdditiveBlending,
  Color,
  Group,
  Mesh,
  MeshBasicNodeMaterial,
  PlaneGeometry,
  type Object3D,
  type Vector3,
} from 'three/webgpu';
import { easeOutCubic, easeOutExpo, lerp, pulse } from './easing.ts';

export interface ShockwaveOptions {
  readonly color: string;
  /** Final ring radius on the table, metres. */
  readonly radius: number;
  readonly intensity: number;
  readonly duration: number;
  readonly delay?: number;
}

interface RingSlot {
  readonly mesh: Mesh<PlaneGeometry, MeshBasicNodeMaterial>;
  readonly tint: Color;
  front: number;
  width: number;
  strength: number;
  age: number;
  delay: number;
  duration: number;
  radius: number;
  intensity: number;
  busy: boolean;
}

const POOL = 6;
/** Lifts the ring off the felt so it never z-fights the table it lies on. */
const LIFT = 0.0025;

/**
 * Flat rings that race across the table from a fusion: a crisp leading edge with a soft
 * wake, expanding on an exponential ease so the first frames carry the punch.
 *
 * Reduced motion: the ring does not travel; it blooms in place at 60 % radius and fades.
 *
 * All rings share one material with per-object uniforms: one program for the whole pool.
 */
export class ShockwavePool {
  readonly group = new Group();
  readonly material: MeshBasicNodeMaterial;
  reducedMotion = false;
  private readonly slots: RingSlot[] = [];
  private readonly byMesh = new Map<Object3D, RingSlot>();
  private readonly geometry = new PlaneGeometry(2, 2);

  constructor() {
    this.group.name = 'vfx-shockwaves';
    this.geometry.rotateX(-Math.PI / 2);
    this.material = this.createMaterial();
    for (let i = 0; i < POOL; i++) this.slots.push(this.createSlot());
  }

  get active(): number {
    return this.slots.filter((s) => s.busy).length;
  }

  spawn(position: Vector3, options: ShockwaveOptions): void {
    const slot = this.slots.find((s) => !s.busy) ?? this.slots[0];
    if (!slot) return;
    slot.busy = true;
    slot.age = 0;
    slot.delay = options.delay ?? 0;
    slot.duration = options.duration;
    slot.radius = options.radius;
    slot.intensity = this.reducedMotion ? options.intensity * 0.5 : options.intensity;
    slot.tint.set(options.color);
    slot.mesh.position.set(position.x, position.y + LIFT, position.z);
    slot.mesh.scale.setScalar(options.radius);
    slot.mesh.updateMatrix();
    slot.mesh.visible = false;
  }

  update(dt: number): void {
    for (const slot of this.slots) {
      if (!slot.busy) continue;
      if (slot.delay > 0) {
        slot.delay -= dt;
        continue;
      }
      slot.age += dt;
      const t = slot.age / slot.duration;
      if (t >= 1) {
        slot.busy = false;
        slot.mesh.visible = false;
        continue;
      }
      if (this.reducedMotion) {
        slot.front = 0.6;
        slot.width = 0.12;
        slot.strength = slot.intensity * pulse(t, 0.3);
      } else {
        slot.front = lerp(0.04, 0.96, easeOutExpo(t));
        slot.width = lerp(0.025, 0.11, easeOutCubic(t));
        slot.strength = slot.intensity * (1 - t) ** 1.8;
      }
      slot.mesh.visible = true;
    }
  }

  clear(): void {
    for (const slot of this.slots) {
      slot.busy = false;
      slot.mesh.visible = false;
    }
  }

  dispose(): void {
    this.group.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }

  /** Shows one ring at zero strength while `compile` runs, as `FlashPool.warm` does. */
  async warm(compile: () => Promise<void>): Promise<void> {
    const probe = this.slots.find((s) => !s.busy);
    if (!probe) return;
    probe.strength = 0;
    probe.mesh.visible = true;
    try {
      await compile();
    } finally {
      if (!probe.busy) probe.mesh.visible = false;
    }
  }

  private slotOf(object: Object3D | null): RingSlot {
    const slot = object ? this.byMesh.get(object) : undefined;
    if (!slot)
      throw new Error('ShockwavePool material drawn on an object that is not one of its rings');
    return slot;
  }

  private createMaterial(): MeshBasicNodeMaterial {
    const tint = uniform(new Color()).onObjectUpdate(({ object }) => this.slotOf(object).tint);
    const front = uniform(0).onObjectUpdate(({ object }) => this.slotOf(object).front);
    const width = uniform(0.05).onObjectUpdate(({ object }) => this.slotOf(object).width);
    const strength = uniform(0).onObjectUpdate(({ object }) => this.slotOf(object).strength);
    const r = length(uv().mul(2).sub(1));
    const offset = r.sub(front).div(width);
    const edge = exp(offset.mul(offset).mul(-1)).mul(1.2);
    const wake = smoothstep(front, float(0), r)
      .mul(0.22)
      .mul(smoothstep(float(0), front, r));
    const rim = float(1).sub(smoothstep(0.94, 1, r));
    const material = new MeshBasicNodeMaterial();
    material.colorNode = vec4(tint.mul(strength), clamp(edge.add(wake).mul(rim), 0, 1));
    material.transparent = true;
    material.depthWrite = false;
    material.blending = AdditiveBlending;
    material.fog = false;
    return material;
  }

  private createSlot(): RingSlot {
    const mesh = new Mesh(this.geometry, this.material);
    mesh.visible = false;
    mesh.renderOrder = 25;
    mesh.matrixAutoUpdate = false;
    mesh.frustumCulled = false;
    this.group.add(mesh);
    const slot: RingSlot = {
      mesh,
      tint: new Color(),
      front: 0,
      width: 0.05,
      strength: 0,
      age: 0,
      delay: 0,
      duration: 1,
      radius: 0,
      intensity: 0,
      busy: false,
    };
    this.byMesh.set(mesh, slot);
    return slot;
  }
}
