// Bounded retry for rate-limited and failed upstream requests.
//
// The Kaseya Quote Manager API allows 60 requests/minute and 20,000/day per key.
// The client library would retry a 429 up to 3 times, waiting the full
// Retry-After each time (60 s when the header is missing), so one tool call
// could hang for minutes. The client is built with maxRetries: 0 and this
// wrapper retries instead, with a hard bound:
//
// - A 429, a 5xx or a network failure is retried at most twice.
// - A 429 waits for its Retry-After. A Retry-After longer than 10 s is not
//   waited for: the error is returned at once with that wait time.
// - 5xx and network failures wait 1 s, then 2 s, with jitter.
// - Each wait is capped at 10 s and the total wait at 20 s.
//
// When it gives up on a 429, the error says how long to wait:
// "Kaseya Quote Manager rate-limited the request (HTTP 429). Try again in N s."
// Every tool is a read, so repeating a call is safe.

export const MAX_RETRIES = 2;
export const MAX_WAIT_MS = 10_000;
export const MAX_TOTAL_WAIT_MS = 20_000;
export const DEFAULT_RETRY_AFTER_S = 60;

export class KqmRateLimitedError extends Error {
  constructor(public readonly retryAfterSeconds: number) {
    super(
      `Kaseya Quote Manager rate-limited the request (HTTP 429). Try again in ${retryAfterSeconds} s.`,
    );
    this.name = 'KqmRateLimitedError';
  }
}

interface ErrorWithStatus {
  statusCode?: unknown;
  retryAfter?: unknown;
}

function statusOf(err: unknown): number | undefined {
  const code = (err as ErrorWithStatus | null)?.statusCode;
  return typeof code === 'number' ? code : undefined;
}

/** Seconds from a 429 error, or the 60 s default when it has no usable value. */
export function retryAfterSeconds(err: unknown): number {
  const value = (err as ErrorWithStatus | null)?.retryAfter;
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.ceil(value);
  return DEFAULT_RETRY_AFTER_S;
}

function isNetworkFailure(err: unknown): boolean {
  return err instanceof TypeError && statusOf(err) === undefined;
}

export interface RetryOptions {
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function withRateLimitRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  let waited = 0;

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = statusOf(err);
      const rateLimited = status === 429;
      const transient = rateLimited || (status !== undefined && status >= 500) || isNetworkFailure(err);
      if (!transient) throw err;

      let waitMs: number;
      if (rateLimited) {
        const seconds = retryAfterSeconds(err);
        waitMs = seconds * 1000;
        if (attempt >= MAX_RETRIES || waitMs > MAX_WAIT_MS || waited + waitMs > MAX_TOTAL_WAIT_MS) {
          throw new KqmRateLimitedError(seconds);
        }
      } else {
        const base = 1000 * 2 ** attempt;
        waitMs = Math.min(MAX_WAIT_MS, Math.round(base + base * 0.25 * random()));
        if (attempt >= MAX_RETRIES || waited + waitMs > MAX_TOTAL_WAIT_MS) throw err;
      }

      waited += waitMs;
      await sleep(waitMs);
    }
  }
}
