import type { CurrencyDef } from '../types.ts';

export const currencies = [
  {
    id: 'coins',
    kind: 'soft',
    resetsOnAscension: true,
    sources: ['pushOffLedge', 'offlineVault', 'vaultCrate', 'stewardAllowance'],
    sinks: ['drop', 'venueUpgrade'],
  },
  {
    id: 'bullion',
    kind: 'progress',
    resetsOnAscension: true,
    sources: ['coinWinnings'],
    sinks: ['ascensionThreshold'],
  },
  {
    id: 'goldBars',
    kind: 'prestige',
    resetsOnAscension: false,
    sources: ['venueAscension'],
    sinks: ['familyOffice'],
  },
  {
    id: 'pearls',
    kind: 'premium',
    resetsOnAscension: false,
    sources: ['quests', 'albumSets', 'seasonTrack', 'heirloomPush', 'vaultCrate'],
    sinks: ['keys', 'safeSkip', 'gachaTickets', 'cosmetics'],
  },
  {
    id: 'keys',
    kind: 'utility',
    resetsOnAscension: false,
    sources: ['vaultCrate', 'quests', 'seasonTrack'],
    sinks: ['openSafe'],
  },
  {
    id: 'tickets',
    kind: 'utility',
    resetsOnAscension: false,
    sources: ['quests', 'goldenHour', 'seasonTrack', 'vaultCrate'],
    sinks: ['gachaPull'],
  },
  {
    id: 'stars',
    kind: 'seasonXp',
    resetsOnAscension: false,
    sources: ['drops', 'vaultCrate', 'albumSets', 'quests'],
    sinks: ['seasonTiers'],
  },
] as const satisfies readonly CurrencyDef[];
