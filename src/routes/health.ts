import type { FastifyInstance } from 'fastify';

import { VERSION } from '../lib/version.js';

/**
 * Health check. Railway polls this to decide whether a deploy succeeded.
 * It touches neither the network nor Cal.com: if Cal.com is down the service
 * is still alive and should keep reporting as such.
 */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => ({
    status: 'ok' as const,
    version: VERSION,
    uptime: Math.round(process.uptime()),
  }));
}
