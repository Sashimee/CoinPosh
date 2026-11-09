import type { Object3D } from 'three/webgpu';

/** A layer no camera sees, holding the venue's meshes until play can start. */
export const HELD_LAYER = 31;

const HELD_BIT = 1 << HELD_LAYER;

/**
 * Keeps the venue's meshes out of the frames drawn while play is still being set up, so their
 * shaders are linked once, in the first frame after everything that adds a light has run. The
 * lights keep their layers, so those frames already light the scene as it will be drawn.
 * Returns the function that shows the venue again.
 *
 * Only what the hold itself changed is undone: layers enabled on a held object during the hold
 * are kept, an object whose layers were replaced during the hold is left as it was set, and
 * objects added during the hold were never held.
 */
export function holdBackVenue(root: Object3D): () => void {
  const held: { readonly object: Object3D; readonly mask: number }[] = [];
  root.traverse((object) => {
    if ((object as { readonly isLight?: boolean }).isLight === true) return;
    held.push({ object, mask: object.layers.mask });
    object.layers.set(HELD_LAYER);
  });
  let revealed = false;
  return () => {
    if (revealed) return;
    revealed = true;
    for (const { object, mask } of held) {
      const now = object.layers.mask;
      if ((now & HELD_BIT) === 0) continue;
      object.layers.mask = ((now & ~HELD_BIT) | mask) >>> 0;
    }
  };
}
