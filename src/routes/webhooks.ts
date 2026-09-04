/**
 * ElevenLabs post-call webhook.
 *
 * It carries no bearer: it is verified by an HMAC signature over the raw body.
 * Anything without a valid signature is rejected with 401 before its content is
 * even looked at.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { verifyWebhookSignature } from '../lib/auth.js';
import type { ConversationLog, ConversationRecord } from '../lib/conversations.js';
import type { PostCallWebhook, TranscriptTurn } from '../schemas/webhooks.js';
import { postCallWebhookSchema } from '../schemas/webhooks.js';

export interface WebhookRoutesOptions {
  log: ConversationLog;
  /** If absent the endpoint answers 503: better that than accepting unverified. */
  secret?: string;
}

/** Header ElevenLabs signs the body with. */
export const SIGNATURE_HEADER = 'elevenlabs-signature';

/**
 * Decides whether anything was booked during the conversation by looking at the
 * tool's actual result, not at what the agent said. An agent can claim "your
 * appointment is booked" and be wrong; the tool cannot.
 */
export function extractBooking(transcript: TranscriptTurn[]): {
  booked: boolean;
  bookingUid?: string;
} {
  for (const turn of transcript) {
    for (const result of turn.tool_results ?? []) {
      if (result.tool_name !== 'book_appointment') continue;
      if (result.is_error) continue;

      try {
        const parsed: unknown = JSON.parse(result.result_value ?? '');
        if (typeof parsed === 'object' && parsed !== null && 'booked' in parsed) {
          const value = parsed as { booked?: unknown; bookingUid?: unknown };
          if (value.booked === true) {
            return {
              booked: true,
              ...(typeof value.bookingUid === 'string' ? { bookingUid: value.bookingUid } : {}),
            };
          }
        }
      } catch {
        // The tool returned something that is not JSON. Not a reason to fail.
      }
    }
  }

  return { booked: false };
}

export function toRecord(payload: PostCallWebhook, receivedAt: Date): ConversationRecord {
  const data = payload.data;
  const transcript = data.transcript ?? [];
  const booking = extractBooking(transcript);
  const startUnix = data.metadata?.start_time_unix_secs ?? payload.event_timestamp;

  return {
    conversationId: data.conversation_id,
    ...(data.agent_id ? { agentId: data.agent_id } : {}),
    startedAt: new Date(startUnix * 1000).toISOString(),
    durationSeconds: data.metadata?.call_duration_secs ?? 0,
    callSuccessful: data.analysis?.call_successful ?? 'unknown',
    booked: booking.booked,
    ...(booking.bookingUid ? { bookingUid: booking.bookingUid } : {}),
    ...(data.analysis?.transcript_summary
      ? { summary: data.analysis.transcript_summary }
      : {}),
    transcript: transcript.map((turn) => ({
      role: turn.role,
      message: turn.message ?? '',
    })),
    eventTimestamp: payload.event_timestamp,
    receivedAt: receivedAt.toISOString(),
  };
}

export async function webhookRoutes(
  app: FastifyInstance,
  options: WebhookRoutesOptions,
): Promise<void> {
  app.post('/webhooks/post-call', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!options.secret) {
      request.log.error('post-call received but ELEVENLABS_WEBHOOK_SECRET is not configured');
      return reply.status(503).send({ error: 'webhook_not_configured' });
    }

    // The raw body is mandatory: re-serializing the JSON changes the bytes and
    // the signature stops matching.
    const rawBody = (request as FastifyRequest & { rawBody?: string }).rawBody;
    if (typeof rawBody !== 'string') {
      request.log.error('raw body was not preserved; cannot verify the signature');
      return reply.status(400).send({ error: 'missing_raw_body' });
    }

    const verification = verifyWebhookSignature({
      rawBody,
      signatureHeader: request.headers[SIGNATURE_HEADER] as string | undefined,
      secret: options.secret,
    });

    if (!verification.valid) {
      request.log.warn({ reason: verification.reason }, 'invalid post-call signature');
      return reply.status(401).send({ error: 'invalid_signature', reason: verification.reason });
    }

    const parsed = postCallWebhookSchema.safeParse(request.body);
    if (!parsed.success) {
      request.log.warn({ issues: parsed.error.issues }, 'unexpected post-call payload');
      // 200 on purpose: answering with an error makes ElevenLabs retry the same
      // bad body, and after 10 failures it disables the webhook.
      return reply
        .status(200)
        .send({ received: true, stored: false, reason: 'unexpected_payload' });
    }

    if (parsed.data.type !== 'post_call_transcription') {
      request.log.info({ type: parsed.data.type }, 'post-call event ignored');
      return reply.send({ received: true, stored: false, reason: 'ignored_type' });
    }

    const record = toRecord(parsed.data, new Date());
    const result = await options.log.append(record);

    request.log.info(
      {
        conversationId: record.conversationId,
        durationSeconds: record.durationSeconds,
        booked: record.booked,
        callSuccessful: record.callSuccessful,
        duplicate: result.duplicate,
      },
      'conversation recorded',
    );

    return reply.send({ received: true, ...result });
  });

  /** Quick summary. This is what makes the MVP demonstrable. */
  app.get('/webhooks/stats', async () => options.log.stats());
}
