import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ConversationLog, ConversationRecord } from './conversations.js';
import { createConversationLog } from './conversations.js';

let dir: string;
let path: string;
let log: ConversationLog;

function record(overrides: Partial<ConversationRecord> = {}): ConversationRecord {
  return {
    conversationId: 'conv_1',
    startedAt: '2026-09-04T15:00:00.000Z',
    durationSeconds: 100,
    callSuccessful: 'success',
    booked: true,
    transcript: [],
    eventTimestamp: 1789000000,
    receivedAt: '2026-09-04T15:02:00.000Z',
    ...overrides,
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'convlog-unit-'));
  path = join(dir, 'nested', 'conversations.json');
  log = createConversationLog(path);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('createConversationLog', () => {
  it('returns nothing when the file does not exist yet', async () => {
    expect(await log.all()).toEqual([]);
    expect(await log.stats()).toEqual({
      conversations: 0,
      booked: 0,
      successful: 0,
      averageDurationSeconds: 0,
    });
  });

  it('creates the directory if needed and writes readable JSON', async () => {
    await log.append(record());

    const raw = await readFile(path, 'utf8');
    expect(JSON.parse(raw)).toHaveLength(1);
    expect(raw).toContain('\n  {');
  });

  it('deduplicates on conversation id plus event timestamp', async () => {
    expect(await log.append(record())).toEqual({ stored: true, duplicate: false });
    expect(await log.append(record())).toEqual({ stored: false, duplicate: true });

    expect(await log.all()).toHaveLength(1);
  });

  it('accepts the same conversation when the event differs', async () => {
    await log.append(record({ eventTimestamp: 1 }));
    await log.append(record({ eventTimestamp: 2 }));

    expect(await log.all()).toHaveLength(2);
  });

  it('does not lose concurrent writes', async () => {
    // Two webhooks arriving at once cannot clobber the file: writes are
    // serialized through a promise chain.
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        log.append(record({ conversationId: `conv_${index}`, eventTimestamp: index })),
      ),
    );

    expect(await log.all()).toHaveLength(20);
  });

  it('computes the stats that make the MVP demonstrable', async () => {
    await log.append(
      record({ conversationId: 'a', eventTimestamp: 1, booked: true, durationSeconds: 120 }),
    );
    await log.append(
      record({ conversationId: 'b', eventTimestamp: 2, booked: true, durationSeconds: 90 }),
    );
    await log.append(
      record({
        conversationId: 'c',
        eventTimestamp: 3,
        booked: false,
        durationSeconds: 30,
        callSuccessful: 'failure',
      }),
    );

    expect(await log.stats()).toEqual({
      conversations: 3,
      booked: 2,
      successful: 2,
      averageDurationSeconds: 80,
    });
  });

  it('leaves no temporary files behind', async () => {
    await log.append(record());

    const files = await readdir(join(dir, 'nested'));

    expect(files).toEqual(['conversations.json']);
  });
});
