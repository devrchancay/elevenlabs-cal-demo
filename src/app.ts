/**
 * Fastify app construction. Kept separate from `server.ts` so tests can build it
 * with fake dependencies and without opening a port.
 */

import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { isValidBearer } from './lib/auth.js';
import type { CalClient } from './lib/cal.js';
import { createCalClient } from './lib/cal.js';
import type { ConversationLog } from './lib/conversations.js';
import { createConversationLog } from './lib/conversations.js';
import type { Env } from './lib/env.js';
import type { SchedulingService, StoredBooking, StoredOption } from './lib/scheduling.js';
import { createSchedulingService } from './lib/scheduling.js';
import type { SessionState } from './lib/session.js';
import { createSessionTracker } from './lib/session.js';
import { createTtlStore } from './lib/store.js';
import { contextRoutes } from './routes/context.js';
import { healthRoutes } from './routes/health.js';
import { sessionRoutes } from './routes/session.js';
import { toolsRoutes } from './routes/tools.js';
import { webhookRoutes } from './routes/webhooks.js';

/** How long offered options stay alive. A conversation lasts about 2 minutes. */
export const OPTIONS_TTL_MS = 15 * 60 * 1000;
/** How long a booking is remembered so a duplicate call can be detected. */
export const BOOKINGS_TTL_MS = 60 * 60 * 1000;
/**
 * How long the page can still read back a finished conversation. Short: it only
 * has to outlive the tab that is watching it.
 */
export const SESSION_TTL_MS = 30 * 60 * 1000;

/** Routes that require the bearer shared with ElevenLabs. */
const BEARER_PROTECTED = ['/tools/', '/webhooks/stats'];

export interface BuildAppOptions {
  env: Env;
  /** Injectable for tests. */
  cal?: CalClient;
  conversationLog?: ConversationLog;
  now?: () => Date;
}

export interface BuiltApp {
  app: FastifyInstance;
  scheduling: SchedulingService;
  conversationLog: ConversationLog;
}

export async function buildApp(options: BuildAppOptions): Promise<BuiltApp> {
  const { env } = options;

  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      // One log line per call is what makes a bad conversation debuggable.
      // Secrets and the caller's email are never logged.
      redact: {
        paths: ['req.headers.authorization', 'req.headers["elevenlabs-signature"]'],
        censor: '[redacted]',
      },
    },
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
    genReqId: () => crypto.randomUUID(),
  });

  // The raw body is kept so the post-call HMAC can be verified. Re-serializing
  // the JSON would change the bytes and the signature would not match.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (request: FastifyRequest & { rawBody?: string }, body, done) => {
      const raw = typeof body === 'string' ? body : body.toString('utf8');
      request.rawBody = raw;

      if (raw.trim().length === 0) {
        done(null, {});
        return;
      }

      try {
        done(null, JSON.parse(raw));
      } catch (error) {
        (error as Error & { statusCode?: number }).statusCode = 400;
        done(error as Error, undefined);
      }
    },
  );

  await app.register(rateLimit, {
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW,
    // Railway's health check must not eat into the quota.
    allowList: (request) => request.url === '/health',
    keyGenerator: (request) => request.ip,
    errorResponseBuilder: () => ({
      error: 'rate_limited',
      message: 'Too many requests. Try again in a moment.',
    }),
  });

  // Bearer auth. The post-call webhook is deliberately excluded: it is verified
  // by signature, not by token.
  app.addHook('onRequest', async (request, reply) => {
    const needsBearer = BEARER_PROTECTED.some((prefix) => request.url.startsWith(prefix));
    if (!needsBearer) return;

    if (!isValidBearer(request.headers.authorization, env.TOOLS_SHARED_SECRET)) {
      request.log.warn({ url: request.url }, 'request without a valid bearer');
      await reply.status(401).send({ error: 'unauthorized' });
    }
  });

  const cal =
    options.cal ??
    createCalClient({
      apiKey: env.CAL_API_KEY,
      eventTypeId: env.CAL_EVENT_TYPE_ID,
      baseUrl: env.CAL_API_BASE_URL,
    });

  const sessionTracker = createSessionTracker(
    createTtlStore<SessionState>({ ttlMs: SESSION_TTL_MS }),
  );

  const scheduling = createSchedulingService({
    cal,
    optionStore: createTtlStore<StoredOption>({ ttlMs: OPTIONS_TTL_MS }),
    bookingStore: createTtlStore<StoredBooking>({ ttlMs: BOOKINGS_TTL_MS }),
    sessionTracker,
    timeZone: env.BUSINESS_TIMEZONE,
    durationMinutes: env.APPOINTMENT_DURATION_MINUTES,
    ...(options.now ? { now: options.now } : {}),
  });

  const conversationLog =
    options.conversationLog ?? createConversationLog(env.CONVERSATIONS_LOG_PATH);

  await app.register(healthRoutes);
  await app.register(contextRoutes, {
    timeZone: env.BUSINESS_TIMEZONE,
    ...(options.now ? { now: options.now } : {}),
  });
  await app.register(sessionRoutes, { tracker: sessionTracker });
  await app.register(toolsRoutes, { scheduling });
  await app.register(webhookRoutes, {
    log: conversationLog,
    ...(env.ELEVENLABS_WEBHOOK_SECRET ? { secret: env.ELEVENLABS_WEBHOOK_SECRET } : {}),
  });

  return { app, scheduling, conversationLog };
}
