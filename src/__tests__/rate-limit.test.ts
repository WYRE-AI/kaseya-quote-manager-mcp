import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { salesHandler } from '../domains/sales.js';
import { LimiterAbortError, SlidingWindowLimiter, limiterCount, limiterFor, rememberLimiter, resetLimiters, withKeyLimiter } from '../utils/rate-limit.js';
import { runWithCredentials } from '../utils/client.js';
import { Run } from '../reports/run.js';
import { runPipelineSummary } from '../reports/pipeline.js';

const okFetch = () => vi.fn(async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }));
const failFetch = (status: number) => vi.fn(async () => new Response('{}', { status, headers: { 'content-type': 'application/json' } }));

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
  it('returns the stored limiter for a remembered key and a different one for another key', () => {
    const a = limiterFor('key-a');
    rememberLimiter('key-a', a);
    expect(limiterFor('key-a')).toBe(a);
    expect(limiterFor('key-b')).not.toBe(a);
  });

  it('does not store an unknown key until rememberLimiter is called', () => {
    const a = limiterFor('key-a');
    expect(limiterCount()).toBe(0);
    expect(limiterFor('key-a')).not.toBe(a);
    rememberLimiter('key-a', a);
    expect(limiterCount()).toBe(1);
    expect(limiterFor('key-a')).toBe(a);
  });

  it('rememberLimiter keeps the stored limiter when the key is already stored', () => {
    const a = limiterFor('key-a');
    rememberLimiter('key-a', a);
    rememberLimiter('key-a', new SlidingWindowLimiter(2, WINDOW));
    expect(limiterFor('key-a')).toBe(a);
    expect(limiterCount()).toBe(1);
  });

  it('defaults to a cap of 10,000 keys', () => {
    for (let i = 0; i < 10_001; i++) rememberLimiter(`key-${i}`, new SlidingWindowLimiter(2, WINDOW));
    expect(limiterCount()).toBe(10_000);
  });

  describe('failed and successful requests', () => {
    afterEach(() => vi.unstubAllGlobals());

    it.each([401, 500])('a plain call that fails with %i does not store the key', async (status) => {
      vi.stubGlobal('fetch', failFetch(status));
      await runWithCredentials({ apiKey: 'bad-key' }, async () => {
        await expect(salesHandler.handleCall('kqm_quote_list', {})).rejects.toBeDefined();
      });
      expect(limiterCount()).toBe(0);
    });

    it('a report run whose requests all fail does not store the key', async () => {
      vi.stubGlobal('fetch', failFetch(500));
      await runWithCredentials({ apiKey: 'bad-key' }, async () => {
        await expect(runPipelineSummary({})).rejects.toBeDefined();
      });
      expect(limiterCount()).toBe(0);
    });

    it('a successful plain call stores the key', async () => {
      vi.stubGlobal('fetch', okFetch());
      await runWithCredentials({ apiKey: 'good-key' }, () => salesHandler.handleCall('kqm_quote_list', {}));
      expect(limiterCount()).toBe(1);
    });

    it('a successful report run stores the key once', async () => {
      vi.stubGlobal('fetch', okFetch());
      await runWithCredentials({ apiKey: 'good-key' }, async () => {
        const run = new Run({ maxCalls: 10 });
        await run.one(async () => 1);
        await run.one(async () => 1);
        run.close();
      });
      expect(limiterCount()).toBe(1);
    });

    it('a run with an injected limiter does not store the key', async () => {
      await runWithCredentials({ apiKey: 'injected' }, async () => {
        await new Run({ maxCalls: 10, limiter: { acquire: async () => {} } }).one(async () => 1);
      });
      expect(limiterCount()).toBe(0);
    });
  });

  describe('at the key cap', () => {
    beforeEach(() => resetLimiters({ limit: 2, windowMs: 60_000, maxKeys: 3 }));
    afterEach(() => vi.unstubAllGlobals());

    const fill = async (keys = ['a', 'b', 'c']) => {
      const out = keys.map((k) => {
        const l = limiterFor(k);
        rememberLimiter(k, l);
        return l;
      });
      return out;
    };

    it('evicts the least recently used idle key, stores the new key and keeps active keys with their windows', async () => {
      const [a, b, c] = await fill();
      await a.acquire();
      await a.acquire();
      await c.acquire();
      // b never took a slot, so it is the only idle key.
      const d = limiterFor('d');
      rememberLimiter('d', d);
      expect(limiterCount()).toBe(3);
      expect(limiterFor('a')).toBe(a);
      expect(limiterFor('c')).toBe(c);
      expect(limiterFor('d')).toBe(d);
      expect(limiterFor('b')).not.toBe(b);
      // a's window survived: it is still full.
      await expect(a.acquire(AbortSignal.timeout(30))).rejects.toBeInstanceOf(LimiterAbortError);
    });

    it('picks the oldest idle key when several are idle', async () => {
      const [a, b] = await fill();
      limiterFor('a'); // a is now most recently used, so b is the oldest
      rememberLimiter('d', limiterFor('d'));
      expect(limiterFor('a')).toBe(a);
      expect(limiterFor('b')).not.toBe(b);
    });

    describe('with every key active', () => {
      let existing: SlidingWindowLimiter[];
      beforeEach(async () => {
        existing = await fill();
        for (const l of existing) await l.acquire();
      });

      const expectUntouched = () => {
        expect(limiterCount()).toBe(3);
        ['a', 'b', 'c'].forEach((k, i) => expect(limiterFor(k)).toBe(existing[i]));
      };

      it('never refuses a new key: limiterFor returns a limiter and acquire resolves', async () => {
        const d = limiterFor('d');
        await expect(d.acquire()).resolves.toBeUndefined();
        rememberLimiter('d', d);
        expectUntouched();
        expect(limiterFor('d')).not.toBe(d);
      });

      it("does not reset anyone's window", async () => {
        for (const l of existing) await l.acquire(); // each now holds its full 2 slots
        rememberLimiter('d', limiterFor('d'));
        for (const l of existing) await expect(l.acquire(AbortSignal.timeout(30))).rejects.toBeInstanceOf(LimiterAbortError);
      });

      it('a plain tool call succeeds and leaves the table unchanged', async () => {
        const fetchMock = okFetch();
        vi.stubGlobal('fetch', fetchMock);
        await runWithCredentials({ apiKey: 'newcomer' }, async () => {
          await expect(salesHandler.handleCall('kqm_quote_list', {})).resolves.toBeDefined();
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expectUntouched();
      });

      it('a report run succeeds and leaves the table unchanged', async () => {
        const fetchMock = okFetch();
        vi.stubGlobal('fetch', fetchMock);
        const out = await runWithCredentials({ apiKey: 'newcomer' }, () => runPipelineSummary({}));
        expect(out.partial).toBe(false);
        expect(fetchMock).toHaveBeenCalled();
        expectUntouched();
      });

      it('a run with an unstored limiter still enforces the limit within that run', async () => {
        await runWithCredentials({ apiKey: 'newcomer' }, async () => {
          const run = new Run({ maxCalls: 10, deadlineMs: 60 });
          await run.one(async () => 1);
          await run.one(async () => 1);
          const started = Date.now();
          // The third request needs a slot that the run's own limiter does not have until the window passes.
          expect(await run.one(async () => 1)).toBeUndefined();
          expect(Date.now() - started).toBeLessThan(500);
          expect(run.envelope().partialReason).toContain('time limit');
          expect(run.budget.used).toBe(2);
          run.close();
        });
        expectUntouched();
      });
    });
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
      expect(await timed(a)).toBeLessThan(WINDOW / 2);
      // The key is tracked after a's first success, so b (started later) shares a's limiter.
      const b = new Run({ maxCalls: 10 });
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

describe('withKeyLimiter', () => {
  it('just runs fn without credentials', async () => {
    const original = process.env.KASEYA_QUOTE_MANAGER_API_KEY;
    delete process.env.KASEYA_QUOTE_MANAGER_API_KEY;
    try {
      await expect(withKeyLimiter(undefined, async () => 'ran')).resolves.toBe('ran');
      expect(limiterCount()).toBe(0);
    } finally {
      if (original !== undefined) process.env.KASEYA_QUOTE_MANAGER_API_KEY = original;
    }
  });

  it('waits for a slot on the current key, stores the key on success and not on failure', async () => {
    await runWithCredentials({ apiKey: 'plain-key' }, async () => {
      await expect(withKeyLimiter(undefined, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
      expect(limiterCount()).toBe(0);
      await withKeyLimiter(undefined, async () => 1);
      expect(limiterCount()).toBe(1);
      await withKeyLimiter(undefined, async () => 1); // limit 2: the window is now full
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 10);
      await expect(withKeyLimiter(controller.signal, async () => 1)).rejects.toBeInstanceOf(LimiterAbortError);
    });
  });
});
