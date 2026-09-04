/**
 * Server entry point.
 *
 * Listens on 0.0.0.0 and on process.env.PORT because Railway injects the port
 * and assigns the address: a hardcoded localhost means the deploy never passes
 * the health check, and the error does not say why.
 */

import { buildApp } from './app.js';
import { getEnv } from './lib/env.js';
import { VERSION } from './lib/version.js';

async function main(): Promise<void> {
  let env;
  try {
    env = getEnv();
  } catch (error) {
    // Invalid configuration is reported and kills the process here, not later
    // in the middle of a call.
    console.error((error as Error).message);
    process.exit(1);
  }

  const { app } = await buildApp({ env });

  const close = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => void close('SIGTERM'));
  process.on('SIGINT', () => void close('SIGINT'));

  try {
    await app.listen({ host: env.HOST, port: env.PORT });
    app.log.info(
      { version: VERSION, timeZone: env.BUSINESS_TIMEZONE, eventTypeId: env.CAL_EVENT_TYPE_ID },
      'server up',
    );
  } catch (error) {
    app.log.error({ err: error }, 'could not start the server');
    process.exit(1);
  }
}

void main();
