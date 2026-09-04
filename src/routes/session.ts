import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { bookingKeySchema } from '../schemas/tools.js';
import type { SessionTracker } from '../lib/session.js';

export interface SessionRoutesOptions {
  tracker: SessionTracker;
}

/**
 * What the landing page renders while the caller is talking.
 *
 * Why this exists: the page shows the times the agent just offered and, at the
 * end, the appointment. Both are facts the backend already computed. Deriving
 * them from the transcript instead would mean showing what the model *said*,
 * and the whole design of this project is built on not trusting that.
 *
 * Why it is public: the key is the ElevenLabs conversation id, an opaque value
 * only the browser in that conversation holds. Putting the shared tool secret
 * in a static page to protect it would be strictly worse — the secret would be
 * readable by anyone, and it is the one thing standing between the internet and
 * a real calendar.
 *
 * What keeps that safe is that the payload carries no personal data at all: no
 * name, no email, no spoken confirmation (which quotes both). Someone who
 * guessed a conversation id would learn three appointment times. The caller's
 * own name and email reach the page through `show_booking_summary`, a client
 * tool the agent runs in that browser, so they never make the round trip.
 */
export async function sessionRoutes(
  app: FastifyInstance,
  options: SessionRoutesOptions,
): Promise<void> {
  app.get(
    '/agent/session/:bookingKey',
    async (request: FastifyRequest<{ Params: { bookingKey: string } }>, reply: FastifyReply) => {
      // The landing page is served from a different origin than the backend.
      void reply.header('access-control-allow-origin', '*');
      // Polled state: a cached answer would freeze the UI mid-conversation.
      void reply.header('cache-control', 'no-store');

      const parsed = bookingKeySchema.safeParse(request.params.bookingKey);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'invalid_booking_key' });
      }

      const state = options.tracker.read(parsed.data);

      // An unknown key is not an error: the page starts polling before the
      // agent has looked anything up, and that is the normal first answer.
      if (!state) {
        return reply.send({
          options: [],
          searchedDate: '',
          isAlternativeDate: false,
          booking: null,
          revision: 0,
        });
      }

      return reply.send(state);
    },
  );
}
