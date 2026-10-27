import { createHash } from 'node:crypto';
import { RateLimitError } from '@wyre-ai/node-kaseya-quote-manager';
import { getCredentials } from './client.js';

export const RATE_LIMIT_REQUESTS = 60;
export const RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_MAX_KEYS = 1000;

/** Rejected by `acquire` when its signal aborts while waiting for a slot. */
export class LimiterAbortError extends Error {
  constructor() {
    super('Stopped waiting for a Quote Manager request slot. Try again.');
  }
}

/** Sliding window: at most `limit` slots in any `windowMs`. */
export class SlidingWindowLimiter {
  private readonly stamps: number[] = [];

  /** True when no slot taken is still inside the window, so dropping this limiter loses nothing. */
  isIdle(): boolean {
    const t = this.now();
    return !this.stamps.length || this.stamps[this.stamps.length - 1] <= t - this.windowMs;
  }

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

interface LimiterConfig { limit: number; windowMs: number; maxKeys: number }
const DEFAULT_CONFIG: LimiterConfig = { limit: RATE_LIMIT_REQUESTS, windowMs: RATE_LIMIT_WINDOW_MS, maxKeys: DEFAULT_MAX_KEYS };

// One limiter per API key, keyed by a hash so the raw key is never stored.
// At the cap, the least recently used idle key (no slot inside its window) is evicted; if every key is active, new keys are refused.
const limiters = new Map<string, SlidingWindowLimiter>();
let config = DEFAULT_CONFIG;

export function limiterFor(apiKey: string): SlidingWindowLimiter {
  const id = createHash('sha256').update(apiKey).digest('hex');
  let limiter = limiters.get(id);
  if (limiter) {
    limiters.delete(id);
  } else {
    if (limiters.size >= config.maxKeys) {
      // Map order is least recently used first.
      const idle = [...limiters].find(([, l]) => l.isIdle());
      if (!idle) {
        throw new RateLimitError(
          'Too many API keys are active on this server right now, so this request was refused. Wait a minute and try again.',
          Math.ceil(config.windowMs / 1000),
          undefined,
        );
      }
      limiters.delete(idle[0]);
    }
    limiter = new SlidingWindowLimiter(config.limit, config.windowMs);
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
