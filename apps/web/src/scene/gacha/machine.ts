import type { Rarity } from '@coinposh/shared';
import {
  Color,
  Euler,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  Quaternion,
  Sprite,
  Vector3,
} from 'three/webgpu';
import { RARITY_COLORS } from '../../vfx/palette.ts';
import {
  easeInOutCubic,
  easeInQuad,
  easeOutBack,
  easeOutCubic,
  stepSpring,
  type SpringState,
} from '../../vfx/easing.ts';
import { rivieraTokens } from '../venues/riviera/palette.ts';
import {
  capsuleHalfGeometry,
  crankGeometry,
  glassGeometry,
  machineBodyGeometry,
  pileGeometry,
} from './geometry.ts';
import {
  createChuteCurve,
  createChuteTrack,
  exitCapsule,
  GACHA,
  packPile,
  PILE_TINTS,
  POP_POINT,
  TRAY_REST,
} from './layout.ts';
import {
  createCapsuleMaterial,
  createGlassMaterial,
  createGlowMaterial,
  createMachineMaterial,
  type GachaQuality,
} from './materials.ts';
import {
  bounceContacts,
  bounceHeight,
  CHUTE_KNOCKS,
  detentIndex,
  detentTurns,
  DISPENSE,
  DISPENSE_REDUCED,
  POP,
  POP_REDUCED,
  popGlow,
  RARITY_GLOW,
  rollShare,
} from './motion.ts';

/** Drives the machine's frames; the default is `requestAnimationFrame` with `performance.now`. */
export interface GachaTicker {
  now(): number;
  request(frame: () => void): unknown;
  cancel(handle: unknown): void;
}

/**
 * Beats the flow hangs its juice on (sound, haptics, particles, hit-stop). `at` is the capsule's
 * (or for a click, the crank's) world position at the beat.
 */
export type GachaEvent =
  | { readonly kind: 'click'; readonly detent: number; readonly at: Vector3 }
  | { readonly kind: 'drop'; readonly rarity: Rarity; readonly at: Vector3 }
  | { readonly kind: 'knock'; readonly strength: number; readonly at: Vector3 }
  | { readonly kind: 'land'; readonly strength: number; readonly at: Vector3 }
  | { readonly kind: 'twist'; readonly step: 1 | 2; readonly at: Vector3 }
  | { readonly kind: 'pop'; readonly rarity: Rarity; readonly at: Vector3 };

export interface GachaMachineOptions {
  /** No spin, no roll, no rattle: the capsule cross-fades in and open. Defaults to false. */
  readonly reducedMotion?: boolean;
  /** `low` sheds the velvet sheen, the anisotropy and a third of the pile. Defaults to high. */
  readonly quality?: GachaQuality;
  readonly ticker?: GachaTicker;
  readonly onEvent?: (event: GachaEvent) => void;
  /** Seeds the pile's packing and colours. */
  readonly seed?: number;
}

export interface GachaMachine {
  /** Add this to the scene; its origin is the plinth's underside and it faces +Z. */
  readonly object3d: Group;
  /** Sets how far the crank has been turned: 0 at rest, 1 for one full turn. */
  crank(progress: number): void;
  /** Rolls a capsule of `rarity` out of the globe, down the chute and into the tray. */
  dispense(rarity: Rarity): Promise<void>;
  /** Lifts the capsule in the tray, twists it open and bursts its `rarity` light. */
  pop(rarity: Rarity): Promise<void>;
  /** Back to a full globe, an empty tray and the crank at rest; settles a running sequence. */
  reset(): void;
  dispose(): void;
}

export const PILE_COUNT = { high: 38, low: 26 } as const;

/** The longest frame step the motion takes: a stall or a background tab never teleports it. */
const MAX_STEP = 1 / 20;
const LANDINGS = bounceContacts(DISPENSE.bounce - DISPENSE.roll);

type Phase = 'idle' | 'dispensing' | 'tray' | 'popping' | 'open';

interface Sequence {
  readonly kind: 'dispense' | 'pop';
  readonly rarity: Rarity;
  readonly resolve: () => void;
  time: number;
  /** Cues already fired, as a bit set. */
  fired: number;
}

function defaultTicker(): GachaTicker {
  const now = (): number => performance.now();
  if (typeof requestAnimationFrame === 'function') {
    return {
      now,
      request: (frame) => requestAnimationFrame(frame),
      cancel: (handle) => {
        cancelAnimationFrame(handle as number);
      },
    };
  }
  return {
    now,
    request: (frame) => setTimeout(frame, 1000 / 60),
    cancel: (handle) => {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
  };
}

function linearColor(hex: string, out = new Color()): Color {
  return out.set(hex);
}

/**
 * Builds the procedural capsule machine: seven draws (cabinet, crank, pile, glass, the two
 * shells of the dispensed capsule and its glow) whatever the pile holds. Every animation is
 * cosmetic and runs on its own ticker only while something moves; nothing allocates per frame.
 */
export function createGachaMachine(options: GachaMachineOptions = {}): GachaMachine {
  const reduced = options.reducedMotion ?? false;
  const quality = options.quality ?? 'high';
  const ticker = options.ticker ?? defaultTicker();
  const emit = options.onEvent;

  const object3d = new Group();
  object3d.name = 'gacha-machine';
  const rig = new Group();
  rig.name = 'gacha-rig';
  object3d.add(rig);

  const curve = createChuteCurve();
  const track = createChuteTrack(curve);
  const cabinet = createMachineMaterial(quality);
  const glassMaterial = createGlassMaterial();
  const pileMaterial = createCapsuleMaterial({ instanced: true });
  const capsuleMaterial = createCapsuleMaterial({ instanced: false });
  const glowMaterial = createGlowMaterial();

  const body = new Mesh(machineBodyGeometry(curve), cabinet.material);
  body.name = 'gacha-body';
  body.castShadow = true;
  body.receiveShadow = true;

  const crankMesh = new Mesh(crankGeometry(), cabinet.material);
  crankMesh.name = 'gacha-crank';
  crankMesh.position.set(0, GACHA.crank.pivotY, GACHA.body.halfDepth + 0.004);
  crankMesh.castShadow = true;

  const pile = packPile(PILE_COUNT[quality], options.seed ?? 7);
  const tints = PILE_TINTS.map((hex) => {
    const c = linearColor(hex);
    return [c.r, c.g, c.b] as const;
  });
  const pileMesh = new InstancedMesh(pileGeometry(pile, tints), pileMaterial.material, pile.length);
  pileMesh.name = 'gacha-pile';
  const restPositions = pile.map((c) => new Vector3(c.x, c.y, c.z));
  const restTurns = pile.map((c) => new Quaternion().setFromEuler(new Euler(c.rx, c.ry, c.rz)));
  const exitIndex = exitCapsule(pile);

  const glass = new Mesh(glassGeometry(curve), glassMaterial);
  glass.name = 'gacha-glass';
  glass.renderOrder = 2;

  const capsule = new Group();
  capsule.name = 'gacha-capsule';
  const domeMesh = new Mesh(capsuleHalfGeometry('dome'), capsuleMaterial.material);
  const baseMesh = new Mesh(capsuleHalfGeometry('base'), capsuleMaterial.material);
  domeMesh.name = 'gacha-capsule-dome';
  baseMesh.name = 'gacha-capsule-base';
  domeMesh.renderOrder = 1;
  baseMesh.renderOrder = 1;
  capsule.add(domeMesh, baseMesh);
  capsule.visible = false;

  const glow = new Sprite(glowMaterial.material);
  glow.name = 'gacha-glow';
  glow.renderOrder = 3;
  glow.visible = false;

  rig.add(body, crankMesh, pileMesh, glass, capsule, glow);

  const scratch = new Matrix4();
  const one = new Vector3(1, 1, 1);
  const jitter = new Vector3();
  const wobble = new Quaternion();
  const wobbleAxis = new Vector3();
  const writeRest = (index: number): void => {
    const position = restPositions[index];
    const turn = restTurns[index];
    if (!position || !turn) throw new Error(`Gacha pile has no capsule ${index}`);
    scratch.compose(position, turn, one);
    pileMesh.setMatrixAt(index, scratch);
  };
  const hidden = new Matrix4().makeScale(0, 0, 0);
  let exitHidden = false;
  const writePile = (): void => {
    for (let i = 0; i < pile.length; i++) {
      if (i === exitIndex && exitHidden) pileMesh.setMatrixAt(i, hidden);
      else writeRest(i);
    }
    pileMesh.instanceMatrix.needsUpdate = true;
  };
  writePile();
  pileMesh.computeBoundingSphere();

  const crankAngle: SpringState = { value: 0, velocity: 0 };
  const thump: SpringState = { value: 0, velocity: 0 };
  const capsuleSquash: SpringState = { value: 0, velocity: 0 };
  const domeSquash: SpringState = { value: 0, velocity: 0 };
  let crankProgress = 0;
  let lastDetent = 0;
  let agitation = 0;
  let rattling = false;
  let lampFlash = 0;
  let clock = 0;
  let phase: Phase = 'idle';
  let sequence: Sequence | null = null;
  let disposed = false;
  let running = false;
  let handle: unknown = null;
  let last = 0;
  let glowSize: number = RARITY_GLOW.common.size;
  let glowStrength: number = RARITY_GLOW.common.intensity;
  let glowRays: number = RARITY_GLOW.common.rays;
  let heirloom = false;
  let rollU = 0;
  let rollX = 0;
  let rollZ = 0;

  const champagne = linearColor(rivieraTokens.champagne);
  const rarityColor = new Color();
  const lampRest = new Color().copy(champagne);
  const liftFrom = new Vector3();
  const turnFrom = new Quaternion();
  const identity = new Quaternion();
  const point = new Vector3();
  const tangent = new Vector3();
  const floorDown = new Vector3();
  const rollAxis = new Vector3();
  const roll = new Quaternion();
  const mouth = new Vector3();
  const down = new Vector3(0, -1, 0);

  const at = (target: Mesh | Group): Vector3 => target.getWorldPosition(new Vector3());
  const tintFor = (rarity: Rarity): void => {
    linearColor(RARITY_COLORS[rarity], rarityColor);
    capsuleMaterial.tint.value.copy(rarityColor);
    glowMaterial.color.value.copy(rarityColor);
    heirloom = rarity === 'heirloom';
    capsuleMaterial.heirloom.value = heirloom ? 1 : 0;
    glowMaterial.heirloom.value = heirloom ? 1 : 0;
    const style = RARITY_GLOW[rarity];
    glowSize = style.size;
    glowStrength = style.intensity;
    glowRays = style.rays;
  };

  const closeCapsule = (): void => {
    domeMesh.position.set(0, 0, 0);
    domeMesh.rotation.set(0, 0, 0);
    domeMesh.scale.set(1, 1, 1);
    baseMesh.position.set(0, 0, 0);
    baseMesh.rotation.set(0, 0, 0);
    baseMesh.scale.set(1, 1, 1);
    capsule.scale.set(1, 1, 1);
    capsuleMaterial.seamGlow.value = 0;
    capsuleMaterial.innerGlow.value = 0;
    capsuleMaterial.opacity.value = 1;
  };

  const openPose = (lift: number, tilt: number): void => {
    domeMesh.position.set(0, lift, -lift * 0.35);
    domeMesh.rotation.set(-0.62 * tilt, -1.8, 0);
    baseMesh.rotation.set(0.32 * tilt, 0, 0);
  };

  const placeGlow = (): void => {
    glow.position.copy(capsule.position);
    glow.position.y += 0.008;
    glow.position.z += 0.012;
  };

  const fire = (sequenceRef: Sequence, bit: number): boolean => {
    if (sequenceRef.fired & (1 << bit)) return false;
    sequenceRef.fired |= 1 << bit;
    return true;
  };

  const rollTo = (x: number, y: number, z: number, contactX: number, contactZ: number): void => {
    const dx = x - capsule.position.x;
    const dy = y - capsule.position.y;
    const dz = z - capsule.position.z;
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (distance > 1e-7) {
      rollAxis.set(-contactX, 1, -contactZ).normalize();
      tangent.set(dx, dy, dz).divideScalar(distance);
      rollAxis.cross(tangent);
      if (rollAxis.lengthSq() > 1e-10) {
        roll.setFromAxisAngle(rollAxis.normalize(), distance / GACHA.capsuleRadius);
        capsule.quaternion.premultiply(roll);
      }
    }
    capsule.position.set(x, y, z);
  };

  const finish = (): void => {
    const done = sequence;
    if (!done) return;
    sequence = null;
    phase = done.kind === 'dispense' ? 'tray' : 'open';
    done.resolve();
  };

  const stepDispense = (s: Sequence): void => {
    const t = s.time;
    if (reduced) {
      capsule.position.copy(TRAY_REST);
      capsule.quaternion.identity();
      capsuleMaterial.opacity.value = easeOutCubic(t / DISPENSE_REDUCED.fade);
      if (t >= DISPENSE_REDUCED.fade) {
        if (fire(s, 0)) emit?.({ kind: 'land', strength: 0.4, at: at(capsule) });
        finish();
      }
      return;
    }
    if (t < DISPENSE.drop) {
      const k = easeInQuad(t / DISPENSE.drop);
      const from = restPositions[exitIndex] ?? TRAY_REST;
      track.pointAt(0, point);
      capsule.position.lerpVectors(from, point, k);
      capsule.scale.setScalar(0.92 + 0.08 * k);
      return;
    }
    capsule.scale.setScalar(1);
    if (t < DISPENSE.roll) {
      const u = rollShare(t - DISPENSE.drop, DISPENSE.roll - DISPENSE.drop);
      track.pointAt(u, point);
      track.tangentAt(u, tangent);
      floorDown.copy(down).addScaledVector(tangent, -tangent.dot(down)).normalize();
      const clearance = GACHA.chuteRadius - GACHA.capsuleRadius - 0.0008;
      for (let i = 0; i < CHUTE_KNOCKS.length; i++) {
        if (u >= (CHUTE_KNOCKS[i] ?? 1) && fire(s, 1 + i)) {
          stepKick(capsuleSquash, 0.9);
          emit?.({ kind: 'knock', strength: 0.35 + 0.25 * i, at: at(capsule) });
        }
      }
      const rattle = Math.sin(t * 70) * 0.0006 * Math.min(1, u * 4);
      rollTo(
        point.x + floorDown.x * clearance,
        point.y + floorDown.y * clearance + rattle,
        point.z + floorDown.z * clearance,
        floorDown.x,
        floorDown.z,
      );
      rollU = u;
      return;
    }
    if (rollU < 1) {
      track.pointAt(1, mouth);
      track.tangentAt(1, tangent);
      floorDown.copy(down).addScaledVector(tangent, -tangent.dot(down)).normalize();
      mouth.addScaledVector(floorDown, GACHA.chuteRadius - GACHA.capsuleRadius - 0.0008);
      rollX = mouth.x;
      rollZ = mouth.z;
      rollU = 1;
    }
    if (t < DISPENSE.bounce) {
      const span = DISPENSE.bounce - DISPENSE.roll;
      const local = t - DISPENSE.roll;
      const k = easeOutCubic(local / span);
      const fall = Math.max(mouth.y - TRAY_REST.y, 0);
      for (let i = 0; i < LANDINGS.length; i++) {
        if (local >= (LANDINGS[i] ?? span) && fire(s, 4 + i)) {
          stepKick(capsuleSquash, i === 0 ? 2.6 : 1.2 / i);
          if (i === 0) stepKick(thump, 0.35);
          emit?.({ kind: 'land', strength: i === 0 ? 1 : 0.4 / i, at: at(capsule) });
        }
      }
      rollTo(
        rollX + (TRAY_REST.x - rollX) * k,
        TRAY_REST.y + bounceHeight(local, span, fall),
        rollZ + (TRAY_REST.z - rollZ) * k,
        0,
        0,
      );
      return;
    }
    capsule.position.copy(TRAY_REST);
    if (t >= DISPENSE.settle) finish();
  };

  const stepPop = (s: Sequence): void => {
    const t = s.time;
    const style = glowStrength;
    if (reduced) {
      if (t < POP_REDUCED.out) {
        capsuleMaterial.opacity.value = 1 - t / POP_REDUCED.out;
        return;
      }
      if (fire(s, 0)) {
        capsule.position.copy(POP_POINT);
        capsule.quaternion.identity();
        openPose(0.028, 1);
        placeGlow();
        glow.visible = true;
        glowMaterial.rays.value = glowRays * 0.6;
        glowMaterial.ring.value = 0;
        emit?.({ kind: 'pop', rarity: s.rarity, at: at(capsule) });
      }
      const k = easeInOutCubic((t - POP_REDUCED.out) / (POP_REDUCED.in - POP_REDUCED.out));
      capsuleMaterial.opacity.value = k;
      capsuleMaterial.innerGlow.value = 1.2 * k;
      glowMaterial.intensity.value = style * 0.62 * k;
      glow.scale.setScalar(glowSize);
      if (t >= POP_REDUCED.in) finish();
      return;
    }
    if (t < POP.lift) {
      const k = t / POP.lift;
      capsule.position.lerpVectors(liftFrom, POP_POINT, easeOutBack(1.3)(k));
      capsule.quaternion.slerpQuaternions(turnFrom, identity, easeInOutCubic(k));
      return;
    }
    capsule.position.copy(POP_POINT);
    capsule.quaternion.identity();
    if (t < POP.twist2) {
      const first = t < POP.twist2Start;
      const from = first ? POP.lift : POP.twist2Start;
      const to = first ? POP.twist1 : POP.twist2;
      const k = Math.min((t - from) / (to - from), 1);
      if (fire(s, first ? 0 : 1)) {
        stepKick(capsuleSquash, 0.8);
        emit?.({ kind: 'twist', step: first ? 1 : 2, at: at(capsule) });
      }
      const step = first ? 0 : 1;
      domeMesh.rotation.y = -0.9 * (step + easeOutBack(2)(k));
      domeMesh.position.y = 0.0007 * (step + k);
      const shudder = Math.sin(k * Math.PI * 7) * (1 - k) * 0.0011;
      capsule.position.x += shudder;
      capsuleMaterial.seamGlow.value = 0.18 + 0.5 * (step + k) * 0.5 + 0.06 * Math.sin(t * 40);
      glow.visible = true;
      placeGlow();
      glowMaterial.intensity.value = style * popGlow(t);
      glowMaterial.rays.value = glowRays * 0.3;
      glowMaterial.ring.value = 0;
      glow.scale.setScalar(glowSize * 0.45);
      return;
    }
    if (fire(s, 2)) {
      stepKick(thump, 1.1);
      stepKick(domeSquash, -2.4);
      agitation = Math.min(1, agitation + 0.6);
      lampFlash = 1;
      emit?.({ kind: 'pop', rarity: s.rarity, at: at(capsule) });
    }
    const since = t - POP.twist2;
    const k = Math.min(since / (POP.burst - POP.twist2), 1);
    const open = easeOutBack(2.2)(k);
    openPose(0.0014 + 0.027 * open, open);
    domeMesh.position.y += Math.sin(clock * 2.1) * 0.0009 * Math.min(since * 2, 1);
    capsuleMaterial.seamGlow.value = Math.max(0, 0.7 * (1 - k * 2));
    capsuleMaterial.innerGlow.value = 1.2 + 1.4 * Math.exp(-since * 4);
    placeGlow();
    glowMaterial.intensity.value = style * popGlow(t);
    glowMaterial.ring.value = Math.min(since / 0.55, 1);
    glowMaterial.rays.value = glowRays;
    glow.scale.setScalar(glowSize * (0.45 + 0.55 * easeOutBack(1.6)(Math.min(since / 0.3, 1))));
    if (t >= POP.settle) finish();
  };

  const stepOpen = (): void => {
    if (reduced) return;
    const breath = Math.sin(clock * 2.4);
    domeMesh.position.y = 0.0284 + Math.sin(clock * 2.1) * 0.0009;
    capsuleMaterial.innerGlow.value = 1.2 + breath * 0.12;
    glowMaterial.intensity.value = glowStrength * (0.62 + breath * 0.06);
    glowMaterial.ring.value = 1;
  };

  function stepKick(spring: SpringState, impulse: number): void {
    if (reduced) return;
    spring.velocity += impulse;
  }

  const step = (dt: number): void => {
    clock += dt;
    const target = (reduced ? crankProgress : detentTurns(crankProgress)) * Math.PI * 2;
    const before = crankAngle.value;
    if (reduced) stepSpring(crankAngle, target, 40, 1, dt);
    else stepSpring(crankAngle, target, 26, 0.42, dt);
    crankMesh.rotation.z = -crankAngle.value;
    const speed = dt > 0 ? Math.abs(crankAngle.value - before) / dt : 0;

    const detent = detentIndex(crankProgress);
    if (detent > lastDetent) {
      for (let d = lastDetent + 1; d <= detent; d++)
        emit?.({ kind: 'click', detent: d, at: at(crankMesh) });
      lampFlash = Math.max(lampFlash, 0.55);
      stepKick(thump, 0.16);
    }
    lastDetent = detent;

    if (!reduced) {
      agitation += (Math.min(speed * 0.09, 1) - agitation) * (1 - Math.exp(-dt * 9));
      if (agitation > 0.002) agitation *= Math.exp(-dt * 1.5);
      else agitation = 0;
    }
    stepSpring(thump, 0, 34, 0.32, dt);
    rig.scale.set(1 + thump.value * 0.006, 1 - thump.value * 0.012, 1 + thump.value * 0.006);
    if (!reduced) pileMesh.rotation.y = crankAngle.value * 0.16;
    animatePile();

    lampFlash *= Math.exp(-dt * 6);
    cabinet.lampLevel.value = 0.32 + lampFlash * 1.6;
    cabinet.lampColor.value.lerpColors(lampRest, rarityColor, phase === 'open' ? 0.55 : 0);

    if (capsule.visible) {
      stepSpring(capsuleSquash, 0, 48, 0.3, dt);
      stepSpring(domeSquash, 0, 40, 0.28, dt);
      const squash = capsuleSquash.value * 0.04;
      capsule.scale.set(1 + squash * 0.5, 1 - squash, 1 + squash * 0.5);
      const domeStretch = domeSquash.value * 0.03;
      domeMesh.scale.set(1 + domeStretch * 0.4, 1 - domeStretch, 1 + domeStretch * 0.4);
    }

    if (sequence) {
      sequence.time += dt;
      if (sequence.kind === 'dispense') stepDispense(sequence);
      else stepPop(sequence);
    } else if (phase === 'open') {
      stepOpen();
    }
    const drift = reduced ? 0.25 : 1;
    capsuleMaterial.time.value = clock * drift;
    glowMaterial.time.value = clock * drift;
    if (!reduced) glowMaterial.spin.value = clock * 0.35;
  };

  const animatePile = (): void => {
    if (agitation <= 0) {
      if (rattling) {
        rattling = false;
        writePile();
      }
      return;
    }
    rattling = true;
    const amp = agitation * 0.0026;
    for (let i = 0; i < pile.length; i++) {
      if (i === exitIndex && exitHidden) continue;
      const position = restPositions[i];
      const turn = restTurns[i];
      if (!position || !turn) continue;
      const phaseOffset = i * 1.618;
      const lift = position.y - GACHA.globe.centerY + GACHA.globe.radius;
      const freedom = Math.min(1, lift / (GACHA.globe.radius * 0.9));
      jitter
        .set(
          Math.sin(clock * 31 + phaseOffset) * amp * freedom,
          Math.abs(Math.sin(clock * 23 + phaseOffset * 1.3)) * amp * 1.4 * freedom,
          Math.cos(clock * 27 + phaseOffset * 0.7) * amp * freedom,
        )
        .add(position);
      wobbleAxis.set(Math.sin(phaseOffset), 0.4, Math.cos(phaseOffset)).normalize();
      wobble.setFromAxisAngle(wobbleAxis, Math.sin(clock * 19 + phaseOffset) * agitation * 0.35);
      wobble.multiply(turn);
      scratch.compose(jitter, wobble, one);
      pileMesh.setMatrixAt(i, scratch);
    }
    pileMesh.instanceMatrix.needsUpdate = true;
  };

  const busy = (): boolean =>
    sequence !== null ||
    phase === 'open' ||
    (phase === 'tray' && heirloom) ||
    agitation > 0 ||
    rattling ||
    lampFlash > 0.002 ||
    Math.abs(crankAngle.velocity) > 1e-3 ||
    Math.abs(
      crankAngle.value - (reduced ? crankProgress : detentTurns(crankProgress)) * Math.PI * 2,
    ) > 1e-4 ||
    Math.abs(thump.value) > 1e-4 ||
    Math.abs(thump.velocity) > 1e-3 ||
    Math.abs(capsuleSquash.value) > 1e-4 ||
    Math.abs(capsuleSquash.velocity) > 1e-3 ||
    Math.abs(domeSquash.value) > 1e-4 ||
    Math.abs(domeSquash.velocity) > 1e-3;

  const tick = (): void => {
    handle = null;
    if (disposed) return;
    const now = ticker.now();
    const dt = Math.min(Math.max((now - last) / 1000, 0), MAX_STEP);
    last = now;
    step(dt);
    if (busy()) handle = ticker.request(tick);
    else running = false;
  };

  const wake = (): void => {
    if (running || disposed) return;
    running = true;
    last = ticker.now();
    handle = ticker.request(tick);
  };

  const assertLive = (action: string): void => {
    if (disposed) throw new Error(`Gacha machine cannot ${action} after dispose()`);
  };

  const settle = (): void => {
    const pending = sequence;
    sequence = null;
    pending?.resolve();
  };

  const machine: GachaMachine = {
    object3d,
    crank(progress) {
      assertLive('crank');
      if (!Number.isFinite(progress))
        throw new Error(`Gacha crank progress must be a finite number, got ${progress}`);
      const next = Math.min(Math.max(progress, 0), 1);
      if (next < crankProgress) lastDetent = detentIndex(next);
      crankProgress = next;
      wake();
    },
    dispense(rarity) {
      if (disposed)
        return Promise.reject(new Error('Gacha machine cannot dispense after dispose()'));
      if (phase !== 'idle')
        return Promise.reject(
          new Error(`Gacha machine cannot dispense while ${phase}; call reset() first`),
        );
      return new Promise<void>((resolve) => {
        tintFor(rarity);
        closeCapsule();
        exitHidden = true;
        writePile();
        rollU = 0;
        capsule.quaternion.identity();
        if (reduced) {
          capsule.position.copy(TRAY_REST);
          capsuleMaterial.opacity.value = 0;
        } else {
          capsule.position.copy(restPositions[exitIndex] ?? TRAY_REST);
          agitation = Math.min(1, agitation + 0.5);
          lampFlash = Math.max(lampFlash, 0.8);
          stepKick(thump, 0.4);
        }
        capsule.visible = true;
        phase = 'dispensing';
        sequence = { kind: 'dispense', rarity, resolve, time: 0, fired: 0 };
        emit?.({ kind: 'drop', rarity, at: at(capsule) });
        wake();
      });
    },
    pop(rarity) {
      if (disposed) return Promise.reject(new Error('Gacha machine cannot pop after dispose()'));
      if (phase !== 'tray')
        return Promise.reject(
          new Error(
            phase === 'idle'
              ? 'Gacha machine has no capsule to pop; call dispense() first'
              : `Gacha machine cannot pop while ${phase}`,
          ),
        );
      return new Promise<void>((resolve) => {
        tintFor(rarity);
        liftFrom.copy(capsule.position);
        turnFrom.copy(capsule.quaternion);
        phase = 'popping';
        sequence = { kind: 'pop', rarity, resolve, time: 0, fired: 0 };
        wake();
      });
    },
    reset() {
      assertLive('reset');
      settle();
      phase = 'idle';
      capsule.visible = false;
      glow.visible = false;
      glowMaterial.intensity.value = 0;
      closeCapsule();
      exitHidden = false;
      heirloom = false;
      agitation = 0;
      rattling = false;
      lampFlash = 0;
      crankProgress = 0;
      lastDetent = 0;
      crankAngle.value = 0;
      crankAngle.velocity = 0;
      thump.value = 0;
      thump.velocity = 0;
      capsuleSquash.value = 0;
      capsuleSquash.velocity = 0;
      domeSquash.value = 0;
      domeSquash.velocity = 0;
      crankMesh.rotation.z = 0;
      pileMesh.rotation.y = 0;
      rig.scale.set(1, 1, 1);
      cabinet.lampLevel.value = 0.32;
      cabinet.lampColor.value.copy(lampRest);
      writePile();
    },
    dispose() {
      if (disposed) return;
      machine.reset();
      disposed = true;
      if (handle !== null) ticker.cancel(handle);
      handle = null;
      running = false;
      object3d.removeFromParent();
      for (const mesh of [body, crankMesh, pileMesh, glass, domeMesh, baseMesh])
        mesh.geometry.dispose();
      for (const material of [
        cabinet.material,
        glassMaterial,
        pileMaterial.material,
        capsuleMaterial.material,
        glowMaterial.material,
      ])
        material.dispose();
      pileMesh.dispose();
    },
  };

  return machine;
}
