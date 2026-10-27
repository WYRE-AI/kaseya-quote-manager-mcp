import { isRateLimitError } from '../errors.js';
import { intProp, type Prop } from '../domains/schema.js';
import { BudgetExhausted, CallBudget, paginate, PAGE_SIZE, DEFAULT_MAX_CALLS, MAX_CALLS_LIMIT, type PageResult, type StopReason } from './budget.js';

export const maxCallsProp: Prop = intProp(
  'Maximum Quote Manager API requests this report may make (each request counts as one). The report stops and returns partial results at this limit.',
  1,
  MAX_CALLS_LIMIT,
  DEFAULT_MAX_CALLS,
);

/** Read an optional integer argument. Callers have already validated it against the tool schema. */
export function intArg(args: Record<string, unknown>, name: string, def: number): number {
  const v = args[name];
  return typeof v === 'number' ? v : def;
}

export function strArg(args: Record<string, unknown>, name: string): string | undefined {
  const v = args[name];
  return typeof v === 'string' ? v : undefined;
}

export function boolArg(args: Record<string, unknown>, name: string, def: boolean): boolean {
  const v = args[name];
  return typeof v === 'boolean' ? v : def;
}

/** A missing or non-numeric value counts as 0. */
export const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export const round2 = (v: number): number => Math.round((v + Number.EPSILON) * 100) / 100;
export const round1 = (v: number): number => Math.round((v + Number.EPSILON) * 10) / 10;
export const round4 = (v: number): number => Math.round((v + Number.EPSILON) * 10000) / 10000;

export const isPositiveId = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

const RATE_LIMIT_REASON = 'Stopped early because Quote Manager rate-limited the key. Try again later or narrow the request.';
const RECORD_LIMIT_REASON = 'Stopped at the record limit. Narrow the request with modifiedAfter or raise the limit.';
const PRIORITY: Record<StopReason, number> = { complete: 0, maxItems: 1, budget: 2, rateLimit: 3 };

/** State for one report run: one call budget, sequential requests, and the first/most serious stop reason. */
export class Run {
  readonly budget: CallBudget;
  /** True once the budget is spent or Quote Manager rate-limited the key: stop issuing requests. */
  stopped = false;
  private reason: StopReason = 'complete';

  constructor(maxCalls: number) {
    this.budget = new CallBudget(maxCalls);
  }

  private note(reason: StopReason): void {
    if (reason === 'budget' || reason === 'rateLimit') this.stopped = true;
    if (PRIORITY[reason] > PRIORITY[this.reason]) this.reason = reason;
  }

  /** Paginate a list, recording why it stopped. `maxItems` defaults to no record limit. */
  async list<T>(fetchPage: (page: number) => Promise<T[]>, maxItems = Number.POSITIVE_INFINITY): Promise<PageResult<T>> {
    if (this.stopped) return { items: [], partial: true, reason: 'budget' };
    const result = await paginate(fetchPage, { budget: this.budget, maxItems, pageSize: PAGE_SIZE });
    this.note(result.reason);
    return result;
  }

  /** One request. Undefined means the budget or rate limit stopped it; other errors propagate. */
  async one<T>(fn: () => Promise<T>): Promise<T | undefined> {
    if (this.stopped) return undefined;
    try {
      return await this.budget.call(fn);
    } catch (err) {
      if (err instanceof BudgetExhausted) this.note('budget');
      else if (isRateLimitError(err)) this.note('rateLimit');
      else throw err;
      return undefined;
    }
  }

  envelope(): { partial: boolean; partialReason?: string; callsUsed: number; generatedAt: string } {
    const partialReason =
      this.reason === 'complete'
        ? undefined
        : this.reason === 'rateLimit'
          ? RATE_LIMIT_REASON
          : this.reason === 'budget'
            ? `Stopped at maxCalls (${this.budget.maxCalls} API calls). Narrow the request with modifiedAfter or a smaller limit, or raise maxCalls.`
            : RECORD_LIMIT_REASON;
    return {
      partial: partialReason !== undefined,
      ...(partialReason ? { partialReason } : {}),
      callsUsed: this.budget.used,
      generatedAt: new Date().toISOString(),
    };
  }
}
