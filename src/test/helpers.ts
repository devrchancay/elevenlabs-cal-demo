/**
 * Test utilities. No test performs a real network request.
 */

import type { CalClient, CreateBookingInput } from '../lib/cal.js';

export interface FakeCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface FakeFetch {
  fn: typeof fetch;
  calls: FakeCall[];
}

/** Returns a fake `fetch` that answers whatever you tell it and records calls. */
export function fakeFetch(
  responder: (call: FakeCall) => { status?: number; body: unknown },
): FakeFetch {
  const calls: FakeCall[] = [];

  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(
      (init?.headers ?? {}) as Record<string, string>,
    )) {
      headers[key.toLowerCase()] = value;
    }

    const call: FakeCall = {
      url,
      method: init?.method ?? 'GET',
      headers,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);

    const { status = 200, body } = responder(call);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  return { fn, calls };
}

/** Parses the query params of a recorded URL. */
export function queryOf(url: string): Record<string, string> {
  return Object.fromEntries(new URL(url).searchParams.entries());
}

/* -------------------------------------------------------------------------- */
/* Fake Cal.com                                                                */
/* -------------------------------------------------------------------------- */

export interface FakeCalOptions {
  /** Slots per local date, as "HH:MM" strings. */
  slotsByDate?: Record<string, string[]>;
  /** Forces createBooking to throw. */
  bookingError?: Error;
  /** Status Cal.com reports for the booking. */
  bookingStatus?: string;
}

export interface FakeCal {
  client: CalClient;
  slotCalls: { date: string; timeZone: string }[];
  bookingCalls: CreateBookingInput[];
}

/** In-memory Cal.com client. No test touches the network. */
export function fakeCalClient(options: FakeCalOptions = {}): FakeCal {
  const slotCalls: FakeCal['slotCalls'] = [];
  const bookingCalls: FakeCal['bookingCalls'] = [];
  let counter = 0;

  const client: CalClient = {
    async getSlots(input) {
      slotCalls.push({ date: input.date, timeZone: input.timeZone });
      const times = options.slotsByDate?.[input.date] ?? [];
      return times.map((time) => ({ start: new Date(`${input.date}T${time}:00.000-05:00`) }));
    },

    async createBooking(input) {
      bookingCalls.push(input);
      if (options.bookingError) throw options.bookingError;
      counter += 1;
      return {
        id: 1000 + counter,
        uid: `uid_${counter}`,
        status: options.bookingStatus ?? 'accepted',
        start: input.start.toISOString(),
        end: new Date(input.start.getTime() + 30 * 60_000).toISOString(),
      };
    },
  };

  return { client, slotCalls, bookingCalls };
}
