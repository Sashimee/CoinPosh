import { abs, dot, exp, mix, normalLocal, positionLocal, uniform, vec3, vec4 } from 'three/tsl';
import {
  AdditiveBlending,
  Color,
  CylinderGeometry,
  MeshBasicNodeMaterial,
  MeshPhysicalNodeMaterial,
  Vector3,
  type BufferGeometry,
  type Node,
} from 'three/webgpu';
import { mergeAll, roundedBox } from '../../../scene/venues/riviera/geometry.ts';
import { rivieraTokens } from '../../../scene/venues/riviera/palette.ts';

/**
 * The vault crate, one model for the crate riding the table and the one the unbox opens: a
 * bevelled navy-lacquer box framed in brushed gold, with a lock plate, a lid boss and a seam that
 * glows the crate's colour. Every size below is a share of the crate's edge.
 */

/** The lid line, where the unbox splits the crate: the seam glows along it. */
export const SEAM_LINE = 0.74;
const CAP = 0.22;
const CAP_PROUD = 0.022;
const EDGE = 0.055;
const BAND_HEIGHT = 0.22;
const BAND_Y = 0.4;
const LID_INSET = 0.2;
const LID_LINE = 0.05;
/** The gold boss in the middle of the lid, inside the glowing ring. */
const MEDALLION = 0.17;
const BEVEL = 0.09;
/** Height of the glowing ring round the lid line. */
const SEAM_RING = 0.045;
/** How deep the glowing core hangs into the body: more than the lid ever lifts as it shudders. */
const CORE_DEPTH = 0.22;

/** Reduced motion holds the seam lit at one level: no breath, no pulse, no sweep. */
export const STATIC_GLOW = 1;
/**
 * Peak of the seam line: just over the bloom threshold (0.92 to 0.95) even at the bottom of the
 * breath, so the sealed seam keeps a halo from across the table. The seam lines are thin so the
 * halo stays a line instead of washing the crate grey.
 */
const SEAM_PEAK = 1.35;
/**
 * Only the crate's left and right faces pick up a hint of the seam colour, mixed into the navy
 * lift: the face the player looks at stays navy lacquer, wherever the crate sits or tilts. The
 * teeter pulse stays in the seam, so the box does not flare brighter at the lip than on the shelf.
 */
const RIM_GLOW = 0.5;
export const RIM_TINT = 0.3;
/** Brushed gold never drops below this self-light, so the trim reads even off the key light. */
const TRIM_FLOOR = 1;
/**
 * The lacquer is self-lit along its own normals rather than by the venue: its venue sheen caught
 * the warm rim light on the back shelf but not on the dim front floor, so the same crate read
 * lighter at the back than where the player pushes it over.
 */
const LACQUER_LIFT = '#1E3A6E';
const LIFT_FLOOR = 0.62;
const LIFT_KEY = 0.38;
const LACQUER_ALBEDO = 0.6;
/**
 * The clearcoat sheen, lit from a key fixed to the crate instead of the venue's lights: a hot
 * line along the lid's front edge and a soft reflected streak across the lid, the same on the
 * back shelf as at the lip, and the same in the unbox as on the table.
 */
const SHEEN_KEY = new Vector3(-0.2, 1, 0.8).normalize();
const SHEEN_POWER = 28;
const SHEEN_PEAK = 0.7;
const STREAK_PEAK = 0.16;
const STREAK_AT = 0.12;
const STREAK_SHARPNESS = 30;
const GLINT_PEAK = 3.2;
const GLINT_SHARPNESS = 110;
/** Sweep position along the crate's diagonal, in crate edges: it starts and ends off the trim. */
export const GLINT_FROM = -0.75;
export const GLINT_TO = 1.55;
/** Where a parked glint sits: far enough off the diagonal that the trim shows none of it. */
export const GLINT_OFF = 8;
/**
 * Reduced motion trades the sweep for a still highlight: the glint rests on the lid corner nearest
 * the player, at a fraction of its sweep strength so it reads as a sheen rather than a flash.
 */
export const GLINT_REST = 1.15;
export const GLINT_STILL = 0.3;

type F = Node<'float'>;

/** What each crate feeds its materials: per-object uniforms on the table, plain ones in the unbox. */
export interface VaultCrateInputs {
  /** Seam colour: white gold while sealed, then the rolled rarity's. */
  readonly tint: Node<'color'>;
  /** Seam brightness, `STATIC_GLOW` at rest. */
  readonly glow: F;
  /** How strongly the flanks pick up the seam colour, `STATIC_GLOW` at rest. */
  readonly rim: F;
  /** Share of the seam colour in that flank light, `RIM_TINT` at rest. */
  readonly rimTint: F | number;
  /** Glint position along the crate diagonal, in crate edges; `GLINT_OFF` when parked. */
  readonly sweep: F;
  /** Glint strength. */
  readonly glint: F;
}

export interface VaultCrateMaterials {
  readonly lacquer: MeshPhysicalNodeMaterial;
  readonly gold: MeshPhysicalNodeMaterial;
  readonly glow: MeshBasicNodeMaterial;
}

/** The lacquer, brushed-gold and seam materials for a crate `size` metres on an edge. */
export function createVaultCrateMaterials(
  size: number,
  inputs: VaultCrateInputs,
): VaultCrateMaterials {
  const { tint, glow, rim, rimTint, sweep, glint } = inputs;
  const lacquer = new MeshPhysicalNodeMaterial({
    color: new Color(rivieraTokens['navy-lacquer']).multiplyScalar(LACQUER_ALBEDO),
    roughness: 1,
    specularIntensity: 0,
  });
  const navy = uniform(new Color(LACQUER_LIFT));
  const up = normalLocal.y;
  const lift = navy.mul(up.max(0).mul(LIFT_KEY).add(LIFT_FLOOR));
  const rimLight = mix(navy, tint, rimTint).mul(abs(normalLocal.x).mul(rim).mul(RIM_GLOW));
  const edge = dot(normalLocal, vec3(SHEEN_KEY.x, SHEEN_KEY.y, SHEEN_KEY.z)).max(0);
  const diagonal = positionLocal.x.add(positionLocal.z).div(size).sub(STREAK_AT);
  const streak = exp(diagonal.pow2().mul(-STREAK_SHARPNESS)).mul(up.max(0).pow(8));
  const sheen = edge.pow(SHEEN_POWER).mul(SHEEN_PEAK).add(streak.mul(STREAK_PEAK));
  lacquer.emissiveNode = lift
    .add(rimLight)
    .add(uniform(new Color(rivieraTokens.champagne)).mul(sheen));

  const brushed = new Color(rivieraTokens['gold-brushed']);
  const gold = new MeshPhysicalNodeMaterial({
    color: brushed,
    metalness: 1,
    roughness: 0.55,
  });
  const along = dot(positionLocal, vec3(1, 1, 1).normalize()).div(size);
  const shine = exp(along.sub(sweep).pow2().mul(-GLINT_SHARPNESS));
  gold.emissiveNode = uniform(brushed).mul(shine.mul(glint).mul(GLINT_PEAK).add(TRIM_FLOOR));

  const seam = new MeshBasicNodeMaterial({
    transparent: true,
    blending: AdditiveBlending,
    depthWrite: false,
  });
  seam.colorNode = vec4(tint.mul(glow).mul(SEAM_PEAK), 1);
  seam.fog = false;
  return { lacquer, gold, glow: seam };
}

/** The crate in one piece per material, as it rides the table. */
export interface VaultCrateGeometry {
  readonly body: BufferGeometry;
  readonly trim: BufferGeometry;
  readonly seam: BufferGeometry;
}

/**
 * The crate split at the lid line for the unbox, every part in the crate's own space (base at
 * the origin) so the lacquer's sheen and the trim's glint fall where they do on the table. The
 * seam rides with the lid: its ring, its inset ring, and a glowing core that hangs from the lid
 * into the body, hidden while the crate is shut and lighting the gap whenever the lid lifts.
 */
export interface VaultCrateParts {
  readonly body: BufferGeometry;
  readonly bodyTrim: BufferGeometry;
  readonly lid: BufferGeometry;
  readonly lidTrim: BufferGeometry;
  readonly seam: BufferGeometry;
}

export function vaultCrateGeometry(size: number): VaultCrateGeometry {
  const trim = trimPieces(size, false);
  return {
    body: roundedBox(new Vector3(size, size, size), new Vector3(0, size / 2, 0), size * BEVEL, 3),
    trim: mergeAll([...trim.body, ...trim.lid], 'crate-trim'),
    seam: mergeAll([seamRing(size, size * SEAM_LINE), ...lidRing(size)], 'crate-seam'),
  };
}

export function vaultCrateParts(size: number): VaultCrateParts {
  const seamY = size * SEAM_LINE;
  const lidHeight = size - seamY;
  const trim = trimPieces(size, true);
  return {
    body: roundedBox(new Vector3(size, seamY, size), new Vector3(0, seamY / 2, 0), size * BEVEL, 3),
    bodyTrim: mergeAll(trim.body, 'unbox-crate-trim'),
    lid: roundedBox(
      new Vector3(size, lidHeight, size),
      new Vector3(0, seamY + lidHeight / 2, 0),
      size * BEVEL,
      3,
    ),
    lidTrim: mergeAll(trim.lid, 'unbox-crate-lid-trim'),
    seam: mergeAll(
      [seamRing(size, seamY), glowCore(size, seamY), ...lidRing(size)],
      'unbox-crate-seam',
    ),
  };
}

export function vaultCrateGeometries(parts: VaultCrateParts): readonly BufferGeometry[] {
  return [parts.body, parts.bodyTrim, parts.lid, parts.lidTrim, parts.seam];
}

/**
 * The gold frame: corner caps, edge rails, a wide band, a lock plate on the player's face and a
 * boss on the lid. Split, the upright rails break at the lid line and each half goes with its
 * part; whole, they run corner to corner.
 */
function trimPieces(
  s: number,
  split: boolean,
): { readonly body: BufferGeometry[]; readonly lid: BufferGeometry[] } {
  const body: BufferGeometry[] = [];
  const lid: BufferGeometry[] = [];
  const cap = s * CAP;
  const proud = s * CAP_PROUD;
  const edge = s * EDGE;
  const seamY = s * SEAM_LINE;
  const out = s / 2 - cap / 2 + proud;
  const corners = [-1, 1] as const;
  const rail = (x: number, z: number, from: number, to: number): BufferGeometry => {
    const at = s / 2 - edge / 2 + proud * 0.6;
    return roundedBox(
      new Vector3(edge, to - from, edge),
      new Vector3(x * at, (from + to) / 2, z * at),
      edge * 0.4,
      2,
    );
  };
  for (const x of corners) {
    for (const z of corners) {
      body.push(
        roundedBox(
          new Vector3(cap, cap, cap),
          new Vector3(x * out, cap / 2, z * out),
          cap * 0.24,
          2,
        ),
      );
      lid.push(
        roundedBox(
          new Vector3(cap, cap, cap),
          new Vector3(x * out, s - cap / 2 + proud, z * out),
          cap * 0.24,
          2,
        ),
      );
      if (split) {
        body.push(rail(x, z, cap, seamY));
        lid.push(rail(x, z, seamY, s - cap));
      } else {
        body.push(rail(x, z, cap, s - cap));
      }
    }
  }
  const top = s - edge / 2 + proud * 0.4;
  const topEdge = s / 2 - edge / 2 + proud * 0.4;
  const span = s - cap * 2;
  for (const side of corners) {
    lid.push(
      roundedBox(new Vector3(span, edge, edge), new Vector3(0, top, side * topEdge), edge * 0.4, 2),
      roundedBox(new Vector3(edge, edge, span), new Vector3(side * topEdge, top, 0), edge * 0.4, 2),
    );
  }
  body.push(
    roundedBox(
      new Vector3(s * 1.03, s * BAND_HEIGHT, s * 1.03),
      new Vector3(0, s * BAND_Y, 0),
      s * 0.03,
      2,
    ),
    roundedBox(
      new Vector3(s * 0.26, s * 0.3, s * 0.05),
      new Vector3(0, s * BAND_Y + s * 0.04, s * 0.52),
      s * 0.04,
      2,
    ),
  );
  const medallion = new CylinderGeometry(s * MEDALLION, s * MEDALLION, s * 0.03, 24);
  medallion.translate(0, s + s * 0.005, 0);
  lid.push(medallion);
  return { body, lid };
}

/** The glowing ring round the crate at the lid line, centred at `y`. */
function seamRing(s: number, y: number): BufferGeometry {
  return roundedBox(
    new Vector3(s * 1.016, s * SEAM_RING, s * 1.016),
    new Vector3(0, y, 0),
    s * 0.02,
    1,
  );
}

/**
 * A rounded block just inside the body's bevels, from the lid line down: with the same corner
 * radius as the body and narrower than its bevelled top, no part of it shows through a shut crate.
 */
function glowCore(s: number, seamY: number): BufferGeometry {
  const width = s * (1 - BEVEL * 2);
  const depth = s * CORE_DEPTH;
  return roundedBox(
    new Vector3(width, depth, width),
    new Vector3(0, seamY - depth / 2, 0),
    s * BEVEL,
    1,
  );
}

/** The inset ring on the lid that a camera looking down on the crate sees first. */
function lidRing(s: number): BufferGeometry[] {
  const line = s * LID_LINE;
  const inset = s / 2 - s * LID_INSET;
  const long = s - s * LID_INSET * 2 + line;
  const y = s + line / 4;
  const pieces: BufferGeometry[] = [];
  for (const side of [-1, 1]) {
    pieces.push(
      roundedBox(new Vector3(long, line / 2, line), new Vector3(0, y, side * inset), line * 0.2, 1),
      roundedBox(new Vector3(line, line / 2, long), new Vector3(side * inset, y, 0), line * 0.2, 1),
    );
  }
  return pieces;
}
