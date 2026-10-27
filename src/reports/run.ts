import { isRateLimitError } from '../errors.js';
import { intProp, type Prop } from '../domains/schema.js';
import { getCredentials } from '../utils/client.js';
import { limiterFor } from '../utils/rate-limit.js';
import type { RequestContext } from '../utils/types.js';
import { BudgetExhausted, CallBudget, RunAborted, paginate, PAGE_SIZE, DEFAULT_MAX_CALLS, MAX_CALLS_LIMIT, type PageResult, type StopReason } from './budget.js';

export const maxCallsProp: Prop = intProp(
  'Maximum Quote Manager API requests this tool may make (each request counts as one). It stops and returns partial results at this limit.',
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

const RATE_LIMIT_REASON = 'Stopped early because Quote Manager is rate limiting requests (HTTP 429), so these figures cover only the records read before that. Wait a minute and try again, or narrow the request with modifiedAfter.';
const RECORD_LIMIT_REASON = 'Stopped at the record limit (maxQuotes, maxOrders, maxLines or maxPurchaseOrders), so more records may exist. Narrow the request with modifiedAfter or raise that limit.';
const CANCELLED_REASON = 'Cancelled before it finished, so these figures cover only the records read so far. Run it again for complete figures.';
const PRIORITY: Record<StopReason, number> = { complete: 0, maxItems: 1, budget: 2, rateLimit: 3, deadline: 4, cancelled: 5 };

/** Overall time limit for one report run. */
export const REPORT_DEADLINE_MS = 75_000;

/** Request context for report and full-record runs. `deadlineMs` overrides the default (for tests). */
export interface RunContext extends RequestContext {
  deadlineMs?: number;
}

export interface RunOptions extends RunContext {
  maxCalls: number;
  /** Slot source for requests. Defaults to the shared limiter of the current credentials. */
  limiter?: { acquire(signal?: AbortSignal): Promise<void> };
}

/**
 * Abort when any input aborts. AbortSignal.any needs Node 20.3; older 20.x gets a manual join,
 * whose listeners on the source signals are removed by `cleanup`.
 */
function anySignal(signals: AbortSignal[]): { signal: AbortSignal; cleanup: () => void } {
  if (typeof AbortSignal.any === 'function') return { signal: AbortSignal.any(signals), cleanup: () => {} };
  const controller = new AbortController();
  const attached: Array<[AbortSignal, () => void]> = [];
  for (const s of signals) {
    if (s.aborted) {
      controller.abort(s.reason);
      break;
    }
    const onAbort = () => controller.abort(s.reason);
    s.addEventListener('abort', onAbort, { once: true });
    attached.push([s, onAbort]);
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      for (const [s, onAbort] of attached) s.removeEventListener('abort', onAbort);
      attached.length = 0;
    },
  };
}

/**
 * State for one report run: one call budget, sequential requests, a deadline,
 * client cancellation, and the first/most serious stop reason.
 */
export class Run {
  readonly budget: CallBudget;
  /** True once the run must stop issuing requests: budget spent, rate limited, past the deadline or cancelled. */
  stopped = false;
  private reason: StopReason = 'complete';
  private readonly deadlineMs: number;
  private readonly clientSignal?: AbortSignal;
  private readonly signal: AbortSignal;
  private readonly deadline: AbortController;
  private readonly limiter?: { acquire(signal?: AbortSignal): Promise<void> };
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly cleanups = new Set<() => void>();
  private isClosed = false;

  constructor(opts: RunOptions) {
    this.budget = new CallBudget(opts.maxCalls);
    this.deadlineMs = opts.deadlineMs ?? REPORT_DEADLINE_MS;
    this.clientSignal = opts.signal;
    if (opts.limiter) {
      this.limiter = opts.limiter;
    } else {
      const creds = getCredentials();
      if (creds) {
        try {
          this.limiter = limiterFor(creds.apiKey);
        } catch (err) {
          // No limiter could be made for this key (server at its key cap): the first request fails as a rate limit.
          if (!isRateLimitError(err)) throw err;
          this.limiter = { acquire: () => Promise.reject(err) };
        }
      }
    }
    // A plain timer, held by this run: AbortSignal.timeout inside AbortSignal.any can fire late or be collected.
    this.deadline = new AbortController();
    this.timer = setTimeout(() => this.deadline.abort(new RunAborted('deadline')), this.deadlineMs);
    this.timer.unref?.();
    const joined = anySignal([...(opts.signal ? [opts.signal] : []), this.deadline.signal]);
    this.signal = joined.signal;
    this.cleanups.add(joined.cleanup);
  }

  /** True once `close()` has run. */
  get closed(): boolean {
    return this.isClosed;
  }

  /** Release the deadline timer and every abort listener this run added. Safe to call more than once. */
  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    clearTimeout(this.timer);
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups.clear();
  }

  /** A run for a tool call: `maxCalls` comes from the arguments. */
  static start(args: Record<string, unknown>, ctx: RunContext = {}): Run {
    return new Run({ ...ctx, maxCalls: intArg(args, 'maxCalls', DEFAULT_MAX_CALLS) });
  }

  private note(reason: StopReason): void {
    if (reason !== 'complete' && reason !== 'maxItems') this.stopped = true;
    if (PRIORITY[reason] > PRIORITY[this.reason]) this.reason = reason;
  }

  private abortError(): RunAborted {
    return new RunAborted(this.clientSignal?.aborted ? 'cancelled' : 'deadline');
  }

  /**
   * One SDK request: wait for a shared rate-limit slot, spend one budget unit, then run it.
   * The SDK cannot cancel a request, so an abort rejects at once and the request is left to finish.
   */
  async exec<T>(fn: () => Promise<T>): Promise<T> {
    if (this.signal.aborted) throw this.abortError();
    if (this.budget.used >= this.budget.maxCalls) throw new BudgetExhausted();
    try {
      await this.limiter?.acquire(this.signal);
    } catch (err) {
      if (this.signal.aborted) throw this.abortError();
      throw err;
    }
    if (this.signal.aborted) throw this.abortError();
    this.budget.take();
    const request = (async () => fn())();
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(this.abortError());
      const detach = () => {
        this.signal.removeEventListener('abort', onAbort);
        this.cleanups.delete(detach);
      };
      this.signal.addEventListener('abort', onAbort, { once: true });
      this.cleanups.add(detach);
      request.then(
        (value) => { detach(); resolve(value); },
        (err) => { detach(); reject(err); },
      );
    });
  }

  /** Paginate a list, recording why it stopped. `maxItems` defaults to no record limit. */
  async list<T>(fetchPage: (page: number) => Promise<T[]>, maxItems = Number.POSITIVE_INFINITY): Promise<PageResult<T>> {
    if (this.stopped) return { items: [], partial: true, reason: this.reason };
    const result = await paginate(fetchPage, { budget: this.budget, maxItems, pageSize: PAGE_SIZE, call: (fn) => this.exec(fn) });
    this.note(result.reason);
    return result;
  }

  /** One request. Undefined means the budget, rate limit, deadline or a cancel stopped it; other errors propagate. */
  async one<T>(fn: () => Promise<T>): Promise<T | undefined> {
    if (this.stopped) return undefined;
    try {
      return await this.exec(fn);
    } catch (err) {
      if (err instanceof BudgetExhausted) this.note('budget');
      else if (err instanceof RunAborted) this.note(err.reason);
      else if (isRateLimitError(err)) this.note('rateLimit');
      else throw err;
      return undefined;
    }
  }

  private partialReason(): string | undefined {
    switch (this.reason) {
      case 'complete':
        return undefined;
      case 'rateLimit':
        return RATE_LIMIT_REASON;
      case 'cancelled':
        return CANCELLED_REASON;
      case 'deadline':
        return `Stopped at the ${+(this.deadlineMs / 1000).toFixed(2)}-second time limit, so these figures cover only the records read so far. Narrow the request with modifiedAfter or a smaller limit.`;
      case 'budget':
        return `Stopped at maxCalls (${this.budget.maxCalls} API calls), so these figures cover only the records read so far. Narrow the request with modifiedAfter or a smaller limit, or raise maxCalls.`;
      default:
        return RECORD_LIMIT_REASON;
    }
  }

  /** Spread this FIRST in a result so partial and partialReason sit at the top and survive truncation. */
  envelope(): { partial: boolean; partialReason?: string; callsUsed: number; generatedAt: string } {
    const partialReason = this.partialReason();
    return {
      partial: partialReason !== undefined,
      ...(partialReason ? { partialReason } : {}),
      callsUsed: this.budget.used,
      generatedAt: new Date().toISOString(),
    };
  }
}
