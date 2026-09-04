import { z } from 'zod';

/**
 * Environment validation at boot.
 *
 * If something is missing the process dies right here with a clear message,
 * instead of blowing up later in the middle of a live call.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  // Cal.com
  //
  // `required_error` matters here: an empty value is stripped before parsing,
  // so a variable left blank in .env arrives as absent and would otherwise get
  // Zod's terse "Required" instead of a message naming what to do about it.
  CAL_API_KEY: z.string({ required_error: 'CAL_API_KEY is required' }).min(1, 'CAL_API_KEY is required'),
  CAL_EVENT_TYPE_ID: z.coerce
    .number({
      required_error: 'CAL_EVENT_TYPE_ID is required (the numeric event type id, not the slug)',
      invalid_type_error: 'CAL_EVENT_TYPE_ID must be the numeric event type id, not the slug',
    })
    .int()
    .positive({ message: 'CAL_EVENT_TYPE_ID must be a positive number' }),
  CAL_API_BASE_URL: z.string().url().default('https://api.cal.com/v2'),

  // Business
  BUSINESS_TIMEZONE: z.string().min(1).default('America/Guayaquil'),
  BUSINESS_HOURS_START: z.coerce.number().int().min(0).max(23).default(9),
  BUSINESS_HOURS_END: z.coerce.number().int().min(1).max(24).default(18),
  APPOINTMENT_DURATION_MINUTES: z.coerce.number().int().positive().default(30),

  // Security
  TOOLS_SHARED_SECRET: z
    .string({
      required_error:
        'TOOLS_SHARED_SECRET is required (generate one with: openssl rand -hex 32)',
    })
    .min(16, 'TOOLS_SHARED_SECRET must be at least 16 characters long'),
  ELEVENLABS_WEBHOOK_SECRET: z.string().min(1).optional(),

  // Simple persistence (phase 8)
  CONVERSATIONS_LOG_PATH: z.string().default('./data/conversations.json'),

  // Rate limiting
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_WINDOW: z.string().default('1 minute'),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

/** Turns Zod issues into something readable in a terminal. */
function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `  · ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');
}

/**
 * Drops variables whose value is empty or whitespace, so an empty assignment is
 * treated as absent.
 *
 * This matters because .env.example ships every key with an empty value for the
 * developer to fill in, and docker compose forwards those as empty strings
 * rather than omitting them. Without this, `FOO=` would fail a `.min(1)` check
 * instead of falling back to the default or to being genuinely optional.
 */
function withoutEmptyValues(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const cleaned: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string' && value.trim().length === 0) continue;
    cleaned[key] = value;
  }
  return cleaned;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(withoutEmptyValues(source));

  if (!parsed.success) {
    const message = [
      '',
      '✖ Invalid configuration. The server cannot start.',
      '',
      formatIssues(parsed.error),
      '',
      'Check your .env file (use .env.example as a reference).',
      '',
    ].join('\n');
    throw new Error(message);
  }

  if (parsed.data.BUSINESS_HOURS_END <= parsed.data.BUSINESS_HOURS_START) {
    throw new Error(
      '✖ Invalid configuration: BUSINESS_HOURS_END must be greater than BUSINESS_HOURS_START.',
    );
  }

  return parsed.data;
}

/** Environment loaded once per process. */
export function getEnv(): Env {
  cached ??= loadEnv();
  return cached;
}

/** Test-only escape hatch. */
export function resetEnvCache(): void {
  cached = null;
}
