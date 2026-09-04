/**
 * Cal.com API v2 client. This is the only file that talks to Cal.com.
 *
 * Two warnings that came from reading the spec and probing the API, not from
 * assuming:
 *
 *  1. Each endpoint requires a different `cal-api-version`. Slots uses
 *     2024-09-04 and bookings uses 2026-02-25. Sending the wrong one does not
 *     produce a clear error: it falls through to an older handler with different
 *     validation, or plainly 404s.
 *  2. In `GET /v2/slots`, `start` and `end` are interpreted in UTC, but the keys
 *     of the response object are bucketed by the `timeZone` you ask for. That is
 *     why the range is computed with `dayBoundsUtc` and the local day's key is
 *     the one we read.
 */

import { z } from 'zod';

import type { RawSlot } from './slots.js';
import { VERSION } from './version.js';
import { dayBoundsUtc } from './time.js';

export const CAL_API_VERSION_SLOTS = '2024-09-04';
export const CAL_API_VERSION_BOOKINGS = '2026-02-25';

const DEFAULT_TIMEOUT_MS = 10_000;

export type CalErrorKind =
  | 'conflict'
  | 'unauthorized'
  | 'not_found'
  | 'rate_limited'
  | 'bad_request'
  | 'unavailable';

/** Normalized error. Routes decide what to tell the caller based on `kind`. */
export class CalApiError extends Error {
  constructor(
    readonly kind: CalErrorKind,
    readonly httpStatus: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'CalApiError';
  }
}

function kindFromStatus(status: number): CalErrorKind {
  if (status === 409) return 'conflict';
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status >= 400 && status < 500) return 'bad_request';
  return 'unavailable';
}

/* -------------------------------------------------------------------------- */
/* Response schemas                                                            */
/* -------------------------------------------------------------------------- */

const slotSchema = z.object({
  start: z.string(),
  end: z.string().optional(),
});

/** `data` is keyed by date: { "2026-09-08": [{ start }] }. */
const slotsResponseSchema = z.object({
  status: z.string(),
  data: z.record(z.string(), z.array(slotSchema)),
});

const bookingResponseSchema = z.object({
  status: z.string(),
  data: z
    .object({
      id: z.number(),
      uid: z.string(),
      status: z.string(),
      start: z.string(),
      end: z.string(),
      // The remaining fields exist but are unused; passthrough keeps them.
    })
    .passthrough(),
});

const errorResponseSchema = z.object({
  status: z.string().optional(),
  error: z
    .object({
      code: z.string().optional(),
      message: z.string().optional(),
      details: z.unknown().optional(),
    })
    .optional(),
});

export type CalBooking = z.infer<typeof bookingResponseSchema>['data'];

/* -------------------------------------------------------------------------- */
/* Client                                                                      */
/* -------------------------------------------------------------------------- */

export interface CalClientOptions {
  apiKey: string;
  eventTypeId: number;
  baseUrl?: string;
  timeoutMs?: number;
  /** Injectable for tests: no test touches the network. */
  fetchImpl?: typeof fetch;
}

export interface GetSlotsInput {
  /** Local business date, "2026-09-08". */
  date: string;
  timeZone: string;
  /** Duration in minutes, only for multi-duration event types. */
  durationMinutes?: number;
}

export interface CreateBookingInput {
  /** Start instant. Sent to Cal.com in UTC, as the spec requires. */
  start: Date;
  attendeeName: string;
  attendeeEmail: string;
  timeZone: string;
  /** Stored in metadata so the originating conversation can be traced. */
  bookingKey?: string;
  language?: string;
}

export interface CalClient {
  getSlots(input: GetSlotsInput): Promise<RawSlot[]>;
  createBooking(input: CreateBookingInput): Promise<CalBooking>;
}

/**
 * Identifies this client to Cal.com.
 *
 * Not cosmetic. Node's `fetch` sends no User-Agent at all, and the Cloudflare
 * layer in front of api.cal.com answers an anonymous request with a 403 and an
 * HTML challenge page — even when the API key is perfectly valid. The failure
 * looks exactly like an auth problem and is not one, so this header is what
 * keeps the whole calendar integration working.
 */
const USER_AGENT = `elevenlabs-agent-backend/${VERSION}`;

export function createCalClient(options: CalClientOptions): CalClient {
  const baseUrl = (options.baseUrl ?? 'https://api.cal.com/v2').replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = options.fetchImpl ?? fetch;

  async function request(
    path: string,
    init: RequestInit & { apiVersion: string },
  ): Promise<unknown> {
    const { apiVersion, ...rest } = init;

    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${path}`, {
        ...rest,
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          'cal-api-version': apiVersion,
          'Content-Type': 'application/json',
          'User-Agent': USER_AGENT,
          ...(rest.headers ?? {}),
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      const isTimeout = cause instanceof Error && cause.name === 'TimeoutError';
      throw new CalApiError(
        'unavailable',
        0,
        isTimeout
          ? `Cal.com did not respond within ${timeoutMs} ms.`
          : `Could not reach Cal.com: ${(cause as Error).message}`,
        cause,
      );
    }

    const text = await response.text();
    let payload: unknown = undefined;
    if (text.length > 0) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { raw: text };
      }
    }

    if (!response.ok) {
      const parsed = errorResponseSchema.safeParse(payload);
      const message =
        parsed.success && parsed.data.error?.message
          ? parsed.data.error.message
          : `Cal.com responded ${response.status}`;
      throw new CalApiError(kindFromStatus(response.status), response.status, message, payload);
    }

    return payload;
  }

  return {
    async getSlots(input) {
      const { start, end } = dayBoundsUtc(input.date, input.timeZone);

      const query = new URLSearchParams({
        eventTypeId: String(options.eventTypeId),
        start: start.toISOString(),
        end: end.toISOString(),
        timeZone: input.timeZone,
      });
      if (input.durationMinutes) query.set('duration', String(input.durationMinutes));

      const payload = await request(`/slots?${query.toString()}`, {
        method: 'GET',
        apiVersion: CAL_API_VERSION_SLOTS,
      });

      const parsed = slotsResponseSchema.safeParse(payload);
      if (!parsed.success) {
        throw new CalApiError(
          'unavailable',
          200,
          'The Cal.com slots response does not have the expected shape.',
          parsed.error.issues,
        );
      }

      // Only the requested day matters. Cal.com may return neighbouring days
      // because the UTC range brushes against their local midnight.
      const forDate = parsed.data.data[input.date] ?? [];

      return forDate
        .map((slot): RawSlot => ({ start: new Date(slot.start) }))
        .filter((slot) => !Number.isNaN(slot.start.getTime()));
    },

    async createBooking(input) {
      const body: Record<string, unknown> = {
        // The spec asks for explicit UTC: "if a meeting starts at 11 in Rome
        // with GMT+2, the UTC time should read 09:00".
        start: input.start.toISOString(),
        eventTypeId: options.eventTypeId,
        attendee: {
          name: input.attendeeName,
          email: input.attendeeEmail,
          timeZone: input.timeZone,
          language: input.language ?? 'es',
        },
      };

      if (input.bookingKey) {
        // Cal.com v2 has no idempotency header. Real idempotency lives in our
        // backend; this only leaves a trail we can audit afterwards.
        body.metadata = { bookingKey: input.bookingKey.slice(0, 500) };
      }

      const payload = await request('/bookings', {
        method: 'POST',
        apiVersion: CAL_API_VERSION_BOOKINGS,
        body: JSON.stringify(body),
      });

      const parsed = bookingResponseSchema.safeParse(payload);
      if (!parsed.success) {
        throw new CalApiError(
          'unavailable',
          201,
          'The Cal.com booking response does not have the expected shape.',
          parsed.error.issues,
        );
      }

      return parsed.data.data;
    },
  };
}
