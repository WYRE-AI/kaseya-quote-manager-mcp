import { isRateLimitError } from '../errors.js';

export const PAGE_SIZE = 100;
export const DEFAULT_MAX_CALLS = 60;
export const MAX_CALLS_LIMIT = 500;

/** Thrown by CallBudget.call when the run has used all of its API calls. */
export class BudgetExhausted extends Error {}

/** Counts SDK requests for one report run. Every request is one call, retries aside. */
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

export type StopReason = 'complete' | 'maxItems' | 'budget' | 'rateLimit';

export interface PageResult<T> {
  items: T[];
  partial: boolean;
  reason: StopReason;
}

/**
 * Read 1-based pages of 100 until a short page (complete), `maxItems` is reached
 * with more possibly left (partial), or the call budget runs out (partial). A
 * rate-limit error keeps what was gathered and reports partial.
 */
export async function paginate<T>(
  fetchPage: (page: number) => Promise<T[]>,
  opts: { budget: CallBudget; maxItems: number; pageSize?: number },
): Promise<PageResult<T>> {
  const pageSize = opts.pageSize ?? PAGE_SIZE;
  const items: T[] = [];
  for (let page = 1; ; page++) {
    let rows: T[];
    try {
      rows = await opts.budget.call(() => fetchPage(page));
    } catch (err) {
      if (err instanceof BudgetExhausted) return { items, partial: true, reason: 'budget' };
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
