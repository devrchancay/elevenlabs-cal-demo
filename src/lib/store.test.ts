import { describe, expect, it } from 'vitest';

import { createTtlStore } from './store.js';

function controllableClock(start = 0) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe('createTtlStore', () => {
  it('stores and returns values', () => {
    const store = createTtlStore<string>({ ttlMs: 1000 });

    store.set('a', 'one');
    expect(store.get('a')).toBe('one');
    expect(store.has('a')).toBe(true);
    expect(store.get('missing')).toBeUndefined();
  });

  it('expires once the TTL elapses', () => {
    const clock = controllableClock();
    const store = createTtlStore<string>({ ttlMs: 1000, now: clock.now });

    store.set('a', 'one');
    clock.advance(999);
    expect(store.get('a')).toBe('one');

    clock.advance(2);
    expect(store.get('a')).toBeUndefined();
    expect(store.size()).toBe(0);
  });

  it('renews the TTL when the same key is rewritten', () => {
    const clock = controllableClock();
    const store = createTtlStore<string>({ ttlMs: 1000, now: clock.now });

    store.set('a', 'one');
    clock.advance(900);
    store.set('a', 'two');
    clock.advance(900);

    expect(store.get('a')).toBe('two');
  });

  it('deletes explicitly', () => {
    const store = createTtlStore<string>({ ttlMs: 1000 });

    store.set('a', 'one');
    store.delete('a');
    expect(store.get('a')).toBeUndefined();
  });

  it('does not grow without bound', () => {
    const store = createTtlStore<number>({ ttlMs: 60_000, maxEntries: 3 });

    for (let i = 0; i < 10; i += 1) store.set(`k${i}`, i);

    expect(store.size()).toBeLessThanOrEqual(3);
    // The most recent entry always survives.
    expect(store.get('k9')).toBe(9);
  });

  it('purges expired entries', () => {
    const clock = controllableClock();
    const store = createTtlStore<string>({ ttlMs: 100, now: clock.now });

    store.set('a', 'one');
    store.set('b', 'two');
    clock.advance(200);
    store.purge();

    expect(store.size()).toBe(0);
  });
});
