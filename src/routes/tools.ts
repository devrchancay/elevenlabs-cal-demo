/**
 * The webhook tools ElevenLabs calls.
 *
 * Contract with the agent:
 *  · the agent sends a plain date and a part of day, and gets back up to 3
 *    options already phrased for speech;
 *  · to book it sends only the `optionId`, never a time it built itself.
 *
 * Both endpoints are public on the internet and require the shared bearer.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { CalApiError } from '../lib/cal.js';
import type { SchedulingService } from '../lib/scheduling.js';
import { InvalidDateError } from '../lib/time.js';
import {
  availabilityRequestSchema,
  availabilityResponseSchema,
  bookRequestSchema,
  bookResponseSchema,
} from '../schemas/tools.js';

export interface ToolsRoutesOptions {
  scheduling: SchedulingService;
}

/**
 * Spoken fallbacks. Spanish on purpose: the agent reads these to the caller.
 */
const SPOKEN_FALLBACK =
  'Tuve un problema para consultar la agenda. ¿Intentamos de nuevo en un momento?';
const SPOKEN_REPEAT_DATE = '¿Me repites la fecha, por favor? No me quedó clara.';

/** Empty availability response, used for the error paths. */
function emptyAvailability(spokenSummary: string) {
  return {
    options: [],
    found: false,
    searchedDate: '',
    isAlternativeDate: false,
    spokenSummary,
  };
}

export async function toolsRoutes(
  app: FastifyInstance,
  options: ToolsRoutesOptions,
): Promise<void> {
  const { scheduling } = options;

  app.post('/tools/availability', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = availabilityRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      request.log.warn({ issues: parsed.error.issues }, 'availability: invalid payload');
      return reply.status(400).send({
        error: 'invalid_request',
        message: 'The request body is not valid.',
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }

    try {
      const result = await scheduling.checkAvailability(parsed.data);
      const validated = availabilityResponseSchema.parse(result);

      request.log.info(
        {
          tool: 'check_availability',
          requested: parsed.data.date,
          partOfDay: parsed.data.partOfDay,
          searchedDate: validated.searchedDate,
          optionCount: validated.options.length,
          isAlternativeDate: validated.isAlternativeDate,
        },
        'availability resolved',
      );

      return reply.send(validated);
    } catch (error) {
      return handleToolError(request, reply, error, 'check_availability');
    }
  });

  app.post('/tools/book', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = bookRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      request.log.warn({ issues: parsed.error.issues }, 'book: invalid payload');
      return reply.status(400).send({
        error: 'invalid_request',
        message: 'The request body is not valid.',
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }

    try {
      const result = await scheduling.book(parsed.data);
      const validated = bookResponseSchema.parse(result);

      request.log.info(
        {
          tool: 'book_appointment',
          bookingKey: parsed.data.bookingKey,
          optionId: parsed.data.optionId,
          booked: validated.booked,
          duplicate: validated.duplicate ?? false,
          reason: validated.reason,
          bookingUid: validated.bookingUid,
        },
        'booking processed',
      );

      return reply.send(validated);
    } catch (error) {
      return handleToolError(request, reply, error, 'book_appointment');
    }
  });
}

/**
 * Errors come back as 200 with a sentence the agent can read.
 * A 5xx would leave the model improvising in the middle of a voice call; a clear
 * sentence lets it carry the conversation with some dignity.
 */
function handleToolError(
  request: FastifyRequest,
  reply: FastifyReply,
  error: unknown,
  tool: string,
): FastifyReply {
  if (error instanceof InvalidDateError) {
    request.log.warn({ tool, input: error.input }, 'agent sent an unusable date');
    return reply.status(200).send(emptyAvailability(SPOKEN_REPEAT_DATE));
  }

  if (error instanceof CalApiError) {
    request.log.error(
      { tool, kind: error.kind, httpStatus: error.httpStatus, err: error.message },
      'Cal.com error',
    );
  } else {
    request.log.error({ tool, err: error }, 'unexpected error inside a tool');
  }

  return reply
    .status(200)
    .send(
      tool === 'book_appointment'
        ? { booked: false, reason: 'cal_error', spokenConfirmation: SPOKEN_FALLBACK }
        : emptyAvailability(SPOKEN_FALLBACK),
    );
}
