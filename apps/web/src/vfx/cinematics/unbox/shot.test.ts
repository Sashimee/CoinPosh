import { RARITIES } from '@coinposh/shared';
import { Color, Group, Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { rivieraCameraPreset } from '../../../scene/venues/riviera/layout.ts';
import { HEIRLOOM_PRISM, RARITY_COLORS } from '../../palette.ts';
import {
  HERO_PROPS,
  heroGeometry,
  HeroPart,
  heroYaw,
  ITEM_SIZE,
  UNBOX_HEROES,
  type HeroPartId,
  type UnboxHero,
} from './hero.ts';
import { REDUCED_UNBOX, unboxPose } from './plan.ts';
import { unboxShot } from './shot.ts';
import { UnboxAssets, UnboxStage } from './stage.ts';

const PORTRAIT = 390 / 844;
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

const EXPECTED_PARTS: Readonly<Record<UnboxHero, readonly HeroPartId[]>> = {
  card: [HeroPart.coinFace, HeroPart.gold],
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
    expect(HERO_PROPS.card.prop).toBe('collection-coin');
    expect(HERO_PROPS.charm.prop).toBe('charm-pendant');
    expect(HERO_PROPS.coins.prop).toBe('coin-stack');
    const props = UNBOX_HEROES.map((hero) => HERO_PROPS[hero].prop);
    expect(new Set(props).size).toBe(UNBOX_HEROES.length);
  });

  it.each(UNBOX_HEROES)('builds %s from exactly its surfaces', (hero) => {
    expect(partsOf(hero)).toEqual([...EXPECTED_PARTS[hero]].sort());
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

  it('stands resting props on the cap and centres floating ones', () => {
    for (const hero of UNBOX_HEROES) {
      const box = boundsOf(hero);
      if (HERO_PROPS[hero].rests) expect(box.min.y).toBeCloseTo(-ITEM_SIZE, 6);
      else expect(box.min.y + box.max.y).toBeCloseTo(0, 6);
    }
  });

  it.each(RARITIES)('tints the hero in the %s palette colour', (rarity) => {
    const assets = new UnboxAssets(new Group());
    new UnboxStage(rarity, 'charm', assets);
    const expected = new Color(rarity === 'heirloom' ? HEIRLOOM_PRISM[0] : RARITY_COLORS[rarity]);
    expect(assets.heroAccent.getHex()).toBe(expected.getHex());
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
