import { describe, expect, it } from 'vitest';
import { DirectionalLight, Group, Mesh, PointLight } from 'three/webgpu';
import { lightFreeBranches } from './precompile.ts';

describe('lightFreeBranches', () => {
  it('returns a root without lights whole', () => {
    const root = new Group();
    root.add(new Mesh(), new Group().add(new Mesh()));
    expect(lightFreeBranches(root)).toEqual([root]);
  });

  it('keeps every light out and every other object in, at the largest light-free subtrees', () => {
    const root = new Group();
    const table = new Group().add(new Mesh(), new Mesh());
    const deck = new Mesh();
    const lighting = new Group();
    const key = new DirectionalLight();
    const lamp = new Mesh();
    lighting.add(key, lamp);
    root.add(table, deck, lighting);

    expect(lightFreeBranches(root)).toEqual([table, deck, lamp]);
  });

  it('goes under a light to compile the meshes it carries', () => {
    const root = new Group();
    const bulb = new PointLight();
    const shade = new Mesh();
    bulb.add(shade);
    root.add(bulb);
    expect(lightFreeBranches(root)).toEqual([shade]);
  });

  it('has nothing to compile in a root that is only lights', () => {
    const light = new DirectionalLight();
    expect(lightFreeBranches(light)).toEqual([]);
  });
});
