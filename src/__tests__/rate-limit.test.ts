import { describe, it, expect, vi } from 'vitest';
import { RateLimitError, ServerError, NotFoundError } from '@wyre-technology/node-kaseya-quote-manager';
import {
  withRateLimitRetry,
  retryAfterSeconds,
  KqmRateLimitedError,
  MAX_TOTAL_WAIT_MS,
} from '../utils/rate-limit.js';

function recorder() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => { waits.push(ms); }, random: () => 0 };
}

const rateLimited = (retryAfter: number) => new RateLimitError('Rate limit exceeded', retryAfter, {});

describe('retryAfterSeconds', () => {
  it('uses the error retryAfter, rounded up', () => {
    expect(retryAfterSeconds(rateLimited(3))).toBe(3);
    expect(retryAfterSeconds({ statusCode: 429, retryAfter: 2.2 })).toBe(3);
  });

  it('defaults to 60 s when the value is missing or unusable', () => {
    expect(retryAfterSeconds({ statusCode: 429 })).toBe(60);
    expect(retryAfterSeconds({ statusCode: 429, retryAfter: Number.NaN })).toBe(60);
    expect(retryAfterSeconds({ statusCode: 429, retryAfter: -1 })).toBe(60);
  });
});

describe('withRateLimitRetry', () => {
  it('returns the first result without waiting', async () => {
    const r = recorder();
    await expect(withRateLimitRetry(async () => 'ok', r)).resolves.toBe('ok');
    expect(r.waits).toEqual([]);
  });

  it('retries a 429 after its Retry-After, then succeeds', async () => {
    const r = recorder();
    const fn = vi.fn()
      .mockRejectedValueOnce(rateLimited(2))
      .mockResolvedValueOnce('ok');
    await expect(withRateLimitRetry(fn, r)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(r.waits).toEqual([2000]);
  });

  it('gives up after two retries and says how long to wait', async () => {
    const r = recorder();
    const fn = vi.fn().mockRejectedValue(rateLimited(5));
    const err = (await withRateLimitRetry(fn, r).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(KqmRateLimitedError);
    expect(err.message).toBe(
      'Kaseya Quote Manager rate-limited the request (HTTP 429). Try again in 5 s.',
    );
    expect(fn).toHaveBeenCalledTimes(3);
    expect(r.waits).toEqual([5000, 5000]);
  });

  it('does not wait for a Retry-After over 10 s', async () => {
    const r = recorder();
    const fn = vi.fn().mockRejectedValue(rateLimited(60));
    const err = (await withRateLimitRetry(fn, r).catch((e: unknown) => e)) as Error;
    expect(err.message).toContain('Try again in 60 s.');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(r.waits).toEqual([]);
  });

  it('keeps the total wait within 20 s', async () => {
    const r = recorder();
    const fn = vi.fn()
      .mockRejectedValueOnce(rateLimited(10))
      .mockRejectedValueOnce(rateLimited(10))
      .mockRejectedValueOnce(rateLimited(10))
      .mockResolvedValue('late');
    const err = (await withRateLimitRetry(fn, r).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(KqmRateLimitedError);
    expect(r.waits.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(MAX_TOTAL_WAIT_MS);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('stops before a wait that would pass the 20 s total', async () => {
    const r = recorder();
    const fn = vi.fn()
      .mockRejectedValueOnce(rateLimited(9))
      .mockRejectedValueOnce(rateLimited(9))
      .mockRejectedValueOnce(rateLimited(9));
    const err = (await withRateLimitRetry(fn, r).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(KqmRateLimitedError);
    expect(r.waits).toEqual([9000, 9000]);
  });

  it('retries a 5xx with 1 s then 2 s backoff and rethrows it', async () => {
    const r = recorder();
    const fail = new ServerError('Server error: 502', {});
    const fn = vi.fn().mockRejectedValue(fail);
    await expect(withRateLimitRetry(fn, r)).rejects.toBe(fail);
    expect(fn).toHaveBeenCalledTimes(3);
    expect(r.waits).toEqual([1000, 2000]);
  });

  it('retries a network failure', async () => {
    const r = recorder();
    const fn = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce('ok');
    await expect(withRateLimitRetry(fn, r)).resolves.toBe('ok');
    expect(r.waits).toEqual([1000]);
  });

  it('adds at most 25% jitter to the backoff', async () => {
    const waits: number[] = [];
    const fn = vi.fn().mockRejectedValue(new ServerError('Server error: 500', {}));
    await withRateLimitRetry(fn, { sleep: async (ms) => { waits.push(ms); }, random: () => 0.999 }).catch(() => {});
    expect(waits[0]).toBeGreaterThan(1000);
    expect(waits[0]).toBeLessThanOrEqual(1250);
    expect(waits[1]).toBeLessThanOrEqual(2500);
  });

  it('does not retry other errors', async () => {
    const r = recorder();
    const notFound = new NotFoundError('Resource not found', {});
    const fn = vi.fn().mockRejectedValue(notFound);
    await expect(withRateLimitRetry(fn, r)).rejects.toBe(notFound);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(r.waits).toEqual([]);
  });
});
