import { z } from 'zod';
import { LetterDeliverySchema } from './letters.ts';
import { PetFetchSchema, type PetFetch } from './pets.ts';
import { checkUnique } from './refine.ts';

function checkFetches(fetches: readonly PetFetch[], ctx: z.RefinementCtx): void {
  const issue = (i: number, key: keyof PetFetch, message: string) => {
    ctx.addIssue({ code: 'custom', path: ['fetches', i, key], message });
  };
  fetches.forEach((fetch, i) => {
    const previous = fetches[i - 1];
    if (previous === undefined) return;
    if (fetch.species !== previous.species) {
      issue(i, 'species', 'Only the companion at the table fetches.');
      return;
    }
    if (fetch.tick <= previous.tick) issue(i, 'tick', 'Fetches are listed in tick order.');
    if (fetch.fetches !== previous.fetches + 1) {
      issue(i, 'fetches', 'Each credited fetch counts one more.');
    }
    if (fetch.leveledUp !== fetch.level > previous.level || fetch.level < previous.level) {
      issue(i, 'level', 'A level only rises, and the fetch that raises it is the level-up.');
    }
  });
}

/**
 * What one accepted server step (a claim batch, a letter opened) did in the world. Server routes
 * attach it to their answers so the tray chime, the Concierge's line and the pet's fetch play
 * from server truth; it is never uploaded.
 */
export const WorldUpdateSchema = z
  .object({
    deliveries: z.array(LetterDeliverySchema),
    fetches: z.array(PetFetchSchema),
  })
  .superRefine((update, ctx) => {
    checkUnique(
      update.deliveries,
      (delivery) => delivery.letterId,
      ctx,
      (i) => ['deliveries', i, 'letterId'],
      'Each letter is delivered once.',
    );
    checkFetches(update.fetches, ctx);
  });
export type WorldUpdate = z.infer<typeof WorldUpdateSchema>;
