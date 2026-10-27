import { isRateLimitError } from '../errors.js';

export const PAGE_SIZE = 100;
export const DEFAULT_MAX_CALLS = 60;
export const MAX_CALLS_LIMIT = 120;

/** Thrown by CallBudget.call when the run has used all of its API calls. */
export class BudgetExhausted extends Error {}

/** Thrown when a run passes its deadline or the client cancels it. */
export class RunAborted extends Error {
  constructor(readonly reason: 'deadline' | 'cancelled') {
    super(`Run stopped: ${reason}`);
  }
}

/** Counts SDK requests for one report run. Reports use maxRetries 0, so one call is one HTTP attempt. */
export class CallBudget {
  used = 0;
  constructor(readonly maxCalls: number) {}

  take(): boolean {
    if (this.used >= this.maxCalls) return false;
    this.used++;
    return true;
  }

  async call<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.take()) throw new BudgetExhausted();
    return fn();
  }
}

export type StopReason = 'complete' | 'maxItems' | 'budget' | 'rateLimit' | 'deadline' | 'cancelled';

export interface PageResult<T> {
  items: T[];
  partial: boolean;
  reason: StopReason;
}

/**
 * Read 1-based pages of 100 until a short page (complete), `maxItems` is reached
 * with more possibly left (partial), or the call budget runs out (partial). A
 * rate-limit error, a deadline or a cancel keeps what was gathered and reports
 * partial. `call` runs each request; by default it spends one budget unit.
 */
export async function paginate<T>(
  fetchPage: (page: number) => Promise<T[]>,
  opts: { budget: CallBudget; maxItems: number; pageSize?: number; call?: <R>(fn: () => Promise<R>) => Promise<R> },
): Promise<PageResult<T>> {
  const pageSize = opts.pageSize ?? PAGE_SIZE;
  const call = opts.call ?? (<R>(fn: () => Promise<R>) => opts.budget.call(fn));
  const items: T[] = [];
  for (let page = 1; ; page++) {
    let rows: T[];
    try {
      rows = await call(() => fetchPage(page));
    } catch (err) {
      if (err instanceof BudgetExhausted) return { items, partial: true, reason: 'budget' };
      if (err instanceof RunAborted) return { items, partial: true, reason: err.reason };
      if (isRateLimitError(err)) return { items, partial: true, reason: 'rateLimit' };
      throw err;
    }
    if (!Array.isArray(rows)) rows = [];
    const room = opts.maxItems - items.length;
    items.push(...rows.slice(0, room));
    if (items.length >= opts.maxItems && (rows.length > room || rows.length >= pageSize)) {
      return { items, partial: true, reason: 'maxItems' };
    }
    if (rows.length < pageSize) return { items, partial: false, reason: 'complete' };
  }
}
