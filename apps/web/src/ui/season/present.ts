import type { Reward, RewardPreview } from '@coinposh/shared';
import { formatInteger, type Language } from '../../i18n/index.ts';
import type { ClaimStatus } from './claim.ts';
import type { SeasonT } from './i18n.ts';
import type { QuestCardView, TierView, TimeLeft } from './model.ts';

export function rewardText(t: SeasonT, reward: RewardPreview, language: Language): string {
  switch (reward.kind) {
    case 'currency':
      return t(`reward.${reward.currency}`, {
        count: reward.amount,
        value: formatInteger(reward.amount, language),
      });
    case 'scratchCard':
      return t('reward.scratchCard', {
        count: reward.count,
        value: formatInteger(reward.count, language),
      });
    case 'charm':
      return t('reward.charm');
    case 'safe':
      return t('reward.safe');
    case 'collectible':
      return t('reward.collectible');
  }
}

/** A claim answer's rewards in the preview shape the chips speak, one entry per grant. */
export function rewardPreviews(rewards: readonly Reward[]): RewardPreview[] {
  return rewards.map((reward): RewardPreview => {
    switch (reward.kind) {
      case 'currency':
        return reward;
      case 'charm':
        return { kind: 'charm', charmType: reward.charmType };
      case 'safe':
        return { kind: 'safe', safeType: reward.safe.type };
      case 'scratchCard':
        return { kind: 'scratchCard', count: 1 };
      case 'collectible':
        return { kind: 'collectible', collectibleId: reward.collectibleId };
    }
  });
}

export function rewardsText(
  t: SeasonT,
  rewards: readonly RewardPreview[],
  language: Language,
): string {
  const parts = rewards.map((reward) => rewardText(t, reward, language));
  return new Intl.ListFormat(language, { style: 'long', type: 'conjunction' }).format(parts);
}

export function questTitle(t: SeasonT, card: QuestCardView, language: Language): string {
  return t(`metric.${card.metric}`, {
    count: card.target,
    value: formatInteger(card.target, language),
  });
}

export function questProgressText(t: SeasonT, card: QuestCardView, language: Language): string {
  return t('quest.progress', {
    progress: formatInteger(card.progress, language),
    target: formatInteger(card.target, language),
  });
}

export type QuestActionKind = 'progress' | 'claim' | 'claiming' | 'claimed' | 'already' | 'retry';

/**
 * What the card's action slot shows. A claim in flight or a failure outranks the server's
 * view, so a tap is never answered by a stale button; a claimed quest stamps whichever way it
 * got there.
 */
export function questAction(card: QuestCardView, status: ClaimStatus): QuestActionKind {
  switch (status) {
    case 'pending':
      return 'claiming';
    case 'failed':
      return 'retry';
    case 'already':
      return 'already';
    case 'claimed':
      return 'claimed';
    case 'idle':
      if (card.claimed) return 'claimed';
      return card.ready ? 'claim' : 'progress';
  }
}

export function timeText(t: SeasonT, left: TimeLeft, language: Language): string {
  const n = (value: number) => formatInteger(value, language);
  switch (left.unit) {
    case 'days':
      return t('time.days', { days: n(left.days), hours: n(left.hours) });
    case 'hours':
      return t('time.hours', { hours: n(left.hours), minutes: n(left.minutes) });
    case 'minutes':
      return t('time.minutes', { minutes: n(left.minutes) });
    case 'soon':
      return t('time.soon');
  }
}

export type TrackSide = 'free' | 'premium';

export function tierStateText(t: SeasonT, tier: TierView, side: TrackSide): string {
  const state = side === 'free' ? tier.freeState : tier.premiumState;
  return state === 'comingSoon' ? t('season.comingSoon') : t(`season.${state}`);
}

export function tierLabel(t: SeasonT, tier: TierView, side: TrackSide, language: Language): string {
  const rewards = side === 'free' ? tier.free : tier.premium;
  return t('season.tierLabel', {
    tier: formatInteger(tier.tier, language),
    track: t(`season.${side}`),
    rewards: rewardsText(t, rewards, language),
    state: tierStateText(t, tier, side),
  });
}
