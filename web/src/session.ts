/**
 * What the backend knows about the conversation in flight.
 *
 * The times on screen come from here rather than from the transcript, because
 * the transcript is what the model *said*. These are what Cal.com actually
 * returned. The mirror image of the backend's `src/lib/session.ts`, and free of
 * personal data for the same reason.
 */

export interface SessionOption {
  id: string;
  spokenLabel: string;
  startsAt: string;
}

export interface SessionBooking {
  optionId: string;
  spokenLabel: string;
  startsAt: string;
  status: 'booked' | 'pending';
  bookingUid: string;
}

export interface SessionState {
  options: SessionOption[];
  searchedDate: string;
  isAlternativeDate: boolean;
  booking: SessionBooking | null;
  revision: number;
}

export const EMPTY_SESSION: SessionState = {
  options: [],
  searchedDate: '',
  isAlternativeDate: false,
  booking: null,
  revision: 0,
};

/**
 * Polled rather than pushed.
 *
 * Server-sent events would be tidier on paper, but the thing being watched
 * changes maybe four times in a two-minute call, and a poll survives a laptop
 * closing its lid or a phone dropping to 3G without any reconnection logic to
 * get wrong. Two seconds sits well inside the time the agent spends reading
 * three options out loud, so the cards land before it finishes the sentence.
 *
 * It also stays under the backend's default rate limit of 60 requests a minute
 * on its own, without needing an exemption.
 */
const POLL_INTERVAL_MS = 2000;

export interface SessionWatcher {
  /**
   * Reads once more, then stops.
   *
   * Hanging up immediately after confirming is normal, and the appointment may
   * have been written between the last tick and the goodbye. Stopping without
   * this final read would leave the confirmation off a screen the caller is
   * still looking at.
   */
  finish(): Promise<void>;
  /** Stops without reading. For teardown that is not the end of a call. */
  stop(): void;
}

export function watchSession(
  backendUrl: string,
  conversationId: string,
  onChange: (state: SessionState) => void,
): SessionWatcher {
  let stopped = false;
  let lastRevision = -1;
  let timer: number | undefined;

  async function readOnce(): Promise<void> {
    try {
      const response = await fetch(
        `${backendUrl}/agent/session/${encodeURIComponent(conversationId)}`,
        { cache: 'no-store' },
      );
      if (!response.ok) return;

      const state = (await response.json()) as SessionState;
      // One integer decides whether anything is worth re-rendering.
      if (state.revision !== lastRevision) {
        lastRevision = state.revision;
        onChange(state);
      }
    } catch {
      // A dropped poll is not worth surfacing: the voice conversation is
      // unaffected and the next tick catches up.
    }
  }

  function cancel(): void {
    stopped = true;
    if (timer !== undefined) window.clearTimeout(timer);
  }

  async function poll(): Promise<void> {
    if (stopped) return;
    await readOnce();
    if (!stopped) timer = window.setTimeout(() => void poll(), POLL_INTERVAL_MS);
  }

  void poll();

  return {
    async finish() {
      cancel();
      await readOnce();
    },
    stop: cancel,
  };
}
