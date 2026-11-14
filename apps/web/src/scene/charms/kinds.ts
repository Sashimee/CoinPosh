/**
 * The six Charm Board pieces (00-VISION §2), spelled like the catalog keys the shared fixtures
 * use. Local until packages/shared grows a charm kind union; the glue (T-3.01) maps catalog
 * charm types onto these.
 */
export const CHARM_KINDS = [
  'golden-peg',
  'velvet-ropes',
  'magnet-cufflinks',
  'brass-bumper',
  'butler',
  'perfume-atomizer',
] as const;

export type CharmKind = (typeof CHARM_KINDS)[number];

export const SYNERGY_TAGS = ['gilded', 'magnetic', 'kinetic', 'service', 'fragrant'] as const;

export type SynergyTag = (typeof SYNERGY_TAGS)[number];

export function isCharmKind(value: unknown): value is CharmKind {
  return typeof value === 'string' && (CHARM_KINDS as readonly string[]).includes(value);
}

/** Enamel colour each synergy tag inlays in the plinth ring and lends to the activation flash. */
export const SYNERGY_COLORS: Readonly<Record<SynergyTag, string>> = {
  gilded: '#E8C15A',
  magnetic: '#4C7BEA',
  kinetic: '#FF7A59',
  service: '#7FD1C7',
  fragrant: '#E79BC4',
};

export const DEFAULT_CHARM_TAGS: Readonly<Record<CharmKind, readonly SynergyTag[]>> = {
  'golden-peg': ['gilded'],
  'velvet-ropes': ['service'],
  'magnet-cufflinks': ['magnetic'],
  'brass-bumper': ['kinetic'],
  butler: ['service'],
  'perfume-atomizer': ['fragrant'],
};

/**
 * One socket on the table, metres (+Y up, socket centre at the origin, the table floor at
 * y = 0). The plinth fills the footprint; nothing a charm draws at rest leaves this cylinder,
 * so neighbouring sockets never overlap. Activation FX may spill past it.
 */
export const CHARM_SOCKET = {
  radius: 0.025,
  maxHeight: 0.062,
} as const;
