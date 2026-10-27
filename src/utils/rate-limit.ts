import { createHash } from 'node:crypto';
import { getCredentials } from './client.js';

export const RATE_LIMIT_REQUESTS = 60;
export const RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_MAX_KEYS = 10_000;

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
// A key is tracked only after a request through its limiter succeeded (see rememberLimiter), so bad keys never fill the table.
// At the cap, the least recently used idle key (no slot inside its window) is dropped; if every key is busy, the new key
// keeps a temporary limiter for that call or run and nobody's window is reset. The limiter never refuses a request.
const limiters = new Map<string, SlidingWindowLimiter>();
let config = DEFAULT_CONFIG;

const keyId = (apiKey: string): string => createHash('sha256').update(apiKey).digest('hex');

/** The stored limiter for this key (marked most recently used), or a new unstored one. Never throws, never evicts. */
export function limiterFor(apiKey: string): SlidingWindowLimiter {
  const id = keyId(apiKey);
  const stored = limiters.get(id);
  if (!stored) return new SlidingWindowLimiter(config.limit, config.windowMs);
  limiters.delete(id);
  limiters.set(id, stored);
  return stored;
}

/**
 * Track `limiter` for this key. Call only after a request through it succeeded.
 * Already tracked: nothing changes. At the cap: drops the least recently used idle key; if none is idle, the limiter stays temporary.
 */
export function rememberLimiter(apiKey: string, limiter: SlidingWindowLimiter): void {
  const id = keyId(apiKey);
  if (limiters.has(id)) return;
  if (limiters.size >= config.maxKeys) {
    // Map order is least recently used first; stop at the first idle key without copying the table.
    let idle: string | undefined;
    for (const [key, l] of limiters) {
      if (l.isIdle()) {
        idle = key;
        break;
      }
    }
    if (idle === undefined) return;
    limiters.delete(idle);
  }
  limiters.set(id, limiter);
}

/**
 * Run `fn` under the limiter of the current request's credentials: wait for a slot, run, and track the key if it succeeded.
 * No credentials: just run `fn`.
 */
export async function withKeyLimiter<T>(signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
  const creds = getCredentials();
  if (!creds) return fn();
  const limiter = limiterFor(creds.apiKey);
  await limiter.acquire(signal);
  const result = await fn();
  rememberLimiter(creds.apiKey, limiter);
  return result;
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
