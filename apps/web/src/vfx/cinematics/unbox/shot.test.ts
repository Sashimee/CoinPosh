import { CollectibleIdSchema, RARITIES, ScratchCardIdSchema } from '@coinposh/shared';
import { Color, Group, Mesh, UniformNode, Vector3, type Node } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { heroOf } from '../../../game/crates/loot.ts';
import { flatEmbossTexture } from '../../../scene/coins/materials.ts';
import { rivieraCameraPreset } from '../../../scene/venues/riviera/layout.ts';
import { HEIRLOOM_PRISM, RARITY_COLORS } from '../../palette.ts';
import {
  CAP_TOP,
  ENAMEL_DEPTH,
  ENAMEL_MAX_LUMA,
  heroEnamel,
  HERO_FACE_TIERS,
  HERO_MAX_PITCH,
  HERO_PROPS,
  heroGeometry,
  HeroPart,
  heroPitch,
  heroYaw,
  ITEM_SIZE,
  PEDESTAL_CAP_HALF,
  UNBOX_HEROES,
  type HeroPartId,
  type UnboxHero,
} from './hero.ts';
import { FULL_UNBOX, REDUCED_UNBOX, unboxPose, type UnboxPose } from './plan.ts';
import { unboxShot } from './shot.ts';
import { UnboxAssets, UnboxStage } from './stage.ts';

const PORTRAIT = 390 / 844;
const vertex = new Vector3();
const LANDSCAPE = 844 / 390;

describe('unboxShot memo', () => {
  it('hands back the same shot for the same framing, aspect and variant', () => {
    const first = unboxShot(rivieraCameraPreset(PORTRAIT), PORTRAIT, false);
    const again = unboxShot(rivieraCameraPreset(PORTRAIT), PORTRAIT, false);
    expect(again).toBe(first);
  });

  it('frames each variant and aspect on its own', () => {
    const full = unboxShot(rivieraCameraPreset(LANDSCAPE), LANDSCAPE, false);
    const reduced = unboxShot(rivieraCameraPreset(LANDSCAPE), LANDSCAPE, true);
    const portrait = unboxShot(rivieraCameraPreset(PORTRAIT), PORTRAIT, false);
    expect(reduced).not.toBe(full);
    expect(portrait).not.toBe(full);
    expect(reduced.center.distanceTo(full.center)).toBeGreaterThan(1e-4);
  });

  it('re-frames when the framing itself moves at the same aspect', () => {
    const framing = rivieraCameraPreset(PORTRAIT);
    const base = unboxShot(framing, PORTRAIT, false);
    const raised = {
      ...framing,
      position: framing.position.clone().add(new Vector3(0, 0.05, 0)),
    };
    const moved = unboxShot(raised, PORTRAIT, false);
    expect(moved).not.toBe(base);
    expect(moved.center.y - base.center.y).toBeGreaterThan(0.01);
  });

  it('keeps every shot of a long session framed after the memo starts evicting', () => {
    const first = unboxShot(rivieraCameraPreset(PORTRAIT), PORTRAIT, true);
    for (let i = 0; i < 40; i++) {
      const aspect = 0.4 + i * 0.05;
      unboxShot(rivieraCameraPreset(aspect), aspect, true);
    }
    const refit = unboxShot(rivieraCameraPreset(PORTRAIT), PORTRAIT, true);
    expect(refit.center.distanceTo(first.center)).toBeLessThan(1e-12);
    expect(refit.yaw).toBe(first.yaw);
  });
});

function partsOf(hero: UnboxHero): number[] {
  const ids = heroGeometry(hero).getAttribute('heroPart');
  const seen = new Set<number>();
  for (let i = 0; i < ids.count; i++) seen.add(ids.getX(i));
  return [...seen].sort();
}

function faceTriangles(hero: UnboxHero): number {
  const ids = heroGeometry(hero).getAttribute('heroPart');
  let count = 0;
  for (let i = 0; i < ids.count; i += 3) if (ids.getX(i) === HeroPart.coinFace) count++;
  return count;
}

function boundsOf(hero: UnboxHero) {
  const geometry = heroGeometry(hero);
  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  if (!box) throw new Error(`hero ${hero} built no bounding box`);
  return box;
}

/** The value of every uniform and texture `root` reads, walking its node graph once per node. */
function uniformValues(root: Node | null): unknown[] {
  if (!root) throw new Error('The hero material has no node graph where one was expected');
  const seen = new Set<Node>();
  const queue: Node[] = [root];
  const values: unknown[] = [];
  for (let node = queue.pop(); node; node = queue.pop()) {
    if (seen.has(node)) continue;
    seen.add(node);
    if (node instanceof UniformNode) values.push(node.value);
    queue.push(...node.getChildren());
  }
  return values;
}

function colorUniforms(root: Node | null): Color[] {
  return uniformValues(root).filter((value): value is Color => value instanceof Color);
}

function near(a: Color, b: Color): boolean {
  return Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b) < 1e-6;
}

const EXPECTED_PARTS: Readonly<Record<UnboxHero, readonly HeroPartId[]>> = {
  card: [HeroPart.coinFace, HeroPart.gold, HeroPart.enamel],
  coins: [HeroPart.coinFace, HeroPart.gold],
  pearls: [HeroPart.pearl, HeroPart.enamel, HeroPart.gold],
  keys: [HeroPart.gold, HeroPart.enamel],
  tickets: [HeroPart.ticket],
  charm: [HeroPart.gem, HeroPart.gold],
  safe: [HeroPart.lacquer, HeroPart.enamel, HeroPart.gold],
};

describe('unbox hero props', () => {
  it('maps every hero to its own recognisable prop', () => {
    expect(Object.keys(HERO_PROPS).sort()).toEqual([...UNBOX_HEROES].sort());
    expect(HERO_PROPS.card.prop).toBe('collector-card');
    expect(HERO_PROPS.charm.prop).toBe('charm-pendant');
    expect(HERO_PROPS.coins.prop).toBe('coin-stack');
    const props = UNBOX_HEROES.map((hero) => HERO_PROPS[hero].prop);
    expect(new Set(props).size).toBe(UNBOX_HEROES.length);
  });

  it.each(UNBOX_HEROES)('builds %s from exactly its surfaces', (hero) => {
    expect(partsOf(hero)).toEqual([...EXPECTED_PARTS[hero]].sort());
  });

  it('shows a scratch card and an album coin alike as an upright collector card', () => {
    const scratchCard = ScratchCardIdSchema.parse('scratch_a1b2c3d4');
    const collectibleId = CollectibleIdSchema.parse('duchess-sovereign-1891');
    expect(heroOf([{ kind: 'scratchCard', cardId: scratchCard }])).toBe('card');
    expect(heroOf([{ kind: 'collectible', collectibleId }])).toBe('card');
    expect(HERO_PROPS.card.prop).toBe('collector-card');
    expect(partsOf('card')).toContain(HeroPart.enamel);
    const size = boundsOf('card').getSize(new Vector3());
    expect(size.y).toBeGreaterThan(size.x * 1.2);
    expect(size.z).toBeLessThan(size.x * 0.3);
  });

  it('stacks several struck coin faces where a collection coin shows one', () => {
    expect(faceTriangles('card')).toBeGreaterThan(0);
    expect(faceTriangles('coins')).toBeGreaterThan(faceTriangles('card') * 2);
    expect(partsOf('coins')).toContain(HeroPart.gold);
  });

  it.each(UNBOX_HEROES)('keeps %s hero-sized and facing the camera', (hero) => {
    const size = boundsOf(hero).getSize(new Vector3());
    for (const extent of [size.x, size.y, size.z]) {
      expect(extent).toBeLessThanOrEqual(ITEM_SIZE * 2.8);
    }
    expect(Math.max(size.x, size.y)).toBeGreaterThan(ITEM_SIZE * 1.2);
  });

  it('puts the cap top a cap half thickness over the hero origin less ITEM_SIZE', () => {
    expect(CAP_TOP).toBeCloseTo(-ITEM_SIZE + PEDESTAL_CAP_HALF, 12);
    const stage = new UnboxStage('common', 'safe', new UnboxAssets(new Group()));
    const cap = stage.capObject as Mesh;
    cap.geometry.computeBoundingBox();
    const top = cap.position.y + (cap.geometry.boundingBox?.max.y ?? NaN);
    expect(top - stage.heroObject.position.y).toBeCloseTo(CAP_TOP, 9);
  });

  it.each(UNBOX_HEROES)('keeps %s clear of the cap at every tilt a camera above asks', (hero) => {
    for (let step = 0; step <= 20; step++) {
      const pitch = HERO_PROPS[hero].rests ? 0 : (-HERO_MAX_PITCH * step) / 20;
      const geometry = heroGeometry(hero);
      geometry.rotateX(pitch);
      geometry.computeBoundingBox();
      const box = geometry.boundingBox;
      if (!box) throw new Error(`hero ${hero} built no bounding box`);
      expect(box.min.y).toBeGreaterThanOrEqual(-ITEM_SIZE + PEDESTAL_CAP_HALF - 1e-9);
      expect(box.max.y).toBeLessThanOrEqual(ITEM_SIZE * 2.2);
    }
  });

  it('stands resting props level on the cap top and hovers floating ones just over it', () => {
    for (const hero of UNBOX_HEROES) {
      const box = boundsOf(hero);
      if (HERO_PROPS[hero].rests) {
        expect(box.min.y).toBeCloseTo(CAP_TOP, 9);
        expect(heroPitch(hero, 0.8)).toBe(0);
      } else {
        expect(box.min.y).toBeGreaterThan(CAP_TOP);
        expect(heroPitch(hero, 0.8)).toBeLessThan(-0.3);
        const lowest = Math.min(
          ...Array.from({ length: 11 }, (_, i) => {
            const geometry = heroGeometry(hero);
            geometry.rotateX((-HERO_MAX_PITCH * i) / 10);
            geometry.computeBoundingBox();
            return geometry.boundingBox?.min.y ?? NaN;
          }),
        );
        expect(lowest - CAP_TOP).toBeLessThan(ITEM_SIZE * 0.25);
      }
    }
  });

  it('fits the key inside 0.9 ITEM_SIZE either side, so it never sinks into the cap', () => {
    const size = boundsOf('keys').getSize(new Vector3());
    for (const extent of [size.x, size.y, size.z])
      expect(extent).toBeLessThanOrEqual(ITEM_SIZE * 1.8 * (1 + 1e-6));
  });

  it('opens the key bow instead of filling it with an enamel lens', () => {
    const geometry = heroGeometry('keys');
    const position = geometry.getAttribute('position');
    const ids = geometry.getAttribute('heroPart');
    const box = boundsOf('keys');
    const span = Math.max(box.max.x - box.min.x, box.max.y - box.min.y);
    const jewel = new Vector3();
    const low = new Vector3(Infinity, Infinity, Infinity);
    const high = new Vector3(-Infinity, -Infinity, -Infinity);
    let count = 0;
    for (let i = 0; i < ids.count; i++) {
      if (ids.getX(i) !== HeroPart.enamel) continue;
      jewel.fromBufferAttribute(position, i);
      low.min(jewel);
      high.max(jewel);
      count++;
    }
    expect(count).toBeGreaterThan(0);
    expect(Math.max(high.x - low.x, high.y - low.y)).toBeLessThan(span * 0.18);
  });

  it.each([
    ['portrait', PORTRAIT],
    ['landscape', LANDSCAPE],
  ] as const)('stages every hero over the cap through the %s reveal', (_, aspect) => {
    for (const reduced of [false, true]) {
      const shot = unboxShot(rivieraCameraPreset(aspect), aspect, reduced);
      const timeline = reduced ? REDUCED_UNBOX : FULL_UNBOX;
      for (const hero of UNBOX_HEROES) {
        const assets = new UnboxAssets(new Group());
        const stage = new UnboxStage('rare', hero, assets);
        stage.face(shot.yaw, shot.toCamera);
        const item = stage.heroObject as Mesh;
        const cap = stage.capObject as Mesh;
        cap.geometry.computeBoundingBox();
        const capTop = cap.position.y + (cap.geometry.boundingBox?.max.y ?? NaN);
        for (let ms = timeline.revealAtMs; ms < timeline.revealAtMs + 3_000; ms += 250) {
          stage.apply(unboxPose(ms, timeline, reduced));
          item.updateMatrix();
          const position = item.geometry.getAttribute('position');
          let lowest = Infinity;
          for (let i = 0; i < position.count; i++)
            lowest = Math.min(
              lowest,
              vertex.fromBufferAttribute(position, i).applyMatrix4(item.matrix).y,
            );
          expect(lowest).toBeGreaterThanOrEqual(capTop - 1e-9);
          if (HERO_PROPS[hero].rests) expect(lowest).toBeCloseTo(capTop, 9);
        }
        assets.dispose();
      }
    }
  });

  it('draws the pedestal cap in the hero pipeline as its own deep gold part', () => {
    const assets = new UnboxAssets(new Group());
    const stage = new UnboxStage('common', 'coins', assets);
    const cap = stage.capObject as Mesh;
    expect(cap.material).toBe(assets.heroMaterial);
    const ids = cap.geometry.getAttribute('heroPart');
    for (let i = 0; i < ids.count; i++) expect(ids.getX(i)).toBe(HeroPart.plinth);
    for (const hero of UNBOX_HEROES) expect(partsOf(hero)).not.toContain(HeroPart.plinth);
    assets.dispose();
  });

  it('shields the risen hero from the burst flare and key, as reduced motion reveals it', () => {
    const rest = unboxPose(REDUCED_UNBOX.revealAtMs, REDUCED_UNBOX, true);
    expect(rest.pedestal).toBe(1);
    expect(rest.burst).toBeGreaterThan(0.5);
    const sunk: UnboxPose = { ...rest, pedestal: 0 };
    const lit = (pose: UnboxPose) => {
      const assets = new UnboxAssets(new Group());
      const stage = new UnboxStage('common', 'card', assets);
      stage.apply(pose);
      const levels = { flare: stage.flareLevel, light: stage.lightIntensity };
      assets.dispose();
      return levels;
    };
    const shielded = lit(rest);
    const open = lit(sunk);
    expect(shielded.flare).toBeLessThan(open.flare * 0.6);
    expect(shielded.light).toBeLessThan(open.light * 0.6);
    expect(shielded.flare).toBeGreaterThan(0);
  });

  it.each(RARITIES)('deepens the %s enamel and keeps its hue under the luma cap', (rarity) => {
    const accent = new Color(rarity === 'heirloom' ? HEIRLOOM_PRISM[0] : RARITY_COLORS[rarity]);
    const enamel = heroEnamel(accent, new Color());
    const luma = 0.2126 * enamel.r + 0.7152 * enamel.g + 0.0722 * enamel.b;
    expect(luma).toBeLessThanOrEqual(ENAMEL_MAX_LUMA + 1e-9);
    expect(enamel.r).toBeLessThanOrEqual(accent.r * ENAMEL_DEPTH + 1e-9);
    const ratio = enamel.g / accent.g;
    expect(enamel.r / accent.r).toBeCloseTo(ratio, 6);
    expect(enamel.b / accent.b).toBeCloseTo(ratio, 6);
    if (rarity === 'rare') expect(ratio).toBeCloseTo(ENAMEL_DEPTH, 6);
  });

  it.each(RARITIES)('shades the hero material in the %s palette colour', (rarity) => {
    const expected = new Color(rarity === 'heirloom' ? HEIRLOOM_PRISM[0] : RARITY_COLORS[rarity]);
    const enamel = heroEnamel(expected, new Color());
    for (const hero of ['charm', 'card', 'coins'] as const) {
      const assets = new UnboxAssets(new Group());
      const stage = new UnboxStage(rarity, hero, assets);
      const { heroMaterial: material } = assets;
      expect(stage.heroObject).toBeInstanceOf(Mesh);
      expect((stage.heroObject as Mesh).material).toBe(material);
      expect(assets.heroAccent.getHex()).toBe(expected.getHex());
      expect(colorUniforms(material.emissiveNode)).toContain(assets.heroAccent);
      const colors = colorUniforms(material.colorNode);
      expect(colors).toContain(assets.heroAccent);
      expect(colors.some((color) => color !== assets.heroAccent && near(color, enamel))).toBe(true);
      assets.dispose();
    }
  });

  it.each(RARITIES)('strikes the %s hero coins with that tier face', (rarity) => {
    const assets = new UnboxAssets(new Group());
    new UnboxStage(rarity, 'card', assets);
    expect(assets.heroFace).toBe(HERO_FACE_TIERS[rarity]);
    assets.dispose();
  });

  it('gives every rarity a different coin face', () => {
    expect(new Set(RARITIES.map((rarity) => HERO_FACE_TIERS[rarity])).size).toBe(RARITIES.length);
  });

  it('strikes the coins flat until the primer has baked the faces', () => {
    const assets = new UnboxAssets(new Group());
    new UnboxStage('legendary', 'card', assets);
    expect(uniformValues(assets.heroMaterial.normalNode)).toContain(flatEmbossTexture());
    expect(uniformValues(assets.heroMaterial.colorNode)).toContain(flatEmbossTexture());
    assets.dispose();
  });

  it('turns the hero face-on once, overshooting, then sways near face-on', () => {
    expect(heroYaw(0)).toBe(0);
    expect(heroYaw(-1)).toBe(0);
    expect(heroYaw(0.5)).toBeLessThan(-1);
    const settled = Array.from({ length: 200 }, (_, i) => heroYaw(2.9 + i * 0.1));
    for (const yaw of settled) expect(Math.abs(yaw)).toBeLessThan(0.5);
    expect(Math.max(...settled) - Math.min(...settled)).toBeGreaterThan(0.4);
  });

  it('shows the reduced-motion hero still through the hold', () => {
    const stage = new UnboxStage('rare', 'card', new UnboxAssets(new Group()));
    const yaws: number[] = [];
    for (let ms = REDUCED_UNBOX.revealAtMs; ms < REDUCED_UNBOX.revealAtMs + 2_000; ms += 100) {
      stage.apply(unboxPose(ms, REDUCED_UNBOX, true));
      expect(stage.heroObject.visible).toBe(true);
      yaws.push(stage.heroObject.rotation.y);
    }
    expect(Math.max(...yaws) - Math.min(...yaws)).toBeLessThan(1e-9);
  });
});
