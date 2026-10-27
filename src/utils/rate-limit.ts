import { createHash } from 'node:crypto';
import { getCredentials } from './client.js';

export const RATE_LIMIT_REQUESTS = 60;
export const RATE_LIMIT_WINDOW_MS = 60_000;
const MAX_KEYS = 1000;

/** Rejected by `acquire` when its signal aborts while waiting for a slot. */
export class LimiterAbortError extends Error {
  constructor() {
    super('Stopped waiting for a Quote Manager request slot. Try again.');
  }
}

/** Sliding window: at most `limit` slots in any `windowMs`. */
export class SlidingWindowLimiter {
  private readonly stamps: number[] = [];

  constructor(
    readonly limit = RATE_LIMIT_REQUESTS,
    readonly windowMs = RATE_LIMIT_WINDOW_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Wait for a slot. Rejects promptly with LimiterAbortError if `signal` aborts first. */
  async acquire(signal?: AbortSignal): Promise<void> {
    for (;;) {
      if (signal?.aborted) throw new LimiterAbortError();
      const t = this.now();
      while (this.stamps.length && this.stamps[0] <= t - this.windowMs) this.stamps.shift();
      if (this.stamps.length < this.limit) {
        this.stamps.push(t);
        return;
      }
      await this.sleep(this.stamps[0] + this.windowMs - t, signal);
    }
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new LimiterAbortError());
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, Math.max(1, ms));
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}

interface LimiterConfig { limit: number; windowMs: number }
const DEFAULT_CONFIG: LimiterConfig = { limit: RATE_LIMIT_REQUESTS, windowMs: RATE_LIMIT_WINDOW_MS };

// One limiter per API key, keyed by a hash so the raw key is never stored. Least recently used keys are evicted.
const limiters = new Map<string, SlidingWindowLimiter>();
let config = DEFAULT_CONFIG;

export function limiterFor(apiKey: string): SlidingWindowLimiter {
  const id = createHash('sha256').update(apiKey).digest('hex');
  let limiter = limiters.get(id);
  if (limiter) {
    limiters.delete(id);
  } else {
    limiter = new SlidingWindowLimiter(config.limit, config.windowMs);
    while (limiters.size >= MAX_KEYS) limiters.delete(limiters.keys().next().value as string);
  }
  limiters.set(id, limiter);
  return limiter;
}

/** Wait for a slot on the limiter of the current request's credentials. No credentials: no wait. */
export async function acquireForCurrentKey(signal?: AbortSignal): Promise<void> {
  const creds = getCredentials();
  if (creds) await limiterFor(creds.apiKey).acquire(signal);
}

/** Test hook: drop every limiter and set the limit and window used for new ones. With no argument, restores the defaults. */
export function resetLimiters(next: Partial<LimiterConfig> = {}): void {
  limiters.clear();
  config = { ...DEFAULT_CONFIG, ...next };
}

/** Test hook: number of keys tracked. */
export function limiterCount(): number {
  return limiters.size;
}
