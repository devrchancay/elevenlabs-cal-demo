/**
 * Payload of the ElevenLabs post-call webhook.
 *
 * Only the fields we use are validated and everything else is optional:
 * ElevenLabs adds fields over time, and a strict schema would turn one of their
 * improvements into an outage on our side.
 */

import { z } from 'zod';

export const transcriptTurnSchema = z
  .object({
    role: z.string(),
    message: z.string().nullable().optional(),
    tool_calls: z
      .array(z.object({ tool_name: z.string().optional() }).passthrough())
      .nullable()
      .optional(),
    tool_results: z
      .array(
        z
          .object({
            tool_name: z.string().optional(),
            result_value: z.string().nullable().optional(),
            is_error: z.boolean().optional(),
          })
          .passthrough(),
      )
      .nullable()
      .optional(),
  })
  .passthrough();

export const postCallWebhookSchema = z
  .object({
    type: z.string(),
    event_timestamp: z.number(),
    data: z
      .object({
        conversation_id: z.string(),
        agent_id: z.string().optional(),
        status: z.string().optional(),
        transcript: z.array(transcriptTurnSchema).optional().default([]),
        metadata: z
          .object({
            start_time_unix_secs: z.number().optional(),
            call_duration_secs: z.number().optional(),
            termination_reason: z.string().optional(),
          })
          .passthrough()
          .optional(),
        analysis: z
          .object({
            call_successful: z.string().optional(),
            transcript_summary: z.string().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough(),
  })
  .passthrough();

export type PostCallWebhook = z.infer<typeof postCallWebhookSchema>;
export type TranscriptTurn = z.infer<typeof transcriptTurnSchema>;
