import { charms } from '@coinposh/economy';
import type { CharmKind, SynergyTag } from '@coinposh/shared';

export {
  CHARM_KINDS,
  isCharmKind,
  SYNERGY_TAGS,
  type CharmKind,
  type SynergyTag,
} from '@coinposh/shared';

/** Enamel colour each synergy tag inlays in the plinth ring and lends to the activation flash. */
export const SYNERGY_COLORS: Readonly<Record<SynergyTag, string>> = {
  gilded: '#E8C15A',
  magnetic: '#4C7BEA',
  kinetic: '#FF7A59',
  service: '#7FD1C7',
  fragrant: '#E79BC4',
};

/** Each kind's synergy tags from the economy catalog, primary tag first. */
export const DEFAULT_CHARM_TAGS: Readonly<Record<CharmKind, readonly SynergyTag[]>> = {
  'golden-peg': charms.kinds['golden-peg'].tags,
  'velvet-ropes': charms.kinds['velvet-ropes'].tags,
  'magnet-cufflinks': charms.kinds['magnet-cufflinks'].tags,
  'brass-bumper': charms.kinds['brass-bumper'].tags,
  butler: charms.kinds.butler.tags,
  'perfume-atomizer': charms.kinds['perfume-atomizer'].tags,
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
