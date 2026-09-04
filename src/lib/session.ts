/**
 * What the page is allowed to know about a conversation in flight.
 *
 * The landing page renders the booking as it happens: the times the agent just
 * offered, which one was taken, and whether the appointment exists. That state
 * already lives in the backend — it is what `/tools/availability` computed and
 * what `/tools/book` wrote — so the page reads it instead of trying to parse it
 * out of a transcript. A transcript-derived UI would be showing what the model
 * *said*, which is precisely the thing that cannot be trusted.
 *
 * Deliberately free of personal data. The endpoint that serves this is public
 * and keyed by the conversation id, so a name or an email must never enter it.
 * The page learns those from `show_booking_summary`, a client tool the agent
 * calls in that same browser — the data never makes the round trip.
 */

import type { TtlStore } from './store.js';

export interface SessionOption {
  id: string;
  spokenLabel: string;
  startsAt: string;
}

export interface SessionBooking {
  optionId: string;
  spokenLabel: string;
  startsAt: string;
  /** `pending` when the event type needs the owner to confirm. */
  status: 'booked' | 'pending';
  bookingUid: string;
}

export interface SessionState {
  /** The options currently on the table. A new lookup replaces them. */
  options: SessionOption[];
  /** The date the options belong to, which may not be the one asked for. */
  searchedDate: string;
  isAlternativeDate: boolean;
  /** Set once the appointment exists. Null until then. */
  booking: SessionBooking | null;
  /**
   * Bumped on every write. The page polls this endpoint, and comparing one
   * integer is cheaper — and steadier — than diffing the whole payload.
   */
  revision: number;
}

export interface SessionTracker {
  recordAvailability(
    key: string,
    input: { options: SessionOption[]; searchedDate: string; isAlternativeDate: boolean },
  ): void;
  recordBooking(key: string, booking: SessionBooking): void;
  read(key: string): SessionState | undefined;
}

const EMPTY: Omit<SessionState, 'revision'> = {
  options: [],
  searchedDate: '',
  isAlternativeDate: false,
  booking: null,
};

export function createSessionTracker(store: TtlStore<SessionState>): SessionTracker {
  /** Reads the current state, or a blank one, always ready to be written back. */
  function current(key: string): SessionState {
    return store.get(key) ?? { ...EMPTY, revision: 0 };
  }

  return {
    recordAvailability(key, input) {
      const previous = current(key);
      store.set(key, {
        options: input.options,
        searchedDate: input.searchedDate,
        isAlternativeDate: input.isAlternativeDate,
        // A new lookup does not erase a booking that already happened.
        booking: previous.booking,
        revision: previous.revision + 1,
      });
    },

    recordBooking(key, booking) {
      const previous = current(key);
      store.set(key, { ...previous, booking, revision: previous.revision + 1 });
    },

    read(key) {
      return store.get(key);
    },
  };
}
