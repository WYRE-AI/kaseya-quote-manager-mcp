import { beforeEach, describe, expect, it, vi } from 'vitest';
import { salesHandler } from '../domains/sales.js';
import { LimiterAbortError, SlidingWindowLimiter, limiterCount, limiterFor, resetLimiters, acquireForCurrentKey } from '../utils/rate-limit.js';
import { runWithCredentials } from '../utils/client.js';
import { Run } from '../reports/run.js';

const WINDOW = 150;

beforeEach(() => {
  resetLimiters({ limit: 2, windowMs: WINDOW });
});

/** Time one Run request under the given credentials. */
const timed = async (run: Run) => {
  const started = Date.now();
  await run.one(async () => 1);
  return Date.now() - started;
};

describe('SlidingWindowLimiter', () => {
  it('grants up to the limit at once, then waits for the oldest slot to leave the window', async () => {
    const limiter = new SlidingWindowLimiter(2, WINDOW);
    const started = Date.now();
    await limiter.acquire();
    await limiter.acquire();
    expect(Date.now() - started).toBeLessThan(WINDOW / 2);
    await limiter.acquire();
    expect(Date.now() - started).toBeGreaterThanOrEqual(WINDOW - 20);
  });

  it('slides: a slot frees as soon as the oldest request ages out, not at a fixed boundary', async () => {
    let now = 0;
    const limiter = new SlidingWindowLimiter(2, 1000, () => now);
    await limiter.acquire(); // t=0
    now = 600;
    await limiter.acquire(); // t=600
    now = 1001;
    // The t=0 request has aged out, so this resolves without waiting (the fake clock never advances on its own).
    await expect(limiter.acquire()).resolves.toBeUndefined();
  });

  it('rejects promptly when the signal aborts while waiting', async () => {
    const limiter = new SlidingWindowLimiter(1, 60_000);
    await limiter.acquire();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const started = Date.now();
    await expect(limiter.acquire(controller.signal)).rejects.toBeInstanceOf(LimiterAbortError);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('rejects at once for a signal that is already aborted', async () => {
    const limiter = new SlidingWindowLimiter(5, 60_000);
    await expect(limiter.acquire(AbortSignal.abort())).rejects.toBeInstanceOf(LimiterAbortError);
  });
});

describe('limiterFor', () => {
  it('returns one limiter per key and a different one for another key', () => {
    expect(limiterFor('key-a')).toBe(limiterFor('key-a'));
    expect(limiterFor('key-a')).not.toBe(limiterFor('key-b'));
  });

  it('is bounded: the oldest keys are evicted beyond 1000', () => {
    const first = limiterFor('key-0');
    for (let i = 1; i <= 1100; i++) limiterFor(`key-${i}`);
    expect(limiterCount()).toBe(1000);
    expect(limiterFor('key-0')).not.toBe(first);
  });

  it('uses the defaults of 60 requests per 60 seconds', () => {
    resetLimiters();
    const limiter = limiterFor('key-a');
    expect(limiter.limit).toBe(60);
    expect(limiter.windowMs).toBe(60_000);
  });
});

describe('shared across runs', () => {
  it('two Run instances with the same key share one budget of slots', async () => {
    await runWithCredentials({ apiKey: 'same-key' }, async () => {
      const a = new Run({ maxCalls: 10 });
      const b = new Run({ maxCalls: 10 });
      expect(await timed(a)).toBeLessThan(WINDOW / 2);
      expect(await timed(b)).toBeLessThan(WINDOW / 2);
      // Two slots are used between them; the third request waits for the window.
      expect(await timed(a)).toBeGreaterThanOrEqual(WINDOW - 20);
    });
  });

  it('runs with different keys do not share slots', async () => {
    const times = await Promise.all(
      ['key-one', 'key-two'].map((apiKey) =>
        runWithCredentials({ apiKey }, async () => {
          const run = new Run({ maxCalls: 10 });
          await timed(run);
          await timed(run);
          return timed(new Run({ maxCalls: 10 }));
        }),
      ),
    );
    // Each key used its own two slots, so the third request on each waits - but on its own window.
    for (const t of times) expect(t).toBeGreaterThanOrEqual(WINDOW - 20);
    await runWithCredentials({ apiKey: 'key-three' }, async () => {
      expect(await timed(new Run({ maxCalls: 10 }))).toBeLessThan(WINDOW / 2);
    });
  });

  it('a run that is cancelled while waiting for a slot stops promptly with "cancelled"', async () => {
    resetLimiters({ limit: 1, windowMs: 60_000 });
    await runWithCredentials({ apiKey: 'busy-key' }, async () => {
      await new Run({ maxCalls: 1 }).one(async () => 1);
      const controller = new AbortController();
      const run = new Run({ maxCalls: 5, signal: controller.signal });
      setTimeout(() => controller.abort(), 20);
      const started = Date.now();
      const result = await run.one(async () => 1);
      expect(result).toBeUndefined();
      expect(Date.now() - started).toBeLessThan(500);
      expect(run.envelope().partialReason).toContain('Cancelled');
      expect(run.budget.used).toBe(0);
    });
  });

  it('a run waiting for a slot stops at its deadline', async () => {
    resetLimiters({ limit: 1, windowMs: 60_000 });
    await runWithCredentials({ apiKey: 'busy-key-2' }, async () => {
      await new Run({ maxCalls: 1 }).one(async () => 1);
      const run = new Run({ maxCalls: 5, deadlineMs: 40 });
      const started = Date.now();
      await run.one(async () => 1);
      expect(Date.now() - started).toBeLessThan(500);
      expect(run.envelope().partialReason).toContain('time limit');
    });
  });
});

describe('plain entity tools', () => {
  it('wait for the shared limiter before calling the SDK, and stop when cancelled', async () => {
    const fetchMock = vi.fn(async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    resetLimiters({ limit: 1, windowMs: 60_000 });
    try {
      await runWithCredentials({ apiKey: 'entity-key' }, async () => {
        await salesHandler.handleCall('kqm_quote_list', {});
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 20);
        await expect(salesHandler.handleCall('kqm_quote_get', { id: 1 }, { signal: controller.signal })).rejects.toBeInstanceOf(LimiterAbortError);
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });
      // Another key has its own slot.
      await runWithCredentials({ apiKey: 'other-entity-key' }, async () => {
        await salesHandler.handleCall('kqm_quote_list', {});
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('acquireForCurrentKey', () => {
  it('uses the limiter of the current credentials and does nothing without credentials', async () => {
    const original = process.env.KASEYA_QUOTE_MANAGER_API_KEY;
    delete process.env.KASEYA_QUOTE_MANAGER_API_KEY;
    try {
      await acquireForCurrentKey();
      expect(limiterCount()).toBe(0);
    } finally {
      if (original !== undefined) process.env.KASEYA_QUOTE_MANAGER_API_KEY = original;
    }
    await runWithCredentials({ apiKey: 'plain-key' }, async () => {
      await acquireForCurrentKey();
      await acquireForCurrentKey();
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 10);
      await expect(acquireForCurrentKey(controller.signal)).rejects.toBeInstanceOf(LimiterAbortError);
    });
  });
});
