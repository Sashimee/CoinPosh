import { z } from 'zod';
import { WalletSchema } from '../../domain.ts';
import { AmountSchema, EpochMsSchema, PositiveAmountSchema } from '../../primitives.ts';
import { LiveGrantSchema, LiveRewardSchema } from '../liveEvents/rewards.ts';
import {
  GuestArcIdSchema,
  LetterConditionKeySchema,
  LetterIdSchema,
  WaxSealIdSchema,
  WorldGuestIdSchema,
  isKeyedUnder,
} from './ids.ts';
import { checkNotAfter, checkUnique } from './refine.ts';

/** Every guest arc is told in five letters (00-VISION, guest stories). */
export const LETTERS_PER_ARC = 5;

/** A recurring guest: who signs the letters and the seal the reveal cracks. */
export const WorldGuestSchema = z.object({
  id: WorldGuestIdSchema,
  seal: WaxSealIdSchema,
});
export type WorldGuest = z.infer<typeof WorldGuestSchema>;

/**
 * What a sealed letter waits on, all judged by the server. `letter`: another letter read first.
 * `progress`: a server stat reaching `target`, worded by the UI from `key`; `progress` is capped at
 * `target`. `postedAt`: the post arrives at that server time.
 */
export const LetterConditionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('letter'), letter: LetterIdSchema, met: z.boolean() }),
  z
    .object({
      kind: z.literal('progress'),
      key: LetterConditionKeySchema,
      target: PositiveAmountSchema,
      progress: AmountSchema,
    })
    .refine((condition) => condition.progress <= condition.target, {
      path: ['progress'],
      message: 'Progress is shown capped at its target.',
    }),
  z.object({ kind: z.literal('postedAt'), at: EpochMsSchema }),
]);
export type LetterCondition = z.infer<typeof LetterConditionSchema>;
export type LetterConditionKind = LetterCondition['kind'];

/** Whether the server would count `condition` as met at `serverTime`. */
export function isLetterConditionMet(condition: LetterCondition, serverTime: number): boolean {
  switch (condition.kind) {
    case 'letter':
      return condition.met;
    case 'progress':
      return condition.progress >= condition.target;
    case 'postedAt':
      return condition.at <= serverTime;
  }
}

/**
 * `sealed`: not yet delivered, showing what it waits on and what it will pay. `delivered`: in the
 * player's tray with its wax seal intact. `opened`: read, its rewards paid.
 */
export const LETTER_STATUSES = ['sealed', 'delivered', 'opened'] as const;
export const LetterStatusSchema = z.enum(LETTER_STATUSES);
export type LetterStatus = z.infer<typeof LetterStatusSchema>;

const letterFields = {
  id: LetterIdSchema,
  index: PositiveAmountSchema.max(LETTERS_PER_ARC),
};

/**
 * One letter as the server keeps it. The text is the template `id` resolves to; rewards are
 * `packages/economy` numbers the server reads out, paid once when the letter is opened.
 */
export const LetterSchema = z
  .discriminatedUnion('status', [
    z.object({
      ...letterFields,
      status: z.literal('sealed'),
      conditions: z.array(LetterConditionSchema).min(1),
      rewards: z.array(LiveRewardSchema),
    }),
    z.object({
      ...letterFields,
      status: z.literal('delivered'),
      deliveredAt: EpochMsSchema,
      rewards: z.array(LiveRewardSchema),
    }),
    z.object({
      ...letterFields,
      status: z.literal('opened'),
      deliveredAt: EpochMsSchema,
      openedAt: EpochMsSchema,
      granted: z.array(LiveGrantSchema),
    }),
  ])
  .superRefine((letter, ctx) => {
    if (letter.status === 'opened' && letter.openedAt < letter.deliveredAt) {
      ctx.addIssue({
        code: 'custom',
        path: ['openedAt'],
        message: 'A letter is opened after it is delivered.',
      });
    }
    if (letter.status === 'sealed') {
      checkUnique(
        letter.conditions,
        (condition) =>
          condition.kind === 'letter'
            ? `letter:${condition.letter}`
            : condition.kind === 'progress'
              ? `progress:${condition.key}`
              : 'postedAt',
        ctx,
        (i) => ['conditions', i],
        'A letter lists each condition once.',
      );
    }
  });
export type Letter = z.infer<typeof LetterSchema>;

/**
 * One guest's story, letters in order. Letters arrive one at a time: each is delivered only once
 * the one before is opened, so an arc reads as opened letters, at most one waiting in its seal,
 * then sealed ones. `completedAt` is when the last letter was opened.
 */
export const GuestArcSchema = z
  .object({
    id: GuestArcIdSchema,
    guest: WorldGuestIdSchema,
    letters: z.array(LetterSchema).length(LETTERS_PER_ARC),
    completedAt: EpochMsSchema.nullable(),
  })
  .superRefine((arc, ctx) => {
    const issue = (path: PropertyKey[], message: string) => {
      ctx.addIssue({ code: 'custom', path, message });
    };
    if (!isKeyedUnder(arc.id, arc.guest)) {
      issue(['id'], `Arc ${arc.id} is keyed under its guest, as "${arc.guest}.<story>".`);
    }
    arc.letters.forEach((letter, i) => {
      if (letter.index !== i + 1) issue(['letters', i, 'index'], 'Letters are listed in order.');
      if (!isKeyedUnder(letter.id, arc.id)) {
        issue(['letters', i, 'id'], `Letter ${letter.id} is keyed under its arc ${arc.id}.`);
      }
      const previous = arc.letters[i - 1];
      if (previous === undefined || letter.status === 'sealed') return;
      if (previous.status !== 'opened') {
        issue(['letters', i, 'status'], 'A letter arrives only once the one before is opened.');
      } else if (letter.deliveredAt < previous.openedAt) {
        issue(['letters', i, 'deliveredAt'], 'A letter arrives after the one before is opened.');
      }
    });
    checkUnique(
      arc.letters,
      (letter) => letter.id,
      ctx,
      (i) => ['letters', i, 'id'],
      'Each letter is listed once.',
    );
    const last = arc.letters.at(-1);
    const complete = last?.status === 'opened';
    if (complete !== (arc.completedAt !== null)) {
      issue(
        ['completedAt'],
        'An arc has a completion time exactly when its last letter is opened.',
      );
    } else if (last?.status === 'opened' && arc.completedAt !== last.openedAt) {
      issue(['completedAt'], 'An arc completes when its last letter is opened.');
    }
  });
export type GuestArc = z.infer<typeof GuestArcSchema>;

function checkArcsAt(
  arcs: readonly GuestArc[],
  serverTime: number,
  ctx: z.RefinementCtx,
  path: PropertyKey[],
): void {
  arcs.forEach((arc, a) => {
    arc.letters.forEach((letter, l) => {
      const at = [...path, a, 'letters', l];
      if (letter.status === 'sealed') {
        if (letter.conditions.every((condition) => isLetterConditionMet(condition, serverTime))) {
          ctx.addIssue({
            code: 'custom',
            path: [...at, 'conditions'],
            message: 'A letter whose conditions are all met has been delivered.',
          });
        }
        return;
      }
      const late = 'A letter cannot be stamped after the server time.';
      checkNotAfter(letter.deliveredAt, serverTime, ctx, [...at, 'deliveredAt'], late);
      if (letter.status === 'opened') {
        checkNotAfter(letter.openedAt, serverTime, ctx, [...at, 'openedAt'], late);
      }
    });
  });
}

/**
 * The player's letters: every guest who writes, and every arc begun or teased. `unread` counts the
 * letters waiting in their seals, for the tray badge.
 */
export const LettersResponseSchema = z
  .object({
    serverTime: EpochMsSchema,
    guests: z.array(WorldGuestSchema),
    arcs: z.array(GuestArcSchema),
    unread: AmountSchema,
  })
  .superRefine((answer, ctx) => {
    checkUnique(
      answer.guests,
      (guest) => guest.id,
      ctx,
      (i) => ['guests', i, 'id'],
      'Each guest is listed once.',
    );
    checkUnique(
      answer.arcs,
      (arc) => arc.id,
      ctx,
      (i) => ['arcs', i, 'id'],
      'Each arc is listed once.',
    );
    const guests = new Set(answer.guests.map((guest) => guest.id));
    answer.arcs.forEach((arc, i) => {
      if (!guests.has(arc.guest)) {
        ctx.addIssue({
          code: 'custom',
          path: ['arcs', i, 'guest'],
          message: `Guest ${arc.guest} writes this arc but is not listed.`,
        });
      }
    });
    checkArcsAt(answer.arcs, answer.serverTime, ctx, ['arcs']);
    const waiting = answer.arcs.reduce(
      (sum, arc) => sum + arc.letters.filter((letter) => letter.status === 'delivered').length,
      0,
    );
    if (answer.unread !== waiting) {
      ctx.addIssue({
        code: 'custom',
        path: ['unread'],
        message: `${waiting} letters wait in their seals, so unread is ${waiting}.`,
      });
    }
  });
export type LettersResponse = z.infer<typeof LettersResponseSchema>;

/** A letter the server just delivered, for the tray chime and the Concierge's announcement. */
export const LetterDeliverySchema = z
  .object({
    letterId: LetterIdSchema,
    arc: GuestArcIdSchema,
    guest: WorldGuestIdSchema,
    deliveredAt: EpochMsSchema,
  })
  .superRefine((delivery, ctx) => {
    if (!isKeyedUnder(delivery.arc, delivery.guest)) {
      ctx.addIssue({ code: 'custom', path: ['arc'], message: 'The arc is keyed under its guest.' });
    }
    if (!isKeyedUnder(delivery.letterId, delivery.arc)) {
      ctx.addIssue({
        code: 'custom',
        path: ['letterId'],
        message: 'The letter is keyed under its arc.',
      });
    }
  });
export type LetterDelivery = z.infer<typeof LetterDeliverySchema>;

/** Breaks the seal on one delivered letter. The server checks it is delivered and pays it. */
export const LetterOpenRequestSchema = z.strictObject({
  letterId: LetterIdSchema,
});
export type LetterOpenRequest = z.infer<typeof LetterOpenRequestSchema>;

/**
 * Idempotent per letter: a repeat returns the same opening without paying twice. `arc` is the
 * letter's arc after the opening; `deliveries` are letters the opening delivered at once.
 */
export const LetterOpenResponseSchema = z
  .object({
    letterId: LetterIdSchema,
    openedAt: EpochMsSchema,
    arc: GuestArcSchema,
    granted: z.array(LiveGrantSchema),
    deliveries: z.array(LetterDeliverySchema),
    wallet: WalletSchema,
  })
  .superRefine((answer, ctx) => {
    const index = answer.arc.letters.findIndex((letter) => letter.id === answer.letterId);
    const letter = answer.arc.letters[index];
    if (letter?.status !== 'opened') {
      ctx.addIssue({
        code: 'custom',
        path: ['arc', 'letters'],
        message: `The arc shows letter ${answer.letterId} opened.`,
      });
      return;
    }
    if (letter.openedAt !== answer.openedAt) {
      ctx.addIssue({
        code: 'custom',
        path: ['arc', 'letters', index, 'openedAt'],
        message: 'The arc shows the letter opened at this opening.',
      });
    }
    if (JSON.stringify(letter.granted) !== JSON.stringify(answer.granted)) {
      ctx.addIssue({
        code: 'custom',
        path: ['granted'],
        message: 'The opening paid what the opened letter records.',
      });
    }
    answer.deliveries.forEach((delivery, i) => {
      if (delivery.deliveredAt < answer.openedAt) {
        ctx.addIssue({
          code: 'custom',
          path: ['deliveries', i, 'deliveredAt'],
          message: 'A letter the opening delivered arrives with it, not before.',
        });
      }
    });
    checkUnique(
      answer.deliveries,
      (delivery) => delivery.letterId,
      ctx,
      (i) => ['deliveries', i, 'letterId'],
      'Each letter is delivered once.',
    );
  });
export type LetterOpenResponse = z.infer<typeof LetterOpenResponseSchema>;
