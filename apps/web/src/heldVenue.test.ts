import { Group, Mesh, PointLight } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { HELD_LAYER, holdBackVenue } from './heldVenue.ts';

function venueScene() {
  const root = new Group();
  const light = new PointLight();
  const table = new Mesh();
  const glow = new Mesh();
  glow.layers.set(3);
  root.add(light, table, glow);
  return { root, light, table, glow };
}

describe('holdBackVenue', () => {
  it('moves every non-light object onto the held layer and never touches a light', () => {
    const { root, light, table, glow } = venueScene();
    const lightMask = light.layers.mask;
    holdBackVenue(root);
    for (const object of [root, table, glow]) {
      expect(object.layers.mask).toBe((1 << HELD_LAYER) >>> 0);
    }
    expect(light.layers.mask).toBe(lightMask);
  });

  it('restores each held object to its own layers, including a non-default one', () => {
    const { root, light, table, glow } = venueScene();
    const reveal = holdBackVenue(root);
    reveal();
    expect(root.layers.mask).toBe(1);
    expect(table.layers.mask).toBe(1);
    expect(glow.layers.mask).toBe(1 << 3);
    expect(light.layers.mask).toBe(1);
  });

  it('keeps layer changes made during the hold', () => {
    const { root, light, table, glow } = venueScene();
    const reveal = holdBackVenue(root);
    table.layers.enable(5);
    glow.layers.set(7);
    light.layers.enable(2);
    reveal();
    expect(table.layers.mask).toBe(1 | (1 << 5));
    expect(glow.layers.mask).toBe(1 << 7);
    expect(light.layers.mask).toBe(1 | (1 << 2));
  });

  it('leaves a child added during the hold on the layers it was given', () => {
    const { root, table } = venueScene();
    const reveal = holdBackVenue(root);
    const crate = new Mesh();
    crate.layers.set(4);
    table.add(crate);
    const lamp = new PointLight();
    root.add(lamp);
    reveal();
    expect(crate.layers.mask).toBe(1 << 4);
    expect(lamp.layers.mask).toBe(1);
    expect(table.layers.mask).toBe(1);
  });

  it('reveals only once, so a later layer change is not overwritten', () => {
    const { root, table } = venueScene();
    const reveal = holdBackVenue(root);
    reveal();
    table.layers.set(HELD_LAYER);
    reveal();
    expect(table.layers.mask).toBe((1 << HELD_LAYER) >>> 0);
  });
});
