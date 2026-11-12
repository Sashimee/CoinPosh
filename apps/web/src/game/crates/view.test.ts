import {
  RARITIES,
  RollSchema,
  WalletSchema,
  type CrateId,
  type Roll,
  type TableCrate,
} from '@coinposh/shared';
import {
  AdditiveBlending,
  Group,
  PerspectiveCamera,
  Vector3,
  Mesh,
  MeshBasicNodeMaterial,
  MeshPhysicalNodeMaterial,
  type Material,
  type Node,
  type Object3D,
} from 'three/webgpu';
import {
  cameraPosition,
  modelViewMatrix,
  modelWorldMatrix,
  normalLocal,
  normalView,
  normalWorld,
  positionLocal,
  positionView,
  positionViewDirection,
  positionWorld,
} from 'three/tsl';
import { describe, expect, it } from 'vitest';
import { createBus } from '../../app/bus.ts';
import type { CrateEvents } from './events.ts';
import { UnboxAssets, UnboxStage } from '../../vfx/cinematics/unbox/index.ts';
import { RARITY_COLORS, VFX_COLORS } from '../../vfx/palette.ts';
import { CrateRide } from './ride.ts';
import {
  crateShine,
  GLINT_OFF,
  GLINT_REST,
  GLINT_STILL,
  seamColor,
  STATIC_GLOW,
  TableCrateView,
  UnboxDirector,
  type OpenedCrate,
  type UnboxCard,
} from './view.ts';

const FRAME = 1 / 60;

function crateId(n: number): CrateId {
  return `crate-${String(n)}` as CrateId;
}

function materialsUnder(root: Object3D): Set<Material> {
  const found = new Set<Material>();
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    const material = object.material as Material | Material[];
    for (const one of Array.isArray(material) ? material : [material]) found.add(one);
  });
  return found;
}

function meshesUnder(root: Object3D): Mesh[] {
  const found: Mesh[] = [];
  root.traverse((object) => {
    if (object instanceof Mesh) found.push(object as Mesh);
  });
  return found;
}

/** Nodes whose value changes with where the crate sits or where the camera looks from. */
const VIEW_OR_WORLD: readonly Node[] = [
  cameraPosition,
  modelViewMatrix,
  modelWorldMatrix,
  normalView,
  normalWorld,
  positionView,
  positionViewDirection,
  positionWorld,
];

function reaches(root: Node, targets: readonly Node[]): boolean {
  const wanted = new Set<unknown>(targets);
  let found = false;
  root.traverse((node) => {
    if (wanted.has(node)) found = true;
  });
  return found;
}

function unboxAccent(rarity: (typeof RARITIES)[number]): string {
  const assets = new UnboxAssets(new Group());
  const stage = new UnboxStage(rarity, 'coins', assets);
  const hex = `#${assets.seamMaterial.color.getHexString().toUpperCase()}`;
  stage.dispose();
  assets.dispose();
  return hex;
}

describe('crate seam colour', () => {
  it('glows white gold while the crate is sealed, before the server has rolled it', () => {
    expect(seamColor(null)).toBe(VFX_COLORS.whiteGold);
  });

  it.each(RARITIES)('glows the %s accent its unbox seam and rays use', (rarity) => {
    expect(seamColor(rarity)).toBe(unboxAccent(rarity));
  });

  it('keeps every rolled rarity distinct from the sealed glow', () => {
    for (const rarity of RARITIES) expect(seamColor(rarity)).not.toBe(seamColor(null));
  });

  it('reads the rarity palette rather than its own colours', () => {
    for (const rarity of RARITIES.filter((r) => r !== 'heirloom')) {
      expect(seamColor(rarity)).toBe(RARITY_COLORS[rarity]);
    }
  });
});

describe('crate shine', () => {
  it('holds one glow and a still, softer glint under reduced motion, riding or teetering', () => {
    for (let age = 0; age < 12; age += 0.05) {
      for (const teeter of [false, true]) {
        expect(crateShine(age, teeter, true)).toEqual({
          glow: STATIC_GLOW,
          sweep: GLINT_REST,
          glint: GLINT_STILL,
        });
      }
    }
  });

  it('rests the reduced-motion glint on the trim, where the full sweep passes, at under half strength', () => {
    const swept: number[] = [];
    for (let age = 0; age < 4; age += FRAME) {
      const { sweep } = crateShine(age, false, false);
      if (sweep !== GLINT_OFF) swept.push(sweep);
    }
    expect(GLINT_REST).toBeGreaterThan(Math.min(...swept));
    expect(GLINT_REST).toBeLessThan(Math.max(...swept));
    expect(GLINT_STILL).toBeGreaterThan(0);
    expect(GLINT_STILL).toBeLessThan(0.5);
  });

  it('runs the full-motion glint at full strength whether it is sweeping or parked', () => {
    for (let age = 0; age < 8; age += 0.05) {
      expect(crateShine(age, false, false).glint).toBe(1);
      expect(crateShine(age, true, false).glint).toBe(1);
    }
  });

  it('sweeps a glint right after the crate lands, then parks it until the next one', () => {
    expect(crateShine(0.1, false, false).sweep).toBe(GLINT_OFF);
    const sweeps = [0.4, 0.6, 0.8, 1.0].map((age) => crateShine(age, false, false).sweep);
    for (const sweep of sweeps) expect(sweep).not.toBe(GLINT_OFF);
    for (let i = 1; i < sweeps.length; i++) expect(sweeps[i]).toBeGreaterThan(sweeps[i - 1] ?? 0);
    expect(crateShine(2, false, false).sweep).toBe(GLINT_OFF);
  });

  it('glints slowly: a short sweep in a cycle of a few seconds, every cycle', () => {
    const lit: number[] = [];
    for (let frame = 0; frame < 60 * 12; frame++) {
      if (crateShine(frame * FRAME, false, false).sweep !== GLINT_OFF) lit.push(frame);
    }
    const starts = lit.filter((frame, i) => i === 0 || frame - (lit[i - 1] ?? 0) > 1);
    expect(starts.length).toBeGreaterThanOrEqual(3);
    expect(starts.length).toBeLessThanOrEqual(4);
    expect(lit.length / (60 * 12)).toBeLessThan(0.25);
  });

  it('breathes the seam gently while riding and runs it hot while teetering', () => {
    let quietest = Infinity;
    let brightest = 0;
    let coolestTeeter = Infinity;
    for (let age = 0; age < 8; age += FRAME) {
      const glow = crateShine(age, false, false).glow;
      quietest = Math.min(quietest, glow);
      brightest = Math.max(brightest, glow);
      coolestTeeter = Math.min(coolestTeeter, crateShine(age, true, false).glow);
    }
    expect(quietest).toBeGreaterThan(0.7);
    expect(brightest).toBeLessThanOrEqual(1);
    expect(brightest - quietest).toBeGreaterThan(0.15);
    expect(coolestTeeter).toBeGreaterThan(brightest);
  });

  it('treats a negative age as a crate that just arrived', () => {
    expect(crateShine(-3, false, false)).toEqual(crateShine(0, false, false));
  });
});

describe('TableCrateView', () => {
  const crate = (n: number): TableCrate => ({ id: crateId(n), kind: 'vault' });

  it('seals a new crate in white gold and takes the rolled rarity colour once known', () => {
    const view = new TableCrateView(new Group());
    view.spawn(crateId(1));
    expect(view.seamOf(crateId(1))).toBe(VFX_COLORS.whiteGold);
    view.rolled(crateId(1), 'exquisite');
    expect(view.seamOf(crateId(1))).toBe(RARITY_COLORS.exquisite);
    view.rolled(crateId(2), 'rare');
    expect(view.seamOf(crateId(2))).toBeNull();
    view.dispose();
  });

  it('draws every crate of every rarity with the materials it built at boot', () => {
    const parent = new Group();
    const view = new TableCrateView(parent);
    const atBoot = materialsUnder(parent);
    expect(atBoot.size).toBe(3);
    RARITIES.forEach((rarity, i) => {
      view.spawn(crateId(i));
      view.rolled(crateId(i), rarity);
    });
    view.update(FRAME, [], false);
    expect(materialsUnder(parent)).toEqual(atBoot);
    view.dispose();
  });

  it('keeps a sub-pixel standby crate drawn until the first crate spawns, then retires it', () => {
    const parent = new Group();
    const view = new TableCrateView(parent);
    const standby = parent.getObjectByName('crate:standby');
    expect(standby).toBeDefined();
    expect(standby?.scale.x).toBeLessThan(0.01);
    for (const mesh of meshesUnder(parent)) {
      expect(mesh.visible).toBe(true);
      expect(mesh.frustumCulled).toBe(false);
    }
    expect(meshesUnder(parent).some((mesh) => mesh.castShadow)).toBe(true);
    view.spawn(crateId(1));
    expect(parent.getObjectByName('crate:standby')).toBeUndefined();
    expect(parent.children.map((child) => child.name)).toEqual([`crate:${crateId(1)}`]);
    view.dispose();
    expect(parent.children).toHaveLength(0);
  });

  it('self-lights the lacquer sheen and the gold trim from the crate alone, never the camera or venue', () => {
    const parent = new Group();
    const view = new TableCrateView(parent);
    view.spawn(crateId(1));
    const [lacquer, gold, seam] = meshesUnder(parent).map((mesh) => mesh.material);
    if (!(lacquer instanceof MeshPhysicalNodeMaterial)) throw new Error('lacquer is not physical');
    if (!(gold instanceof MeshPhysicalNodeMaterial)) throw new Error('gold is not physical');
    if (!(seam instanceof MeshBasicNodeMaterial)) throw new Error('seam is not a basic material');
    if (!lacquer.emissiveNode || !gold.emissiveNode || !seam.colorNode) {
      throw new Error('crate materials lost their self-light');
    }
    expect(reaches(normalView.dot(positionViewDirection), VIEW_OR_WORLD)).toBe(true);
    expect(reaches(positionWorld.y, VIEW_OR_WORLD)).toBe(true);
    for (const node of [lacquer.emissiveNode, gold.emissiveNode, seam.colorNode]) {
      expect(reaches(node, VIEW_OR_WORLD)).toBe(false);
    }
    expect(reaches(lacquer.emissiveNode, [normalLocal])).toBe(true);
    expect(reaches(lacquer.emissiveNode, [positionLocal])).toBe(true);
    expect(lacquer.specularIntensity).toBe(0);
    expect(lacquer.clearcoat).toBe(0);
    expect(gold.metalness).toBe(1);
    expect(seam.blending).toBe(AdditiveBlending);
    expect(seam.depthWrite).toBe(false);
    view.dispose();
  });

  it('builds the crate as a bevelled body, a gold trim frame and a glowing seam', () => {
    const parent = new Group();
    const view = new TableCrateView(parent);
    view.spawn(crateId(1));
    const meshes = meshesUnder(parent);
    expect(meshes).toHaveLength(3);
    const [body, trim, seam] = meshes;
    const box = (mesh: Mesh | undefined) => {
      mesh?.geometry.computeBoundingBox();
      const bounds = mesh?.geometry.boundingBox;
      if (!bounds) throw new Error('crate mesh has no bounds');
      return bounds;
    };
    const bodyBox = box(body);
    expect(box(trim).max.x).toBeGreaterThan(bodyBox.max.x);
    expect(box(trim).max.y).toBeGreaterThan(bodyBox.max.y);
    expect(box(trim).max.z).toBeGreaterThan(bodyBox.max.z);
    expect(box(seam).max.x).toBeGreaterThan(bodyBox.max.x);
    expect(box(seam).min.y).toBeGreaterThan(bodyBox.min.y + (bodyBox.max.y - bodyBox.min.y) / 2);
    expect((body?.geometry.getAttribute('position').count ?? 0) > 24).toBe(true);
    view.dispose();
  });

  it('holds the glow and the glint still under reduced motion', () => {
    const view = new TableCrateView(new Group());
    const ride = new CrateRide(crate(1), 0);
    view.spawn(crateId(1));
    for (let frame = 0; frame < 600; frame++) {
      ride.update(FRAME, (frame % 120) / 120);
      view.update(FRAME, [ride], true);
      expect(view.shineOf(crateId(1))).toEqual({
        glow: STATIC_GLOW,
        sweep: GLINT_REST,
        glint: GLINT_STILL,
      });
    }
    view.dispose();
  });

  it('glints and breathes with full motion, and keeps shining as it tumbles into the tray', () => {
    const view = new TableCrateView(new Group());
    const ride = new CrateRide(crate(1), 0);
    view.spawn(crateId(1));
    const sweeps = new Set<number>();
    const glows = new Set<number>();
    for (let frame = 0; frame < 240; frame++) {
      view.update(FRAME, [ride], false);
      const shine = view.shineOf(crateId(1));
      if (!shine) throw new Error('spawned crate has no shine');
      if (shine.sweep !== GLINT_OFF) sweeps.add(shine.sweep);
      glows.add(shine.glow);
      expect(shine.glint).toBe(1);
    }
    expect(sweeps.size).toBeGreaterThan(10);
    expect(glows.size).toBeGreaterThan(10);
    view.fall(crateId(1), ride.position);
    view.update(FRAME, [], false);
    expect(view.shineOf(crateId(1))?.glow).toBeGreaterThan(0.7);
    expect(view.shineOf(crateId(9))).toBeNull();
    view.dispose();
  });
});

describe('UnboxDirector held by an open sheet', () => {
  const FRAMING = { position: new Vector3(0, 0.5, 0.6), target: new Vector3(0, 0, -0.05), fov: 40 };
  const roll: Roll = RollSchema.parse({
    rarity: 'fine',
    rewards: [{ kind: 'currency', currency: 'pearls', amount: 25 }],
    proof: { serverSeedHash: 'a'.repeat(64), clientSeed: 'velvet', nonce: 1 },
    pity: { rare: 0, exquisite: 0, legendary: 0 },
  });
  const wallet = WalletSchema.parse({
    coins: 10,
    bullion: 0,
    goldBars: 0,
    pearls: 25,
    keys: 0,
    tickets: 0,
    stars: 0,
  });
  const A = 'crate_AAAAAAAAAAAAAAAA' as CrateId;
  const B = 'crate_BBBBBBBBBBBBBBBB' as CrateId;
  const opened = (crateId: CrateId): OpenedCrate => ({
    crateId,
    roll,
    wallet,
    at: new Vector3(0, -0.075, 0.085),
  });

  function director() {
    const events = createBus<CrateEvents>();
    const started: CrateId[] = [];
    const cards: { crateId: CrateId; shown: boolean; holds: boolean[]; disposed: boolean }[] = [];
    const waiting: number[] = [];
    const collected: CrateId[] = [];
    events.on('crate:waiting', ({ count }) => waiting.push(count));
    events.on('crate:collected', ({ crateId }) => collected.push(crateId));
    const unbox = new UnboxDirector({
      parent: new Group(),
      camera: new PerspectiveCamera(40, 9 / 16),
      framing: () => FRAMING,
      events,
      reducedMotion: () => false,
      onStart: (crateId) => started.push(crateId),
      card: (crate): UnboxCard => {
        const card = {
          crateId: crate.crateId,
          shown: false,
          holds: [] as boolean[],
          disposed: false,
        };
        cards.push(card);
        return {
          get shown() {
            return card.shown;
          },
          show: () => {
            card.shown = true;
          },
          hold: (held) => card.holds.push(held),
          dispose: () => {
            card.disposed = true;
          },
        };
      },
    });
    /** Plays the current unbox through to its card, collects it and lets it leave. */
    const playOut = () => {
      for (let i = 0; i < 600 && !unbox.cinematic?.revealed; i++) unbox.update(FRAME);
      unbox.collect();
      for (let i = 0; i < 600 && unbox.cinematic && !unbox.cinematic.done; i++) unbox.update(FRAME);
      unbox.update(FRAME);
    };
    return { unbox, started, cards, waiting, collected, playOut };
  }

  it('keeps a crate that opens behind a sheet in the queue, unplayed, and reports it ready', () => {
    const { unbox, started, cards, waiting } = director();
    unbox.hold(true);
    unbox.enqueue(opened(A));
    expect(unbox.active).toBeNull();
    expect(unbox.cinematic).toBeNull();
    expect(unbox.waiting).toBe(1);
    for (let i = 0; i < 300; i++) unbox.update(FRAME);
    expect(unbox.active).toBeNull();
    expect(started).toEqual([]);
    expect(cards).toEqual([]);
    unbox.enqueue(opened(B));
    expect(waiting).toEqual([1, 2]);
    unbox.dispose();
  });

  it('starts the first waiting crate the moment the sheet closes, then the rest in order', () => {
    const { unbox, started, waiting, collected, playOut } = director();
    unbox.hold(true);
    unbox.enqueue(opened(A));
    unbox.enqueue(opened(B));
    unbox.hold(false);
    expect(unbox.active).toBe(A);
    expect(unbox.cinematic?.elapsed).toBe(0);
    expect(started).toEqual([A]);
    expect(unbox.waiting).toBe(1);
    expect(waiting).toEqual([1, 2, 0]);
    playOut();
    expect(collected).toEqual([A]);
    expect(unbox.active).toBe(B);
    playOut();
    expect(collected).toEqual([A, B]);
    expect(started).toEqual([A, B]);
    expect(unbox.active).toBeNull();
    unbox.dispose();
  });

  it('never starts a crate twice, however often the sheet opens and closes', () => {
    const { unbox, started, cards, playOut } = director();
    unbox.hold(true);
    unbox.enqueue(opened(A));
    unbox.hold(true);
    unbox.hold(false);
    unbox.hold(false);
    unbox.hold(true);
    unbox.hold(false);
    unbox.enqueue(opened(B));
    expect(started).toEqual([A]);
    expect(cards.map((card) => card.crateId)).toEqual([A]);
    expect(unbox.active).toBe(A);
    playOut();
    expect(started).toEqual([A, B]);
    unbox.dispose();
  });

  it('plays at once with no sheet open, as before', () => {
    const { unbox, started, waiting } = director();
    unbox.enqueue(opened(A));
    expect(unbox.active).toBe(A);
    expect(started).toEqual([A]);
    expect(waiting).toEqual([]);
    unbox.dispose();
  });

  it('freezes an unbox a sheet opens over, hides its card and takes no skip or collect', () => {
    const { unbox, cards, waiting, collected } = director();
    unbox.enqueue(opened(A));
    for (let i = 0; i < 600 && !unbox.cinematic?.revealed; i++) unbox.update(FRAME);
    const [card] = cards;
    expect(card?.shown).toBe(true);
    unbox.hold(true);
    expect(card?.holds).toEqual([true]);
    expect(waiting).toEqual([1]);
    const frozenAt = unbox.cinematic?.elapsed;
    for (let i = 0; i < 300; i++) unbox.update(FRAME);
    expect(unbox.cinematic?.elapsed).toBe(frozenAt);
    unbox.skip();
    unbox.collect();
    expect(collected).toEqual([]);
    expect(unbox.active).toBe(A);

    unbox.hold(false);
    expect(card?.holds).toEqual([true, false]);
    expect(waiting).toEqual([1, 0]);
    unbox.collect();
    expect(collected).toEqual([A]);
    unbox.dispose();
  });

  it('freezes the 3D beats before the reveal too, and resumes them where they stopped', () => {
    const { unbox, cards } = director();
    unbox.enqueue(opened(A));
    unbox.update(0.2);
    const before = unbox.cinematic?.elapsed ?? 0;
    expect(before).toBeGreaterThan(0);
    unbox.hold(true);
    unbox.update(5);
    expect(unbox.cinematic?.elapsed).toBe(before);
    expect(cards[0]?.shown).toBe(false);
    unbox.hold(false);
    unbox.update(0.1);
    expect(unbox.cinematic?.elapsed).toBeGreaterThan(before);
    unbox.dispose();
  });

  it('starts nothing once disposed, even when the sheet closes after', () => {
    const { unbox, started } = director();
    unbox.hold(true);
    unbox.enqueue(opened(A));
    unbox.dispose();
    unbox.hold(false);
    unbox.enqueue(opened(B));
    expect(started).toEqual([]);
    expect(unbox.active).toBeNull();
  });
});
