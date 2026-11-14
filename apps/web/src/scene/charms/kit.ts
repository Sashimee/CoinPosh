import {
  type BufferGeometry,
  Color,
  Group,
  Mesh,
  type MeshPhysicalNodeMaterial,
  type Node,
  RingGeometry,
  SRGBColorSpace,
  TorusGeometry,
} from 'three/webgpu';
import { rivieraTokens } from '../venues/riviera/palette.ts';
import { SYNERGY_COLORS, type SynergyTag } from './kinds.ts';
import {
  CHARM_GOLD,
  type CharmQuality,
  type CharmUniforms,
  createBrushedGold,
  createCrystal,
  createEnamel,
  createPainted,
  createScent,
  createVelvet,
  type VelvetWeave,
} from './materials.ts';
import { lathe, merge, paint, place } from './shapes.ts';

/** Height of the plinth's top face: every model stands on it. */
export const PLINTH_TOP = 0.0052;
const PLINTH_RADIUS = 0.0242;
const CUSHION_RADIUS = 0.0161;

/**
 * Builds one charm's meshes: owns its materials (created on first use, one per finish) and
 * merges each finish's parts into a single mesh, so a charm costs one draw call per finish
 * per moving part.
 */
export class Kit {
  readonly segments: number;
  private readonly materials = new Map<string, MeshPhysicalNodeMaterial>();

  constructor(
    readonly quality: CharmQuality,
    readonly uniforms: CharmUniforms,
    private readonly deform?: Node<'vec3'>,
  ) {
    this.segments = quality === 'high' ? 40 : 24;
  }

  private material(key: string, make: () => MeshPhysicalNodeMaterial): MeshPhysicalNodeMaterial {
    let material = this.materials.get(key);
    if (!material) {
      material = make();
      this.materials.set(key, material);
    }
    return material;
  }

  private get base() {
    return { quality: this.quality, uniforms: this.uniforms, deform: this.deform };
  }

  painted(): MeshPhysicalNodeMaterial {
    return this.material('painted', () => createPainted(this.base));
  }

  brushed(): MeshPhysicalNodeMaterial {
    return this.material('brushed', () => createBrushedGold(this.base));
  }

  velvet(weave: VelvetWeave): MeshPhysicalNodeMaterial {
    return this.material(`velvet-${weave}`, () => createVelvet({ ...this.base, weave }));
  }

  enamel(deep: string, bright: string): MeshPhysicalNodeMaterial {
    return this.material(`enamel-${deep}-${bright}`, () =>
      createEnamel({ ...this.base, deep, bright }),
    );
  }

  crystal(): MeshPhysicalNodeMaterial {
    return this.material('crystal', () => createCrystal(this.base));
  }

  scent(tint: string): MeshPhysicalNodeMaterial {
    return this.material(`scent-${tint}`, () => createScent({ ...this.base, tint }));
  }

  mesh(name: string, parts: readonly BufferGeometry[], material: MeshPhysicalNodeMaterial): Mesh {
    const mesh = new Mesh(merge(parts, name), material);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  group(name: string, ...children: Mesh[]): Group {
    const group = new Group();
    group.name = name;
    if (children.length > 0) group.add(...children);
    return group;
  }
}

export interface PlinthParts {
  /** Lacquer body, satin belt, enamel tag inlay and polished beads: the painted static mesh. */
  readonly painted: BufferGeometry[];
  /** The velvet cushion inset in the top, a deep jewel-box shade of the first synergy tag. */
  readonly velvet: BufferGeometry[];
}

const TAG_GAP = 0.09;

/**
 * The socket plinth every charm stands on: navy show-car lacquer, a satin gold belt, and an
 * enamel ring inlaid in its synergy colours between two polished beads. The ring and beads
 * answer the activation flash.
 */
export function plinth(kit: Kit, tags: readonly SynergyTag[]): PlinthParts {
  const s = kit.segments;
  const navy = rivieraTokens['navy-lacquer'];
  const body = paint(
    lathe(
      [
        [0, 0],
        [PLINTH_RADIUS - 0.0006, 0],
        [PLINTH_RADIUS, 0.0005],
        [PLINTH_RADIUS, 0.0038],
        [PLINTH_RADIUS - 0.0008, 0.0047],
        [PLINTH_RADIUS - 0.0024, 0.005],
        [CUSHION_RADIUS, 0.005],
        [CUSHION_RADIUS, 0.0042],
        [0, 0.0042],
      ],
      s,
    ),
    navy,
    { rough: 0.32, glow: 0.05 },
  );
  const belt = paint(
    lathe(
      [
        [PLINTH_RADIUS + 0.0001, 0.0008],
        [PLINTH_RADIUS + 0.0004, 0.0011],
        [PLINTH_RADIUS + 0.0004, 0.0031],
        [PLINTH_RADIUS + 0.0001, 0.0034],
      ],
      s,
    ),
    CHARM_GOLD.brushed,
    { metal: 1, rough: 0.26, glow: 0.5 },
  );
  const painted = [body, belt];
  const rings = tags.length > 0 ? tags : (['gilded'] as const);
  const span = (Math.PI * 2) / rings.length;
  const gap = rings.length > 1 ? TAG_GAP : 0;
  rings.forEach((tag, i) => {
    const arc = new RingGeometry(
      0.0168,
      0.0196,
      Math.max(8, Math.round(s / rings.length) + 4),
      1,
      i * span + gap / 2 + Math.PI / 2,
      span - gap,
    );
    place(arc, { at: [0, 0.00505, 0], rotate: [-Math.PI / 2, 0, 0] });
    painted.push(paint(arc, SYNERGY_COLORS[tag], { rough: 0.12, glow: 1 }));
  });
  for (const radius of [0.0164, 0.02]) {
    const bead = new TorusGeometry(radius, 0.00042, 6, s + 8);
    place(bead, { at: [0, 0.00505, 0], rotate: [Math.PI / 2, 0, 0] });
    painted.push(paint(bead, CHARM_GOLD.polished, { metal: 1, rough: 0.14, glow: 1 }));
  }
  const hsl = new Color(SYNERGY_COLORS[rings[0] ?? 'gilded']).getHSL(
    { h: 0, s: 0, l: 0 },
    SRGBColorSpace,
  );
  const dye = new Color().setHSL(hsl.h, 0.55, 0.17, SRGBColorSpace);
  const cushion = paint(
    lathe(
      [
        [CUSHION_RADIUS, 0.0042],
        [CUSHION_RADIUS, 0.0045],
        [CUSHION_RADIUS - 0.0004, 0.00495],
        [CUSHION_RADIUS * 0.7, 0.0051],
        [0, 0.00515],
      ],
      s,
    ),
    `#${dye.getHexString()}`,
    { glow: 0.25 },
  );
  return { painted, velvet: [cushion] };
}
