import {
  CapsuleGeometry,
  CircleGeometry,
  ConeGeometry,
  CylinderGeometry,
  type Group,
  LatheGeometry,
  OctahedronGeometry,
  SphereGeometry,
  TorusGeometry,
  Vector2,
  type BufferGeometry,
} from 'three/webgpu';
import {
  clamp01,
  easeInCubic,
  easeOutBack,
  easeOutQuad,
  easeOutSpring,
  lerp,
  pulse,
} from '../../vfx/easing.ts';
import { rivieraTokens } from '../venues/riviera/palette.ts';
import type { BurstProfile } from './fx.ts';
import type { CharmKind, SynergyTag } from './kinds.ts';
import { Kit, PLINTH_TOP, plinth } from './kit.ts';
import {
  CHARM_GOLD,
  type CharmQuality,
  type CharmUniforms,
  GLINT_PARKED,
  quiverDeform,
} from './materials.ts';
import { facet, helix, lathe, paint, place, tube, type Profile } from './shapes.ts';

export interface ModelContext {
  readonly quality: CharmQuality;
  readonly uniforms: CharmUniforms;
  readonly tags: readonly SynergyTag[];
}

export interface CharmModel {
  readonly root: Group;
  readonly burst: BurstProfile;
  /** Seconds the model's own activation choreography lasts. */
  readonly choreography: number;
  /**
   * Poses every moving part and writes the model's uniforms. `t` is the idle clock in seconds,
   * `since` the seconds since activation (negative when none is playing) and `motion` 1 for
   * full motion, 0 for reduced motion. Allocation-free: it runs every frame.
   */
  pose(t: number, since: number, motion: number): void;
}

const TOP = PLINTH_TOP;
const CHROME = '#E9EAEE';
const TAU = Math.PI * 2;
const POLISHED = { metal: 1, rough: 0.12, glow: 1 } as const;

/** A narrow highlight swept up the gold once every `period` seconds, parked in between. */
function glintAt(t: number, period: number, offset: number): number {
  const phase = (((t + offset) % period) + period) % period;
  return phase < 0.85 ? lerp(-0.004, 0.06, phase / 0.85) : GLINT_PARKED;
}

function decay(since: number, rate: number): number {
  return since < 0 ? 0 : Math.exp(-since * rate);
}

/** A damped oscillation released at activation: 0 at rest. */
function ring(since: number, hz: number, rate: number): number {
  return since < 0 ? 0 : Math.exp(-since * rate) * Math.sin(since * hz * TAU);
}

const springBack = easeOutSpring(1.4, 6);
const popIn = easeOutBack(2.2);

function pegShaft(h: number): Profile {
  return [
    [0, 0],
    [0.0046, 0],
    [0.0047, 0.0006],
    [0.0041, 0.0012],
    [0.0027, 0.0018],
    [0.002, 0.003],
    [0.0017, 0.005],
    [0.0016, h - 0.0062],
    [0.0021, h - 0.0057],
    [0.0021, h - 0.0053],
    [0, h - 0.0053],
  ];
}

function pegCap(h: number): Profile {
  return [
    [0, h - 0.0056],
    [0.0024, h - 0.0056],
    [0.0032, h - 0.005],
    [0.0036, h - 0.004],
    [0.0034, h - 0.0026],
    [0.0027, h - 0.0013],
    [0.0015, h - 0.0004],
    [0, h],
  ];
}

const PEGS = [
  { angle: -Math.PI / 2, height: 0.034 },
  { angle: Math.PI / 6, height: 0.027 },
  { angle: (5 * Math.PI) / 6, height: 0.0285 },
] as const;
const PEG_RING = 0.0098;
const GEM_Y = PLINTH_TOP + 0.0046;

function goldenPeg(ctx: ModelContext): CharmModel {
  const u = ctx.uniforms;
  const kit = new Kit(ctx.quality, u, quiverDeform(u, TOP + 0.004));
  const base = plinth(kit, ctx.tags);
  const shafts: BufferGeometry[] = [];
  const caps: BufferGeometry[] = [...base.painted];
  for (const peg of PEGS) {
    const at = [Math.cos(peg.angle) * PEG_RING, TOP, Math.sin(peg.angle) * PEG_RING] as const;
    shafts.push(place(lathe(pegShaft(peg.height), kit.segments), { at }));
    caps.push(
      paint(place(lathe(pegCap(peg.height), kit.segments), { at }), CHARM_GOLD.polished, POLISHED),
    );
  }
  const gemGeometry = facet(new OctahedronGeometry(0.0034, 1));
  place(gemGeometry, { scale: [1, 1.25, 1] });
  const gem = kit.group(
    'golden-peg/gem',
    kit.mesh(
      'golden-peg/gem',
      [paint(gemGeometry, '#FFC23A', { rough: 0.03, glow: 1, lamp: 1.1 })],
      kit.painted(),
    ),
  );
  gem.position.y = GEM_Y;
  const root = kit.group(
    'charm-golden-peg',
    kit.mesh('golden-peg/brushed', shafts, kit.brushed()),
    kit.mesh('golden-peg/painted', caps, kit.painted()),
    kit.mesh('golden-peg/velvet', base.velvet, kit.velvet('plain')),
  );
  root.add(gem);
  return {
    root,
    choreography: 1.2,
    burst: {
      count: 26,
      color: '#FFD978',
      shape: 'glint',
      gravity: 0.55,
      drag: 2.4,
      ring: { radius: 0.045, duration: 0.7 },
      emit: (i, random) => {
        const peg = PEGS[i % PEGS.length] ?? PEGS[0];
        const a = random() * TAU;
        const speed = 0.08 + random() * 0.14;
        return {
          start: [Math.cos(peg.angle) * PEG_RING, TOP + peg.height, Math.sin(peg.angle) * PEG_RING],
          velocity: [Math.cos(a) * speed * 0.6, 0.12 + random() * 0.18, Math.sin(a) * speed * 0.6],
          delay: random() * 0.12,
          life: 0.55 + random() * 0.45,
          size: 0.0016 + random() * 0.0016,
          accent: random() * 0.4,
        };
      },
    },
    pose(t, since, motion) {
      u.glint.value = motion > 0 ? glintAt(t, 4.6, 0) : GLINT_PARKED;
      u.lamp.value = 0.55 + 0.25 * motion * Math.sin(t * 2.1);
      u.quiver.value = 0.0011 * motion * decay(since, 4.2);
      u.quiverPhase.value = since < 0 ? 0 : since * 15 * TAU;
      if (since >= 0 && since < 0.6 && motion > 0) u.glint.value = lerp(-0.004, 0.06, since / 0.6);
      gem.rotation.y =
        motion * t * 0.6 + (since < 0 ? 0 : motion * popIn(clamp01(since / 0.6)) * TAU);
      gem.position.y = GEM_Y + motion * 0.0004 * Math.sin(t * 1.4);
      const pop = since < 0 ? 0 : pulse(since / 0.35, 0.25) * motion;
      root.scale.set(1 + pop * 0.03, 1 - pop * 0.04, 1 + pop * 0.03);
    },
  };
}

const POST_X = 0.0158;
const ROPE_SPAN = POST_X - 0.0016;
const ROPE_Y = TOP + 0.027;
const ROPE_SAG = 0.0105;
const ROPE_Z = 0.002;

function velvetRopes(ctx: ModelContext): CharmModel {
  const u = ctx.uniforms;
  const kit = new Kit(ctx.quality, u);
  const s = kit.segments;
  const base = plinth(kit, ctx.tags);
  const brushed: BufferGeometry[] = [];
  const painted: BufferGeometry[] = [...base.painted];
  for (const side of [-1, 1]) {
    const x = side * POST_X;
    brushed.push(
      place(
        lathe(
          [
            [0, 0],
            [0.0056, 0],
            [0.0057, 0.0007],
            [0.005, 0.0016],
            [0.0034, 0.0026],
            [0.0022, 0.0034],
            [0, 0.0034],
          ],
          s,
        ),
        { at: [x, TOP, ROPE_Z] },
      ),
    );
    painted.push(
      paint(
        place(
          lathe(
            [
              [0, 0.003],
              [0.0019, 0.003],
              [0.0013, 0.0046],
              [0.0013, 0.0284],
              [0.0019, 0.0289],
              [0.0019, 0.0301],
              [0.0012, 0.0306],
              [0, 0.0306],
            ],
            Math.round(s * 0.6),
          ),
          { at: [x, TOP, ROPE_Z] },
        ),
        CHARM_GOLD.polished,
        { metal: 1, rough: 0.1 },
      ),
      paint(
        place(new SphereGeometry(0.0033, Math.round(s * 0.6), 12), {
          at: [x, TOP + 0.0336, ROPE_Z],
        }),
        CHARM_GOLD.polished,
        POLISHED,
      ),
    );
    const slope = (2 * ROPE_SAG) / ROPE_SPAN;
    const dirX = -side / Math.hypot(1, slope);
    const dirY = -slope / Math.hypot(1, slope);
    const cap = new CylinderGeometry(0.0022, 0.0019, 0.0034, 16);
    place(cap, {
      at: [side * ROPE_SPAN + dirX * 0.0012, ROPE_Y + dirY * 0.0012, ROPE_Z],
      rotate: [0, 0, Math.atan2(-dirX, dirY)],
    });
    painted.push(paint(cap, CHARM_GOLD.polished, POLISHED));
  }
  const points: [number, number, number][] = [];
  for (let i = 0; i <= 10; i += 1) {
    const f = (i / 10) * 2 - 1;
    const x = f * ROPE_SPAN;
    points.push([x, -ROPE_SAG * (1 - f * f), 0.0024 * (1 - f * f)]);
  }
  const rope = paint(tube(points, 0.0017, kit.quality === 'high' ? 56 : 32, 12), '#6A0F2B', {
    glow: 0.35,
  });
  const ropeMesh = kit.mesh('velvet-ropes/rope', [rope], kit.velvet('cord'));
  const swing = kit.group('velvet-ropes/swing', ropeMesh);
  swing.position.set(0, ROPE_Y, ROPE_Z);
  const root = kit.group(
    'charm-velvet-ropes',
    kit.mesh('velvet-ropes/brushed', brushed, kit.brushed()),
    kit.mesh('velvet-ropes/painted', painted, kit.painted()),
    kit.mesh('velvet-ropes/velvet', base.velvet, kit.velvet('plain')),
  );
  root.add(swing);
  return {
    root,
    choreography: 1.4,
    burst: {
      count: 24,
      color: rivieraTokens.champagne,
      shape: 'glint',
      gravity: 0.25,
      drag: 2.8,
      ring: { radius: 0.045, duration: 0.75 },
      emit: (_, random) => {
        const f = random() * 2 - 1;
        return {
          start: [f * ROPE_SPAN, ROPE_Y - ROPE_SAG * (1 - f * f), ROPE_Z + 0.0024 * (1 - f * f)],
          velocity: [f * 0.05, 0.1 + random() * 0.16, 0.04 + random() * 0.12],
          delay: Math.abs(f) * 0.08 + random() * 0.05,
          life: 0.6 + random() * 0.4,
          size: 0.0014 + random() * 0.0015,
          accent: 0.35 + random() * 0.4,
        };
      },
    },
    pose(t, since, motion) {
      u.glint.value = motion > 0 ? glintAt(t, 5.3, 1.7) : GLINT_PARKED;
      const idle = 0.09 * Math.sin(t * 1.25) + 0.03 * Math.sin(t * 2.9 + 1);
      swing.rotation.x = motion * (idle + 0.75 * ring(since, 1.6, 2.6));
      swing.rotation.y = motion * 0.12 * ring(since, 2.3, 3.5);
    },
  };
}

const LINK_X = 0.0088;
const LINK_Y = TOP + 0.0148;
const LINK_Z = 0.0016;
const LINK_TILT = 1.0;
const LINK_YAW = 0.45;
const LINK_SNAP = 0.0022;

function cufflink(kit: Kit, side: number) {
  const s = kit.segments;
  const bezel = paint(
    lathe(
      [
        [0, -0.0004],
        [0.0062, -0.0004],
        [0.0069, 0.0002],
        [0.0071, 0.001],
        [0.0067, 0.0017],
        [0.006, 0.0019],
        [0.0059, 0.0013],
        [0, 0.0013],
      ],
      s,
    ),
    CHARM_GOLD.polished,
    POLISHED,
  );
  const post = paint(
    place(new CylinderGeometry(0.001, 0.0012, 0.0048, 12), { at: [0, -0.0028, 0] }),
    CHARM_GOLD.polished,
    POLISHED,
  );
  const toggle = paint(
    place(new CapsuleGeometry(0.0011, 0.0062, 4, 12), {
      at: [0, -0.0055, 0],
      rotate: [0, 0, Math.PI / 2],
    }),
    CHARM_GOLD.polished,
    POLISHED,
  );
  const face = place(new CircleGeometry(0.0059, s), {
    at: [0, 0.00135, 0],
    rotate: [-Math.PI / 2, 0, 0],
  });
  const link = kit.group(
    `magnet-cufflinks/link-${side < 0 ? 'left' : 'right'}`,
    kit.mesh('magnet-cufflinks/gold', [bezel, post, toggle], kit.painted()),
    kit.mesh('magnet-cufflinks/enamel', [face], kit.enamel('#081A52', '#3F72E6')),
  );
  link.rotation.order = 'YXZ';
  link.rotation.set(LINK_TILT, -side * LINK_YAW, 0);
  link.position.set(side * LINK_X, LINK_Y, LINK_Z);
  return link;
}

function poseLink(
  link: Group,
  side: number,
  phase: number,
  t: number,
  motion: number,
  drift: number,
  snap: number,
): void {
  const bob = 0.0007 * Math.sin(t * 1.7 + phase);
  link.position.set(
    side * (LINK_X - motion * drift - snap * LINK_SNAP),
    LINK_Y + motion * bob,
    LINK_Z,
  );
  link.rotation.y = -side * (LINK_YAW + motion * 0.07 * Math.sin(t * 0.9 + phase) - snap * 0.25);
}

function magnetCufflinks(ctx: ModelContext): CharmModel {
  const u = ctx.uniforms;
  const kit = new Kit(ctx.quality, u);
  const base = plinth(kit, ctx.tags);
  const painted = [...base.painted];
  const piping = new TorusGeometry(0.0145, 0.00048, 8, kit.segments + 16);
  place(piping, { at: [0, TOP + 0.0027, 0], rotate: [Math.PI / 2, 0, 0], scale: [1.13, 0.87, 1] });
  painted.push(paint(piping, CHARM_GOLD.polished, POLISHED));
  painted.push(
    paint(
      place(new SphereGeometry(0.0011, 12, 8), { at: [0, TOP + 0.0072, 0] }),
      CHARM_GOLD.polished,
      POLISHED,
    ),
  );
  const cushion = paint(
    place(new SphereGeometry(1, kit.segments, 16), {
      at: [0, TOP + 0.0027, 0],
      scale: [0.0164, 0.0047, 0.0126],
    }),
    '#14275A',
  );
  const left = cufflink(kit, -1);
  const right = cufflink(kit, 1);
  const root = kit.group(
    'charm-magnet-cufflinks',
    kit.mesh('magnet-cufflinks/painted', painted, kit.painted()),
    kit.mesh('magnet-cufflinks/velvet', [...base.velvet, cushion], kit.velvet('plain')),
  );
  root.add(left, right);
  const fieldRadius = 0.03;
  return {
    root,
    choreography: 1.3,
    burst: {
      count: 28,
      color: '#CFE0FF',
      shape: 'glint',
      gravity: 0,
      drag: 5,
      ring: { radius: 0.048, duration: 0.8 },
      emit: (i, random) => {
        const a = random() * TAU;
        if (i % 4 === 3) {
          const speed = 0.25 + random() * 0.2;
          return {
            start: [0, LINK_Y, LINK_Z],
            velocity: [Math.cos(a) * speed, 0.08 + random() * 0.15, Math.sin(a) * speed],
            delay: 0.13,
            life: 0.35 + random() * 0.25,
            size: 0.0014 + random() * 0.001,
            accent: 0.2,
          };
        }
        const r = fieldRadius * (0.7 + random() * 0.3);
        const inward = r * 5 * 0.96;
        return {
          start: [Math.cos(a) * r, LINK_Y + (random() - 0.3) * 0.012, Math.sin(a) * r],
          velocity: [-Math.cos(a) * inward, 0, -Math.sin(a) * inward],
          delay: random() * 0.06,
          life: 0.45 + random() * 0.2,
          size: 0.0011 + random() * 0.0012,
          accent: 0.6 + random() * 0.4,
        };
      },
    },
    pose(t, since, motion) {
      u.glint.value = motion > 0 ? glintAt(t, 5.9, 3.1) : GLINT_PARKED;
      let snap = 0;
      if (since >= 0) {
        snap =
          since < 0.13 ? easeInCubic(since / 0.13) : 1 - springBack(clamp01((since - 0.38) / 0.8));
      }
      snap *= motion;
      const drift = 0.00045 * Math.sin(t * 0.8);
      poseLink(left, -1, 0, t, motion, drift, snap);
      poseLink(right, 1, 1.9, t, motion, drift, snap);
    },
  };
}

const SPRING_TOP = 0.0128;
const BUMP_TRAVEL = 0.0042;
const BULBS = 12;
const BULB_RING = 0.0124;

function brassBumper(ctx: ModelContext): CharmModel {
  const u = ctx.uniforms;
  const kit = new Kit(ctx.quality, u);
  const s = kit.segments;
  const base = plinth(kit, ctx.tags);
  const painted = [...base.painted];
  painted.push(
    paint(
      place(
        lathe(
          [
            [0.0095, 0],
            [0.0166, 0],
            [0.0173, 0.0006],
            [0.0173, 0.0052],
            [0.0167, 0.006],
            [0.0151, 0.0064],
            [0.0097, 0.0064],
            [0.0094, 0.0058],
            [0.0094, 0],
          ],
          s,
        ),
        { at: [0, TOP, 0] },
      ),
      '#D8432A',
      { rough: 0.2, glow: 0.45 },
    ),
  );
  for (let i = 0; i < BULBS; i += 1) {
    const a = (i / BULBS) * TAU;
    painted.push(
      paint(
        place(new SphereGeometry(0.00092, 10, 6), {
          at: [Math.cos(a) * BULB_RING, TOP + 0.0066, Math.sin(a) * BULB_RING],
        }),
        '#FFD9A0',
        { rough: 0.08, glow: 0.6, lamp: 3.2 },
      ),
    );
  }
  painted.push(
    paint(
      place(
        lathe(
          [
            [0.0174, 0.0018],
            [0.0177, 0.0021],
            [0.0177, 0.0035],
            [0.0174, 0.0038],
          ],
          s,
        ),
        { at: [0, TOP, 0] },
      ),
      CHARM_GOLD.brushed,
      { metal: 1, rough: 0.24, glow: 0.6 },
    ),
  );
  const spring = kit.mesh(
    'brass-bumper/spring',
    [
      paint(helix(0.0068, 0.0008, 0.001, SPRING_TOP, 4.5), CHARM_GOLD.polished, {
        metal: 1,
        rough: 0.16,
        glow: 0.4,
      }),
    ],
    kit.painted(),
  );
  const springPivot = kit.group('brass-bumper/spring-pivot', spring);
  springPivot.position.y = TOP;
  const cap = kit.mesh(
    'brass-bumper/cap',
    [
      paint(
        lathe(
          [
            [0, 0],
            [0.0058, 0],
            [0.0148, 0.001],
            [0.0167, 0.0022],
            [0.017, 0.0034],
            [0.0161, 0.0046],
            [0.0123, 0.0061],
            [0.0062, 0.0071],
            [0, 0.0074],
          ],
          s,
        ),
        CHARM_GOLD.brushed,
        { metal: 1, rough: 0.2, glow: 0.8 },
      ),
      paint(
        place(new SphereGeometry(0.0036, 24, 12, 0, TAU, 0, Math.PI / 2), {
          at: [0, 0.0069, 0],
          scale: [1, 0.62, 1],
        }),
        '#FF3A1E',
        {
          rough: 0.05,
          glow: 1,
          lamp: 0.7,
        },
      ),
      paint(
        place(new TorusGeometry(0.0037, 0.0005, 6, 32), {
          at: [0, 0.007, 0],
          rotate: [Math.PI / 2, 0, 0],
        }),
        CHARM_GOLD.polished,
        POLISHED,
      ),
    ],
    kit.painted(),
  );
  const capPivot = kit.group('brass-bumper/cap-pivot', cap);
  capPivot.position.y = TOP + SPRING_TOP;
  const root = kit.group(
    'charm-brass-bumper',
    kit.mesh('brass-bumper/painted', painted, kit.painted()),
    kit.mesh('brass-bumper/velvet', base.velvet, kit.velvet('plain')),
  );
  root.add(springPivot, capPivot);
  return {
    root,
    choreography: 1.1,
    burst: {
      count: 30,
      color: '#FFC27A',
      shape: 'glint',
      gravity: 1.1,
      drag: 3.2,
      ring: { radius: 0.06, duration: 0.55 },
      emit: (_, random) => {
        const a = random() * TAU;
        const speed = 0.3 + random() * 0.32;
        return {
          start: [Math.cos(a) * 0.016, TOP + SPRING_TOP + 0.002, Math.sin(a) * 0.016],
          velocity: [Math.cos(a) * speed, 0.06 + random() * 0.14, Math.sin(a) * speed],
          delay: 0.06 + random() * 0.03,
          life: 0.35 + random() * 0.3,
          size: 0.0013 + random() * 0.0013,
          accent: random() * 0.7,
        };
      },
    },
    pose(t, since, motion) {
      u.glint.value = motion > 0 ? glintAt(t, 4.9, 2.2) : GLINT_PARKED;
      u.chaseAmount.value = motion > 0 ? 1 : 0;
      u.chase.value = t * (since >= 0 && since < 0.9 ? 9 : 2.4);
      let travel = motion * 0.00025 * (Math.sin(t * 2.2) - 1);
      let squash = 0;
      if (since >= 0 && motion > 0) {
        if (since < 0.07) {
          const k = easeOutQuad(since / 0.07);
          travel -= BUMP_TRAVEL * k;
          squash = k;
        } else {
          const r = since - 0.07;
          const spring = Math.exp(-r * 7) * Math.cos(r * 30);
          travel -= BUMP_TRAVEL * spring;
          squash = spring;
        }
      }
      u.lamp.value = 1 + 2.2 * (since < 0 ? 0 : pulse(since / 0.6, 0.12));
      capPivot.position.y = TOP + SPRING_TOP + travel;
      springPivot.scale.y = (SPRING_TOP + travel) / SPRING_TOP;
      const bulge = 1 + 0.07 * squash;
      capPivot.scale.set(bulge, 1 - 0.1 * squash, bulge);
    },
  };
}

const BODY_H = 0.022;
const BODY_R = 0.0101;
const BODY_LIFT = 0.0042;
const HEAD_Y = 0.0212;

function bodyRadius(y: number): number {
  const centre = 0.0105;
  const e = (y - centre) / (y < centre ? 0.0112 : 0.0118);
  return BODY_R * Math.sqrt(Math.max(0, 1 - e * e));
}

function bodyProfile(from: number, to: number, steps: number, inflate: number): Profile {
  const points: [number, number][] = [];
  for (let i = 0; i <= steps; i += 1) {
    const y = from + ((to - from) * i) / steps;
    points.push([bodyRadius(y) * inflate, y]);
  }
  return points;
}

/**
 * The shirt front: a patch of the body's own surface whose width narrows to a point at the
 * waist, so the tuxedo's lapels open into a V.
 */
function shirtFront(segments: number): BufferGeometry {
  const from = 0.0088;
  const to = 0.0206;
  const half = 0.62;
  const shirt = new LatheGeometry(
    bodyProfile(from, to, 14, 1.012).map(([r, y]) => new Vector2(r, y)),
    segments,
    -half,
    half * 2,
  );
  const position = shirt.getAttribute('position');
  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i);
    const y = position.getY(i);
    const z = position.getZ(i);
    const r = Math.hypot(x, z);
    const open = Math.pow(clamp01((y - from) / (to - from)), 0.85);
    const phi = Math.atan2(x, z) * open;
    position.setXYZ(i, r * Math.sin(phi), y, r * Math.cos(phi));
  }
  shirt.computeVertexNormals();
  return shirt;
}

function butler(ctx: ModelContext): CharmModel {
  const u = ctx.uniforms;
  const kit = new Kit(ctx.quality, u);
  const s = kit.segments;
  const base = plinth(kit, ctx.tags);
  const tux = '#0B0D14';
  const ivory = rivieraTokens.ivory;
  const brush = kit.mesh(
    'butler/brush',
    [
      paint(
        lathe(
          [
            [0, 0],
            [0.0106, 0],
            [0.0116, 0.0012],
            [0.0113, 0.0032],
            [0.0092, 0.0041],
            [0, 0.0041],
          ],
          s,
        ),
        '#3A2E26',
      ),
    ],
    kit.velvet('bristle'),
  );
  const brushPivot = kit.group('butler/brush-pivot', brush);
  brushPivot.position.y = TOP;

  const body: BufferGeometry[] = [
    paint(lathe([...bodyProfile(0, BODY_H, 22, 1), [0, BODY_H + 0.0002]], s), tux, { rough: 0.28 }),
    paint(shirtFront(16), ivory, { rough: 0.55 }),
  ];
  for (const y of [0.0122, 0.0152]) {
    const r = bodyRadius(y) * 1.02;
    body.push(
      paint(
        place(new SphereGeometry(0.00072, 10, 6), { at: [0, y, r] }),
        CHARM_GOLD.polished,
        POLISHED,
      ),
    );
  }
  const neck = bodyRadius(0.0197) + 0.0004;
  for (const side of [-1, 1]) {
    body.push(
      paint(
        place(new ConeGeometry(0.0024, 0.004, 12), {
          at: [side * 0.0021, 0.0197, neck],
          rotate: [0, 0, (side * Math.PI) / 2],
          scale: [1, 1, 0.55],
        }),
        CHARM_GOLD.polished,
        POLISHED,
      ),
    );
  }
  body.push(
    paint(
      place(new SphereGeometry(0.0011, 10, 8), { at: [0, 0.0197, neck + 0.0003] }),
      CHARM_GOLD.polished,
      POLISHED,
    ),
  );
  body.push(
    paint(
      tube(
        [
          [0.0086, 0.0166, 0],
          [0.0114, 0.0152, 0.0012],
          [0.0128, 0.0166, 0.0036],
          [0.0136, 0.0178, 0.0044],
        ],
        0.0012,
        16,
        8,
      ),
      tux,
      { rough: 0.3 },
    ),
    paint(
      tube(
        [
          [-0.0086, 0.0166, 0],
          [-0.0112, 0.0138, 0.0008],
          [-0.012, 0.0112, 0.0018],
        ],
        0.0012,
        12,
        8,
      ),
      tux,
      { rough: 0.3 },
    ),
    paint(place(new SphereGeometry(0.0017, 12, 8), { at: [-0.012, 0.0108, 0.0019] }), ivory, {
      rough: 0.5,
    }),
    paint(place(new SphereGeometry(0.0016, 12, 8), { at: [0.0136, 0.0178, 0.0044] }), ivory, {
      rough: 0.5,
    }),
    paint(
      place(
        lathe(
          [
            [0, 0],
            [0.0046, 0],
            [0.005, 0.0006],
            [0.0048, 0.0009],
            [0.0044, 0.0004],
            [0, 0.0004],
          ],
          s,
        ),
        { at: [0.0138, 0.0192, 0.0046] },
      ),
      CHROME,
      { metal: 1, rough: 0.07, glow: 0.4 },
    ),
    paint(
      place(new CylinderGeometry(0.0021, 0.0021, 0.0007, 20), { at: [0.0138, 0.01995, 0.0046] }),
      CHARM_GOLD.polished,
      { metal: 1, rough: 0.18, glow: 1 },
    ),
  );

  const visorTheta = 1.18;
  const head: BufferGeometry[] = [
    paint(place(new SphereGeometry(0.0068, s, 16), { at: [0, 0.006, 0] }), tux, { rough: 0.18 }),
    paint(
      place(new SphereGeometry(0.00688, 24, 6, Math.PI / 2 - 0.85, 1.7, visorTheta, 0.42), {
        at: [0, 0.006, 0],
      }),
      rivieraTokens['sea-glass'],
      { rough: 0.05, glow: 0.5, lamp: 1.3 },
    ),
  ];
  const hatTilt = [0, 0, 0.12] as const;
  head.push(
    paint(
      place(
        lathe(
          [
            [0, 0.0111],
            [0.0074, 0.0111],
            [0.0079, 0.0114],
            [0.0075, 0.0118],
            [0.0047, 0.0119],
            [0.0049, 0.0204],
            [0.0045, 0.021],
            [0, 0.021],
          ],
          s,
        ),
        { rotate: hatTilt },
      ),
      tux,
      { rough: 0.38 },
    ),
    paint(
      place(
        lathe(
          [
            [0.00478, 0.0121],
            [0.00492, 0.0122],
            [0.00502, 0.0138],
            [0.00488, 0.0139],
          ],
          s,
        ),
        { rotate: hatTilt },
      ),
      CHARM_GOLD.polished,
      POLISHED,
    ),
  );
  const headPivot = kit.group('butler/head', kit.mesh('butler/head', head, kit.painted()));
  headPivot.position.y = HEAD_Y;
  const bodyPivot = kit.group('butler/body', kit.mesh('butler/body', body, kit.painted()));
  bodyPivot.add(headPivot);
  bodyPivot.position.y = TOP + BODY_LIFT;

  const root = kit.group(
    'charm-butler',
    kit.mesh('butler/painted', base.painted, kit.painted()),
    kit.mesh('butler/velvet', base.velvet, kit.velvet('plain')),
  );
  root.add(brushPivot, bodyPivot);
  const spin = easeOutBack(1.4);
  return {
    root,
    choreography: 1.2,
    burst: {
      count: 28,
      color: '#E8FFF9',
      shape: 'glint',
      gravity: 0.15,
      drag: 3,
      ring: { radius: 0.046, duration: 0.8 },
      emit: (_, random) => {
        const a = random() * TAU;
        const r = 0.011 + random() * 0.004;
        const tangential = 0.12 + random() * 0.12;
        const out = 0.05 + random() * 0.08;
        return {
          start: [Math.cos(a) * r, TOP + 0.002 + random() * 0.004, Math.sin(a) * r],
          velocity: [
            Math.cos(a) * out - Math.sin(a) * tangential,
            0.04 + random() * 0.1,
            Math.sin(a) * out + Math.cos(a) * tangential,
          ],
          delay: random() * 0.25,
          life: 0.45 + random() * 0.35,
          size: 0.0011 + random() * 0.0013,
          accent: 0.3 + random() * 0.6,
        };
      },
    },
    pose(t, since, motion) {
      u.glint.value = GLINT_PARKED;
      const active = since >= 0;
      const turn = active ? spin(since / 0.75) * TAU : 0;
      const hop = active ? Math.sin(Math.PI * clamp01(since / 0.42)) * 0.0045 : 0;
      bodyPivot.position.y = TOP + BODY_LIFT + motion * (0.0005 * Math.sin(t * 2.4) + hop);
      bodyPivot.rotation.y = motion * (turn + 0.12 * Math.sin(t * 0.37));
      bodyPivot.rotation.z = motion * 0.03 * Math.sin(t * 1.2);
      headPivot.rotation.y =
        motion * 0.5 * Math.sin(t * 0.55) * Math.min(1, 1.6 * Math.abs(Math.sin(t * 0.21)));
      brushPivot.rotation.y = motion * (t * 1.6 + (active ? 40 * (1 - Math.exp(-since * 2.5)) : 0));
      const blinkPhase = (t % 3.7) / 3.7;
      const blink = motion > 0 && blinkPhase > 0.96 ? 0.15 : 1;
      u.lamp.value = blink * (1 + (active ? 2.5 * pulse(since / 0.7, 0.15) : 0));
    },
  };
}

const BOTTLE_X = 0.003;
const FACETS = 10;
const NOZZLE: readonly [number, number, number] = [BOTTLE_X, TOP + 0.0322, 0.0058];

function perfumeAtomizer(ctx: ModelContext): CharmModel {
  const u = ctx.uniforms;
  const kit = new Kit(ctx.quality, u);
  const s = kit.segments;
  const base = plinth(kit, ctx.tags);
  const at = [BOTTLE_X, TOP, 0] as const;
  const glass = facet(
    new LatheGeometry(
      (
        [
          [0, 0],
          [0.008, 0],
          [0.0093, 0.0012],
          [0.0099, 0.006],
          [0.0095, 0.014],
          [0.0081, 0.019],
          [0.005, 0.0225],
          [0.0032, 0.024],
          [0.003, 0.0262],
          [0, 0.0262],
        ] as const
      ).map(([r, y]) => new Vector2(r, y)),
      FACETS,
      Math.PI / FACETS,
    ),
  );
  place(glass, { at });
  const scentGeo = facet(
    new LatheGeometry(
      (
        [
          [0, 0.0013],
          [0.0079, 0.0013],
          [0.0086, 0.006],
          [0.0083, 0.014],
          [0.008, 0.0142],
          [0, 0.0142],
        ] as const
      ).map(([r, y]) => new Vector2(r, y)),
      FACETS,
      Math.PI / FACETS,
    ),
  );
  place(scentGeo, { at });
  const scent = kit.mesh('perfume-atomizer/scent', [scentGeo], kit.scent('#B0124A'));
  scent.renderOrder = 1;
  const crystal = kit.mesh('perfume-atomizer/crystal', [glass], kit.crystal());
  crystal.renderOrder = 2;
  crystal.castShadow = false;

  const gold: BufferGeometry[] = [...base.painted];
  gold.push(
    paint(
      place(
        lathe(
          [
            [0, 0.0252],
            [0.0037, 0.0252],
            [0.0043, 0.0258],
            [0.0043, 0.0288],
            [0.0037, 0.0296],
            [0.0026, 0.0299],
            [0.0026, 0.0336],
            [0.0022, 0.0344],
            [0, 0.0346],
          ],
          s,
        ),
        { at },
      ),
      CHARM_GOLD.polished,
      POLISHED,
    ),
    paint(
      place(new CylinderGeometry(0.0007, 0.0008, 0.0034, 10), {
        at: [BOTTLE_X, TOP + 0.0322, 0.0039],
        rotate: [Math.PI / 2, 0, 0],
      }),
      CHARM_GOLD.polished,
      POLISHED,
    ),
    paint(
      tube(
        [
          [BOTTLE_X - 0.0038, TOP + 0.0272, 0],
          [BOTTLE_X - 0.0075, TOP + 0.0284, 0.0004],
          [BOTTLE_X - 0.0112, TOP + 0.0268, 0.0006],
          [BOTTLE_X - 0.0132, TOP + 0.0232, 0.0004],
        ],
        0.0008,
        20,
        8,
      ),
      '#8E2447',
      { rough: 0.45, glow: 0.3 },
    ),
  );
  const bulbAt = [BOTTLE_X - 0.0133, TOP + 0.0226, 0.0004] as const;
  const bulb = kit.mesh(
    'perfume-atomizer/bulb',
    [
      paint(
        place(new SphereGeometry(0.0051, s, 16), { at: [0, -0.0062, 0], scale: [1, 1.22, 1] }),
        '#8E1F48',
        {
          glow: 0.4,
        },
      ),
      paint(
        place(new CylinderGeometry(0.0006, 0.0023, 0.0076, 18, 1, true), { at: [0, -0.0166, 0] }),
        '#D9B25A',
        { glow: 0.6 },
      ),
      paint(place(new SphereGeometry(0.0011, 10, 8), { at: [0, -0.0128, 0] }), '#D9B25A'),
    ],
    kit.velvet('net'),
  );
  const bulbPivot = kit.group('perfume-atomizer/bulb-pivot', bulb);
  bulbPivot.position.set(bulbAt[0], bulbAt[1], bulbAt[2]);
  const bottle = kit.group(
    'perfume-atomizer/bottle',
    kit.mesh('perfume-atomizer/painted', gold, kit.painted()),
    scent,
    crystal,
  );
  const root = kit.group(
    'charm-perfume-atomizer',
    kit.mesh('perfume-atomizer/velvet', base.velvet, kit.velvet('plain')),
  );
  root.add(bottle, bulbPivot);
  return {
    root,
    choreography: 1.3,
    burst: {
      count: 22,
      color: '#FFC6DD',
      shape: 'mist',
      gravity: -0.03,
      drag: 2.6,
      ring: { radius: 0.05, duration: 1.0 },
      emit: (_, random) => {
        const spread = (random() * 2 - 1) * 0.45;
        const lift = (random() * 2 - 1) * 0.18 + 0.05;
        const speed = 0.16 + random() * 0.2;
        return {
          start: [NOZZLE[0], NOZZLE[1], NOZZLE[2]],
          velocity: [Math.sin(spread) * speed, lift * speed, Math.cos(spread) * speed],
          delay: 0.08 + random() * 0.14,
          life: 0.8 + random() * 0.5,
          size: 0.0035 + random() * 0.003,
          accent: random() * 0.5,
        };
      },
    },
    pose(t, since, motion) {
      u.glint.value = motion > 0 ? glintAt(t, 6.1, 0.6) : GLINT_PARKED;
      u.lamp.value = 1 + 0.12 * motion * Math.sin(t * 1.7);
      let squeeze = 0;
      if (since >= 0) {
        squeeze =
          since < 0.09 ? easeOutQuad(since / 0.09) : 1 - springBack(clamp01((since - 0.09) / 0.7));
      }
      squeeze *= motion;
      const breathe = motion * 0.02 * Math.sin(t * 1.3);
      bulbPivot.scale.set(
        1 + 0.22 * squeeze + breathe,
        1 - 0.2 * squeeze - breathe,
        1 + 0.22 * squeeze + breathe,
      );
      bulbPivot.rotation.z = motion * (0.06 * Math.sin(t * 1.1) - 0.1 * squeeze);
      const recoil = since < 0 ? 0 : pulse(since / 0.3, 0.3) * motion;
      bottle.position.z = -0.0007 * recoil;
      bottle.rotation.x = -0.05 * recoil;
      bottle.scale.setScalar(1 + 0.025 * popIn(clamp01(since / 0.25)) * recoil);
    },
  };
}

const BUILDERS: Readonly<Record<CharmKind, (ctx: ModelContext) => CharmModel>> = {
  'golden-peg': goldenPeg,
  'velvet-ropes': velvetRopes,
  'magnet-cufflinks': magnetCufflinks,
  'brass-bumper': brassBumper,
  butler,
  'perfume-atomizer': perfumeAtomizer,
};

export function buildCharmModel(kind: CharmKind, ctx: ModelContext): CharmModel {
  return BUILDERS[kind](ctx);
}
