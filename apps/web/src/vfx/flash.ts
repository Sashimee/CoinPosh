import { abs, clamp, dot, exp, float, uniform, uv, vec4 } from 'three/tsl';
import {
  AdditiveBlending,
  Color,
  Group,
  Sprite,
  SpriteNodeMaterial,
  type Vector3,
} from 'three/webgpu';
import { easeOutBack, easeOutCubic, lerp, pulse } from './easing.ts';

export interface FlashOptions {
  readonly color: string;
  /** World-space diameter at full bloom, metres. */
  readonly size: number;
  /** HDR peak; 1 sits at the bloom threshold, 4+ blooms hard. */
  readonly intensity: number;
  readonly duration: number;
  /** Seconds before it starts, in effect time. */
  readonly delay?: number;
}

interface FlashSlot {
  readonly sprite: Sprite;
  readonly material: SpriteNodeMaterial;
  readonly tint: { value: Color };
  readonly strength: { value: number };
  age: number;
  delay: number;
  duration: number;
  size: number;
  intensity: number;
  busy: boolean;
}

const POOL = 8;
const popScale = easeOutBack(2.4);

/**
 * Billboard light bursts: a hot core with an anamorphic gold streak, which the bloom
 * pass spreads into the frame-wide glow. Scale pops with overshoot (squash/stretch) while
 * the intensity strikes and decays (light response).
 *
 * Reduced motion keeps the light but drops the scale pop and spreads the strike over a
 * longer, softer curve.
 */
export class FlashPool {
  readonly group = new Group();
  reducedMotion = false;
  private readonly slots: FlashSlot[] = [];

  constructor() {
    this.group.name = 'vfx-flashes';
    for (let i = 0; i < POOL; i++) this.slots.push(this.createSlot());
  }

  get active(): number {
    return this.slots.filter((s) => s.busy).length;
  }

  spawn(position: Vector3, options: FlashOptions): void {
    const slot =
      this.slots.find((s) => !s.busy) ??
      this.slots.reduce((oldest, s) =>
        s.age / s.duration > oldest.age / oldest.duration ? s : oldest,
      );
    slot.busy = true;
    slot.age = 0;
    slot.delay = options.delay ?? 0;
    slot.duration = this.reducedMotion ? Math.max(options.duration * 1.6, 0.3) : options.duration;
    slot.size = options.size;
    slot.intensity = this.reducedMotion ? options.intensity * 0.55 : options.intensity;
    slot.tint.value.set(options.color);
    slot.sprite.position.copy(position);
    slot.sprite.visible = false;
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
        slot.sprite.visible = false;
        continue;
      }
      const scale = this.reducedMotion
        ? 1
        : lerp(0.25, 1, popScale(Math.min(t / 0.32, 1))) * lerp(1, 1.18, easeOutCubic(t));
      slot.sprite.scale.setScalar(slot.size * scale);
      slot.strength.value = slot.intensity * pulse(t, this.reducedMotion ? 0.35 : 0.1);
      slot.sprite.visible = true;
    }
  }

  clear(): void {
    for (const slot of this.slots) {
      slot.busy = false;
      slot.sprite.visible = false;
    }
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const slot of this.slots) slot.material.dispose();
  }

  private createSlot(): FlashSlot {
    const tint = uniform(new Color());
    const strength = uniform(0);
    const d = uv().mul(2).sub(1);
    const core = exp(dot(d, d).mul(-9));
    const streak = exp(abs(d.y).mul(-42)).mul(clamp(float(1).sub(abs(d.x)), 0, 1).pow(2));
    const vertical = exp(abs(d.x).mul(-60)).mul(clamp(float(1).sub(abs(d.y)), 0, 1).pow(3));
    const mask = core.add(streak.mul(0.75)).add(vertical.mul(0.35));
    const material = new SpriteNodeMaterial();
    material.colorNode = vec4(tint.mul(strength), clamp(mask, 0, 1));
    material.transparent = true;
    material.depthWrite = false;
    material.depthTest = false;
    material.blending = AdditiveBlending;
    material.fog = false;
    const sprite = new Sprite(material);
    sprite.visible = false;
    sprite.renderOrder = 40;
    sprite.frustumCulled = false;
    this.group.add(sprite);
    return {
      sprite,
      material,
      tint,
      strength,
      age: 0,
      delay: 0,
      duration: 1,
      size: 0,
      intensity: 0,
      busy: false,
    };
  }
}
