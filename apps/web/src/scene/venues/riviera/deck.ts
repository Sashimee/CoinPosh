import { Group, LatheGeometry, Mesh, Vector2, Vector3, type BufferGeometry } from 'three/webgpu';
import {
  line,
  mergeAll,
  roundProfile,
  roundedBox,
  roundedRectPath,
  sweepProfile,
} from './geometry.ts';
import { RIVIERA_DECK as D, RIVIERA_TABLE as T } from './layout.ts';
import type { RivieraMaterials } from './materials.ts';

const X = new Vector3(1, 0, 0);
const Y = new Vector3(0, 1, 0);
const Z = new Vector3(0, 0, 1);
const BULWARK_THICKNESS = 0.09;
const CAP_WIDTH = 0.13;
const CAP_THICKNESS = 0.035;
const CORNER = 0.35;
const INBOARD_X = D.halfWidth - BULWARK_THICKNESS;
const INBOARD_Z = D.sternZ + BULWARK_THICKNESS;
const STRAKE = { y: T.deckY + 0.24, height: 0.05, proud: 0.022 } as const;
const COVE_STRIPE = { y: T.deckY + D.bulwarkHeight - 0.085, height: 0.011, proud: 0.0015 } as const;
const PINSTRIPE = { y: T.deckY + D.bulwarkHeight - 0.05, radius: 0.0042 } as const;
const SCUPPER = { y: T.deckY + 0.04, width: 0.2, height: 0.036, spacing: 0.95 } as const;

interface InboardRun {
  readonly from: Vector3;
  readonly to: Vector3;
  /** Into the cockpit, away from the bulwark face. */
  readonly normal: Vector3;
}

/** The bulwark's inboard faces at height `y`: port side, transom, starboard side. */
function inboardRuns(y: number, offset = 0): InboardRun[] {
  const x = INBOARD_X - offset;
  const z = INBOARD_Z + offset;
  return [
    { from: new Vector3(-x, y, D.forwardZ), to: new Vector3(-x, y, z), normal: X },
    { from: new Vector3(-x, y, z), to: new Vector3(x, y, z), normal: Z },
    { from: new Vector3(x, y, z), to: new Vector3(x, y, D.forwardZ), normal: X.clone().negate() },
  ];
}

/** A strip standing proud of every inboard face, as a rounded box per run. */
function inboardStrip(y: number, height: number, proud: number, radius: number): BufferGeometry[] {
  return inboardRuns(y).map(({ from, to, normal }) => {
    const length = from.distanceTo(to) + (normal === Z ? 0 : -proud);
    const size =
      normal === Z
        ? new Vector3(length, height, proud * 2)
        : new Vector3(proud * 2, height, length);
    const centre = from.clone().add(to).multiplyScalar(0.5);
    if (normal !== Z) centre.z += proud / 2;
    return roundedBox(size, centre, Math.min(radius, height / 2, proud), 2);
  });
}

function scupperCentres(): Vector3[] {
  const count = Math.floor((INBOARD_X * 2) / SCUPPER.spacing);
  const span = (count - 1) * SCUPPER.spacing;
  return Array.from(
    { length: count },
    (_, i) => new Vector3(-span / 2 + i * SCUPPER.spacing, SCUPPER.y, INBOARD_Z),
  );
}

/**
 * Detailing on the bulwark's inboard face so it reads as a finished yacht interior rather
 * than a flat band: a teak rubbing strake, a navy cove stripe under a chrome pinstripe, and
 * chrome-framed scupper recesses at deck level.
 */
function bulwarkTrim(): {
  teak: BufferGeometry[];
  lacquer: BufferGeometry[];
  chrome: BufferGeometry[];
} {
  const scuppers = scupperCentres();
  return {
    teak: inboardStrip(STRAKE.y, STRAKE.height, STRAKE.proud, 0.012),
    lacquer: [
      ...inboardStrip(COVE_STRIPE.y, COVE_STRIPE.height, COVE_STRIPE.proud, 0.001),
      ...scuppers.map((c) =>
        roundedBox(
          new Vector3(SCUPPER.width, SCUPPER.height, 0.008),
          c.clone().setZ(INBOARD_Z - 0.002),
          0.003,
          2,
        ),
      ),
    ],
    chrome: [
      ...inboardRuns(PINSTRIPE.y, PINSTRIPE.radius * 0.4).map(({ from, to }) =>
        sweepProfile(line(from, to), roundProfile(PINSTRIPE.radius, 10), { up: Y }),
      ),
      ...scuppers.map((c) =>
        sweepProfile(
          roundedRectPath(
            c.clone().setZ(INBOARD_Z + 0.002),
            X,
            Y,
            SCUPPER.width + 0.012,
            SCUPPER.height + 0.012,
            0.012,
            4,
          ),
          roundProfile(0.0045, 8),
          { up: Z, closed: true },
        ),
      ),
    ],
  };
}

export interface RivieraDeck {
  readonly group: Group;
  readonly meshes: readonly Mesh[];
  dispose(): void;
}

/** Plan-view outline of the stern rail: up the port side, across the transom, down starboard. */
function railOutline(inset: number, y: number): Vector3[] {
  const x = D.halfWidth - inset;
  const z = D.sternZ + inset;
  const points: Vector3[] = [new Vector3(-x, y, D.forwardZ)];
  const segments = 8;
  for (let i = 0; i <= segments; i += 1) {
    const a = Math.PI + ((Math.PI / 2) * i) / segments;
    points.push(
      new Vector3(-x + CORNER + Math.cos(a) * CORNER, y, z + CORNER + Math.sin(a) * CORNER),
    );
  }
  for (let i = 0; i <= segments; i += 1) {
    const a = (Math.PI * 3) / 2 + ((Math.PI / 2) * i) / segments;
    points.push(
      new Vector3(x - CORNER + Math.cos(a) * CORNER, y, z + CORNER + Math.sin(a) * CORNER),
    );
  }
  points.push(new Vector3(x, y, D.forwardZ));
  return points;
}

function stanchionPositions(): Vector3[] {
  const inset = BULWARK_THICKNESS / 2;
  const y = T.deckY + D.bulwarkHeight + CAP_THICKNESS;
  const x = D.halfWidth - inset;
  const z = D.sternZ + inset;
  const result: Vector3[] = [];
  const across = Math.floor((x * 2) / D.stanchionSpacing);
  for (let i = 0; i <= across; i += 1) {
    result.push(new Vector3(-x + CORNER + ((x * 2 - CORNER * 2) * i) / across, y, z));
  }
  const along = Math.floor((D.forwardZ - z) / D.stanchionSpacing);
  for (let i = 1; i <= along; i += 1) {
    const pz = z + CORNER + ((D.forwardZ - z - CORNER) * i) / along;
    result.push(new Vector3(-x, y, pz), new Vector3(x, y, pz));
  }
  return result;
}

function stanchion(base: Vector3): BufferGeometry {
  const h = D.railHeight;
  const profile = [
    [0, 0],
    [0.034, 0],
    [0.034, 0.006],
    [0.022, 0.016],
    [0.014, 0.03],
    [0.0125, 0.05],
    [0.0125, h - 0.03],
    [0.016, h - 0.022],
    [0.016, h - 0.004],
    [0, h],
  ].map(([r, y]) => new Vector2(r, y));
  const g = new LatheGeometry(profile, 20);
  g.translate(base.x, base.y, base.z);
  return g;
}

export function createRivieraDeck(materials: RivieraMaterials, shadows: boolean): RivieraDeck {
  const group = new Group();
  group.name = 'riviera-deck';
  const deckLength = D.forwardZ - D.sternZ;

  const floor = roundedBox(
    new Vector3(D.halfWidth * 2, 0.06, deckLength),
    new Vector3(0, T.deckY - 0.03, (D.forwardZ + D.sternZ) / 2),
    0.01,
    1,
  );

  const bulwarkTop = T.deckY + D.bulwarkHeight;
  const bulwarkY = T.deckY + D.bulwarkHeight / 2;
  const bulwark = [
    roundedBox(
      new Vector3(D.halfWidth * 2, D.bulwarkHeight, BULWARK_THICKNESS),
      new Vector3(0, bulwarkY, D.sternZ + BULWARK_THICKNESS / 2),
      0.02,
    ),
    ...[-1, 1].map((side) =>
      roundedBox(
        new Vector3(BULWARK_THICKNESS, D.bulwarkHeight, deckLength),
        new Vector3(
          side * (D.halfWidth - BULWARK_THICKNESS / 2),
          bulwarkY,
          (D.forwardZ + D.sternZ) / 2,
        ),
        0.02,
      ),
    ),
  ];

  const capY = bulwarkTop + CAP_THICKNESS / 2;
  const capAcross = roundedBox(
    new Vector3(CAP_WIDTH, CAP_THICKNESS, D.halfWidth * 2 + 0.04),
    new Vector3(0, capY, 0),
    0.012,
  );
  const capSides = [-1, 1].map((side) =>
    roundedBox(
      new Vector3(CAP_WIDTH, CAP_THICKNESS, deckLength),
      new Vector3(side * (D.halfWidth - BULWARK_THICKNESS / 2), capY, (D.forwardZ + D.sternZ) / 2),
      0.012,
    ),
  );

  const trim = bulwarkTrim();
  const railTop = bulwarkTop + CAP_THICKNESS;
  const chrome = [
    ...trim.chrome,
    ...stanchionPositions().map(stanchion),
    sweepProfile(
      railOutline(BULWARK_THICKNESS / 2, railTop + D.railHeight - 0.01),
      roundProfile(0.019, 16),
      { up: Y },
    ),
    sweepProfile(
      railOutline(BULWARK_THICKNESS / 2, railTop + D.railHeight * 0.52),
      roundProfile(0.006, 10),
      { up: Y },
    ),
    ...[-1, 1].map((side) =>
      sweepProfile(
        line(
          new Vector3(side * 0.9, T.deckY + 0.004, D.sternZ + 0.35),
          new Vector3(side * 0.9, T.deckY + 0.004, D.sternZ + 0.6),
        ),
        roundProfile(0.012, 10),
        { up: Y },
      ),
    ),
  ];

  const deckMesh = new Mesh(mergeAll([floor], 'deck/teak'), materials.deck);
  deckMesh.name = 'deck-teak';
  deckMesh.receiveShadow = shadows;

  const gelcoat = new Mesh(mergeAll(bulwark, 'deck/gelcoat'), materials.gelcoat);
  gelcoat.name = 'deck-bulwark';
  gelcoat.receiveShadow = shadows;

  const capRail = new Mesh(mergeAll([capAcross], 'deck/cap-transom'), materials.teak);
  capRail.name = 'deck-cap-transom';
  capRail.rotation.y = Math.PI / 2;
  capRail.position.z = D.sternZ + BULWARK_THICKNESS / 2;

  const capSideMesh = new Mesh(
    mergeAll([...capSides, ...trim.teak], 'deck/cap-sides'),
    materials.teak,
  );
  capSideMesh.name = 'deck-cap-sides';

  const steel = new Mesh(mergeAll(chrome, 'deck/chrome'), materials.chrome);
  steel.name = 'deck-chrome';

  const lacquerTrim = new Mesh(mergeAll(trim.lacquer, 'deck/lacquer-trim'), materials.lacquer);
  lacquerTrim.name = 'deck-lacquer-trim';

  const meshes = [deckMesh, gelcoat, capRail, capSideMesh, steel, lacquerTrim];
  group.add(...meshes);

  return {
    group,
    meshes,
    dispose() {
      for (const m of meshes) m.geometry.dispose();
    },
  };
}
