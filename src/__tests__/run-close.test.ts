/** Run.close(): the deadline timer and abort listeners are released when a run ends, on success and on error. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reportsHandler } from '../domains/reports.js';
import { salesHandler } from '../domains/sales.js';
import { procurementHandler } from '../domains/procurement.js';
import { Run } from '../reports/run.js';
import { runPipelineSummary } from '../reports/pipeline.js';
import { runQuoteConversionFunnel } from '../reports/funnel.js';
import { runSalesOrderMargin } from '../reports/margin.js';
import { runCustomerSpend } from '../reports/spend.js';
import { runProductVelocity } from '../reports/velocity.js';
import { runPurchaseVsSales } from '../reports/reconciliation.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const savedKey = process.env.KASEYA_QUOTE_MANAGER_API_KEY;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env.KASEYA_QUOTE_MANAGER_API_KEY = 'test-key-not-real';
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (savedKey === undefined) delete process.env.KASEYA_QUOTE_MANAGER_API_KEY;
  else process.env.KASEYA_QUOTE_MANAGER_API_KEY = savedKey;
});

/** Capture every Run a report creates. */
function captureRuns(): Run[] {
  const runs: Run[] = [];
  const start = Run.start.bind(Run);
  vi.spyOn(Run, 'start').mockImplementation((args, ctx) => {
    const run = start(args, ctx);
    runs.push(run);
    return run;
  });
  return runs;
}

describe('Run.close', () => {
  it('clears the deadline timer and is idempotent', () => {
    const clear = vi.spyOn(globalThis, 'clearTimeout');
    const run = new Run({ maxCalls: 1 });
    expect(run.closed).toBe(false);
    run.close();
    run.close();
    expect(run.closed).toBe(true);
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it('a closed run never fires its deadline', async () => {
    vi.useFakeTimers();
    try {
      const run = new Run({ maxCalls: 1, deadlineMs: 100 });
      run.close();
      await vi.advanceTimersByTimeAsync(500);
      expect(vi.getTimerCount()).toBe(0);
      await expect(run.one(async () => 1)).resolves.toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('removes the fallback listeners from the client signal (AbortSignal.any missing)', async () => {
    const original = AbortSignal.any;
    (AbortSignal as { any?: unknown }).any = undefined;
    try {
      fetchMock.mockImplementation(async () => json([]));
      const client = new AbortController();
      const add = vi.spyOn(client.signal, 'addEventListener');
      const remove = vi.spyOn(client.signal, 'removeEventListener');
      const run = new Run({ maxCalls: 5, signal: client.signal });
      expect(add).toHaveBeenCalledWith('abort', expect.any(Function), { once: true });
      const added = add.mock.calls[0][1];
      run.close();
      expect(remove).toHaveBeenCalledWith('abort', added);
      // After close, a client abort no longer reaches the run.
      client.abort();
    } finally {
      (AbortSignal as { any?: unknown }).any = original;
    }
  });

  it('removes listeners exec() added that are still pending', async () => {
    const client = new AbortController();
    const run = new Run({ maxCalls: 5, signal: client.signal });
    const pending = run.exec(() => new Promise<number>(() => {}));
    pending.catch(() => {});
    await Promise.resolve();
    await Promise.resolve();
    run.close();
    client.abort();
    // The pending request was detached, so the abort does not reject it.
    const settled = await Promise.race([pending.then(() => 'settled', () => 'settled'), new Promise((r) => setTimeout(() => r('pending'), 20))]);
    expect(settled).toBe('pending');
  });
});

describe('reports close their run', () => {
  const reports: Array<[string, (a: Record<string, unknown>) => Promise<unknown>, Record<string, unknown>]> = [
    ['pipeline', (a) => runPipelineSummary(a), {}],
    ['funnel', (a) => runQuoteConversionFunnel(a), {}],
    ['margin', (a) => runSalesOrderMargin(a), {}],
    ['spend', (a) => runCustomerSpend(a), {}],
    ['velocity', (a) => runProductVelocity(a), {}],
    ['reconciliation', (a) => runPurchaseVsSales(a), { salesOrderID: 1 }],
  ];

  it.each(reports)('%s closes on success', async (_name, run, args) => {
    fetchMock.mockImplementation(async () => json([]));
    const runs = captureRuns();
    await run(args);
    expect(runs).toHaveLength(1);
    expect(runs[0].closed).toBe(true);
  });

  it.each(reports)('%s closes when a request fails', async (_name, run, args) => {
    fetchMock.mockImplementation(async () => json({ error: 'boom' }, 500));
    const runs = captureRuns();
    await expect(run(args)).rejects.toThrow();
    expect(runs).toHaveLength(1);
    expect(runs[0].closed).toBe(true);
  });

  it('clears the deadline timer after a report', async () => {
    fetchMock.mockImplementation(async () => json([]));
    const clear = vi.spyOn(globalThis, 'clearTimeout');
    await reportsHandler.handleCall('kqm_pipeline_summary', {});
    expect(clear).toHaveBeenCalled();
  });

  it.each([
    ['kqm_quote_get_full', 'quotes'],
    ['kqm_sales_order_get_full', 'salesOrders'],
    ['kqm_purchase_order_get_full', 'purchaseOrders'],
  ])('%s closes on success and on error', async (tool) => {
    const handler = tool === 'kqm_purchase_order_get_full' ? procurementHandler : salesHandler;
    const runs = captureRuns();
    fetchMock.mockImplementation(async () => json([]));
    await handler.handleCall(tool, { id: 1 });
    expect(runs).toHaveLength(1);
    expect(runs[0].closed).toBe(true);
    fetchMock.mockImplementation(async () => json({ error: 'boom' }, 500));
    await expect(handler.handleCall(tool, { id: 1 })).rejects.toThrow();
    expect(runs).toHaveLength(2);
    expect(runs[1].closed).toBe(true);
  });
});
