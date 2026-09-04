import type { FastifyInstance } from 'fastify';

import { currentDateTimeForPrompt, todayIso } from '../lib/time.js';

export interface ContextRoutesOptions {
  timeZone: string;
  now?: () => Date;
}

/**
 * Current date and time in the business timezone.
 *
 * The landing page fetches this before opening a conversation and passes it to
 * the agent as a dynamic variable. It is computed on the server on purpose: the
 * visitor's browser clock may be in another timezone, and the agent has to
 * reason about the business day, not the visitor's.
 *
 * Public: it exposes nothing beyond the time.
 */
export async function contextRoutes(
  app: FastifyInstance,
  options: ContextRoutesOptions,
): Promise<void> {
  const now = options.now ?? (() => new Date());

  app.get('/agent/context', async (_request, reply) => {
    const reference = now();

    // No caching: a stale response would make the agent believe it is yesterday.
    void reply.header('cache-control', 'no-store');
    // The landing page is served as a static file from a different origin than
    // the backend, so this GET needs CORS. It is a public read of the clock and
    // exposes nothing else.
    void reply.header('access-control-allow-origin', '*');

    return {
      timeZone: options.timeZone,
      today: todayIso(options.timeZone, reference),
      currentDateTime: currentDateTimeForPrompt(options.timeZone, reference),
    };
  });
}
