/**
 * Input and output schemas for the webhook tools.
 *
 * The input is built by an LLM, so it is validated without mercy: a malformed
 * payload is rejected here and never reaches Cal.com. The output is validated
 * too, so an internal change cannot send the agent something it cannot read.
 *
 * Spanish strings in the responses are deliberate: they are read out loud.
 */

import { z } from 'zod';

/** A `bookingKey` is the ElevenLabs conversation id. */
export const bookingKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._:-]+$/, 'bookingKey only accepts letters, digits and . _ : -');

export const partOfDaySchema = z
  .enum(['morning', 'afternoon', 'any'])
  .default('any')
  // If the model sends "mañana" or anything else, do not fail: search the whole day.
  .catch('any');

export const availabilityRequestSchema = z.object({
  /**
   * Date in YYYY-MM-DD form. "hoy" and "mañana" are also accepted in case the
   * model invents them; `normalizeDateInput` resolves those.
   */
  date: z.string().trim().min(1, 'The date is missing'),
  partOfDay: partOfDaySchema,
  /**
   * Optional. Scopes the offered options per conversation so two simultaneous
   * calls do not collide on the same `opt_1`.
   */
  bookingKey: bookingKeySchema.optional(),
});

export const slotOptionSchema = z.object({
  id: z.string(),
  spokenLabel: z.string(),
  startsAt: z.string(),
});

export const availabilityResponseSchema = z.object({
  options: z.array(slotOptionSchema),
  /** True if there is at least one option to offer. */
  found: z.boolean(),
  /** Sentence ready to be read out loud. The agent writes nothing itself. */
  spokenSummary: z.string(),
  /**
   * The date actually searched. It may differ from the requested one when we
   * had to look at the following days.
   */
  searchedDate: z.string(),
  /** True when `searchedDate` is not the date the caller asked for. */
  isAlternativeDate: z.boolean(),
});

export const bookRequestSchema = z.object({
  optionId: z.string().trim().min(1, 'The optionId is missing'),
  name: z.string().trim().min(2, 'The name is too short').max(120, 'The name is too long'),
  email: z.string().trim().toLowerCase().email('The email is not valid').max(200),
  bookingKey: bookingKeySchema,
});

export const bookResponseSchema = z.object({
  booked: z.boolean(),
  /** Sentence ready to be read out loud, whether it worked or not. */
  spokenConfirmation: z.string(),
  /** Present only when the booking exists. */
  bookingUid: z.string().optional(),
  /** True when this call returned an already existing booking (idempotency). */
  duplicate: z.boolean().optional(),
  /** Machine-readable reason when `booked` is false. */
  reason: z.enum(['option_expired', 'slot_taken', 'invalid_input', 'cal_error']).optional(),
});

export type AvailabilityRequest = z.infer<typeof availabilityRequestSchema>;
export type AvailabilityResponse = z.infer<typeof availabilityResponseSchema>;
export type BookRequest = z.infer<typeof bookRequestSchema>;
export type BookResponse = z.infer<typeof bookResponseSchema>;
