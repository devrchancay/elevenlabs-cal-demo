/**
 * Conversation log backed by a JSON file.
 *
 * No database on purpose: what makes this MVP demonstrable is being able to say
 * "12 conversations, 8 appointments booked", and a file is enough for that. The
 * day real querying is needed this becomes Postgres and the interface here does
 * not change.
 *
 * Railway note: the container filesystem is ephemeral. To keep the log across
 * redeploys, mount a volume and point CONVERSATIONS_LOG_PATH at it.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface ConversationRecord {
  conversationId: string;
  agentId?: string;
  /** ISO timestamp of when the call started. */
  startedAt: string;
  durationSeconds: number;
  /** "success" | "failure" | "unknown", as reported by ElevenLabs. */
  callSuccessful: string;
  /** True if an appointment was actually created during the conversation. */
  booked: boolean;
  bookingUid?: string;
  summary?: string;
  transcript: { role: string; message: string }[];
  /** Event timestamp, used to deduplicate retries. */
  eventTimestamp: number;
  receivedAt: string;
}

export interface ConversationStats {
  conversations: number;
  booked: number;
  successful: number;
  averageDurationSeconds: number;
}

export interface ConversationLog {
  append(record: ConversationRecord): Promise<{ stored: boolean; duplicate: boolean }>;
  all(): Promise<ConversationRecord[]>;
  stats(): Promise<ConversationStats>;
}

export function createConversationLog(filePath: string): ConversationLog {
  // Writes are serialized through a promise chain, so two concurrent webhooks
  // cannot clobber the file.
  let queue: Promise<unknown> = Promise.resolve();

  async function read(): Promise<ConversationRecord[]> {
    try {
      const raw = await readFile(filePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as ConversationRecord[]) : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async function write(records: ConversationRecord[]): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
    // Atomic write: temp file first, then rename. A power cut cannot leave the
    // file half written.
    const temp = `${filePath}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(records, null, 2)}\n`, 'utf8');
    await rename(temp, filePath);
  }

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = queue.then(task, task);
    queue = next.catch(() => undefined);
    return next;
  }

  return {
    append(record) {
      return enqueue(async () => {
        const records = await read();

        // ElevenLabs retries with a byte-identical body, so we deduplicate on
        // conversation id plus the event timestamp.
        const duplicate = records.some(
          (existing) =>
            existing.conversationId === record.conversationId &&
            existing.eventTimestamp === record.eventTimestamp,
        );
        if (duplicate) return { stored: false, duplicate: true };

        records.push(record);
        await write(records);
        return { stored: true, duplicate: false };
      });
    },

    all() {
      return enqueue(read);
    },

    async stats() {
      const records = await enqueue(read);
      const total = records.length;
      const totalDuration = records.reduce(
        (sum, record) => sum + (record.durationSeconds || 0),
        0,
      );

      return {
        conversations: total,
        booked: records.filter((record) => record.booked).length,
        successful: records.filter((record) => record.callSuccessful === 'success').length,
        averageDurationSeconds: total === 0 ? 0 : Math.round(totalDuration / total),
      };
    },
  };
}
