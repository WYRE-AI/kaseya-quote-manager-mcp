/**
 * Report hardening: supplier pagination, envelope order, completeness flags,
 * deadline and cancellation. The SDK client is faked here; the retry-counting
 * test in retry-counting.test.ts uses the real client.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RateLimitError } from '@wyre-ai/node-kaseya-quote-manager';

vi.mock('../utils/client.js', () => ({ getClient: vi.fn(), getCredentials: vi.fn(() => ({ apiKey: 'k' })) }));

import { getClient } from '../utils/client.js';
import { reportsHandler } from '../domains/reports.js';
import { salesHandler } from '../domains/sales.js';
import { procurementHandler } from '../domains/procurement.js';
import { MAX_CALLS_LIMIT } from '../reports/budget.js';
import { REPORT_DEADLINE_MS, Run } from '../reports/run.js';
import { pipelineTool, runPipelineSummary } from '../reports/pipeline.js';
import { quoteFullTool, salesOrderFullTool } from '../reports/full.js';
import { createMockClient, type MockClient } from './helpers/mock-client.js';
import { unwrap } from './helpers/unwrap.js';

let client: MockClient;

beforeEach(() => {
  client = createMockClient();
  vi.mocked(getClient).mockReset();
  vi.mocked(getClient).mockReturnValue(client as never);
});

const report = async (tool: string, args: Record<string, unknown> = {}) => unwrap(await reportsHandler.handleCall(tool, args));
const rows = (n: number, make: (i: number) => object = (i) => ({ id: i + 1 })) => Array.from({ length: n }, (_, i) => make(i));
const slow = <T>(value: T, ms = 400) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));
const PARTIAL_BUDGET = (n: number) => `Stopped at maxCalls (${n} API calls), so these figures cover only the records read so far. Narrow the request with modifiedAfter or a smaller limit, or raise maxCalls.`;

describe('call limit', () => {
  it('caps maxCalls at 120 with a default of 60', () => {
    expect(MAX_CALLS_LIMIT).toBe(120);
    const props = pipelineTool.inputSchema.properties as Record<string, { maximum: number; default: number }>;
    expect(props.maxCalls).toMatchObject({ maximum: 120, default: 60 });
  });
});

describe('pipeline supplier pagination', () => {
  function oneQuoteOneProduct() {
    client.quotes.list.mockResolvedValue([{ id: 1, status: 1 }]);
    client.quoteSections.list.mockResolvedValue([{ id: 10 }]);
    client.quoteLines.list.mockResolvedValue([{ price: 100, quantity: 2, productID: 500 }]);
  }

  it('finds the cheapest supplier cost on page 2', async () => {
    oneQuoteOneProduct();
    client.productSuppliers.list.mockImplementation(async ({ page }: { page: number }) =>
      page === 1 ? rows(100, () => ({ cost: 50 })) : [{ cost: 7 }],
    );
    const out = await report('kqm_pipeline_summary', { includeCost: true });
    expect(client.productSuppliers.list.mock.calls.map((c) => c[0])).toEqual([
      { productID: 500, page: 1, pageSize: 100 },
      { productID: 500, page: 2, pageSize: 100 },
    ]);
    expect(out.byStatus).toEqual([{ status: 1, count: 1, total: 200, cost: 14, margin: 186 }]);
    expect(out.partial).toBe(false);
  });

  it('is partial, and prices nothing from the supplier page, when the budget runs out mid-pagination', async () => {
    oneQuoteOneProduct();
    client.productSuppliers.list.mockImplementation(async () => rows(100, () => ({ cost: 50 })));
    // quotes 1 + sections 1 + lines 1 + supplier page 1 = 4; page 2 is over budget.
    const out = await report('kqm_pipeline_summary', { includeCost: true, maxCalls: 4 });
    expect(out).toMatchObject({ partial: true, partialReason: PARTIAL_BUDGET(4), quotesScanned: 1, quotesPriced: 0 });
    expect(out.byStatus).toEqual([{ status: 1, count: 1, total: 0, cost: 0, margin: 0 }]);
  });
});

describe('envelope first', () => {
  it('puts partial before the data in every report and the full tools', async () => {
    client.quotes.list.mockResolvedValue([{ status: 1 }]);
    client.salesOrders.list.mockResolvedValue([]);
    client.salesOrderLines.list.mockResolvedValue([]);
    client.purchaseOrders.list.mockResolvedValue([]);
    client.quotes.get.mockResolvedValue({ id: 1 });
    client.quoteSections.list.mockResolvedValue([]);
    const first = (o: object) => Object.keys(o).slice(0, 3);
    for (const [tool, args] of [
      ['kqm_pipeline_summary', {}],
      ['kqm_quote_conversion_funnel', {}],
      ['kqm_sales_order_margin_report', {}],
      ['kqm_customer_spend_summary', {}],
      ['kqm_product_velocity_report', {}],
      ['kqm_purchase_vs_sales_reconciliation', { salesOrderID: 1 }],
    ] as const) {
      expect(first(await report(tool, args)), tool).toEqual(['partial', 'callsUsed', 'generatedAt']);
    }
    expect(first(unwrap(await salesHandler.handleCall('kqm_quote_get_full', { id: 1 })))).toEqual(['partial', 'callsUsed', 'generatedAt']);
    client.quotes.list.mockResolvedValue(rows(100, () => ({ status: 1 })));
    const partial = await report('kqm_pipeline_summary', { maxQuotes: 1, maxCalls: 1 });
    expect(Object.keys(partial).slice(0, 2)).toEqual(['partial', 'partialReason']);
  });

  it('keeps partial and partialReason in the text when a large result is truncated', async () => {
    client.salesOrders.get.mockResolvedValue({ id: 1, notes: 'x'.repeat(200_000) });
    client.salesOrderLines.list.mockResolvedValue(rows(100));
    const res = await salesHandler.handleCall('kqm_sales_order_get_full', { id: 1, maxCalls: 2 });
    const text = res.content[0].text;
    expect(text).toContain('[TRUNCATED');
    expect(text).toContain('"partial": true');
    expect(text).toContain('"partialReason"');
    expect(text.indexOf('"partial"')).toBeLessThan(text.indexOf('"salesOrder"'));
  });

  it('keeps the reconciliation warning near the top', async () => {
    client.salesOrderLines.list.mockResolvedValue([]);
    client.purchaseOrders.list.mockResolvedValue(rows(100));
    const out = await report('kqm_purchase_vs_sales_reconciliation', { salesOrderID: 1, maxCalls: 2 });
    expect(Object.keys(out).slice(0, 5)).toEqual(['partial', 'partialReason', 'callsUsed', 'generatedAt', 'warning']);
  });
});

describe('get_full completeness flags', () => {
  it('marks every section complete when pagination finished', async () => {
    client.quotes.get.mockResolvedValue({ id: 1 });
    client.quoteSections.list.mockResolvedValue([{ id: 10 }]);
    client.quoteLines.list.mockResolvedValue([{ id: 1 }]);
    const out = unwrap(await salesHandler.handleCall('kqm_quote_get_full', { id: 1 }));
    expect(out.complete).toEqual({ sections: true, lines: true });
    expect(out.sections[0].linesComplete).toBe(true);
  });

  it('marks the sections that were cut', async () => {
    client.quotes.get.mockResolvedValue({ id: 1 });
    client.quoteSections.list.mockResolvedValue([{ id: 10 }, { id: 11 }]);
    client.quoteLines.list.mockResolvedValue([{ id: 1 }]);
    const out = unwrap(await salesHandler.handleCall('kqm_quote_get_full', { id: 1, maxCalls: 3 }));
    expect(out.complete).toEqual({ sections: true, lines: false });
    expect(out.sections.map((s: { linesComplete: boolean }) => s.linesComplete)).toEqual([true, false]);
  });

  it('flags each child list of sales and purchase orders', async () => {
    client.salesOrders.get.mockResolvedValue({ id: 2 });
    client.salesOrderLines.list.mockResolvedValue(rows(100));
    client.salesOrderPayments.list.mockResolvedValue([]);
    // 1 get + 2 full line pages = 3: lines cut, payments never read.
    const so = unwrap(await salesHandler.handleCall('kqm_sales_order_get_full', { id: 2, maxCalls: 3 }));
    expect(so.complete).toEqual({ lines: false, payments: false });
    client.purchaseOrders.get.mockResolvedValue({ id: 3 });
    client.purchaseOrderLines.list.mockResolvedValue([]);
    client.purchaseOrderCosts.list.mockResolvedValue(rows(100));
    const po = unwrap(await procurementHandler.handleCall('kqm_purchase_order_get_full', { id: 3, maxCalls: 3 }));
    expect(po.complete).toEqual({ lines: true, costs: false });
  });
});

describe('deadline and cancellation', () => {
  it('has a 75-second default deadline', () => {
    expect(REPORT_DEADLINE_MS).toBe(75_000);
  });

  it('returns a partial result promptly at the deadline although the request cannot be cancelled', async () => {
    client.quotes.list.mockImplementation(() => slow(rows(100, () => ({ status: 1 }))));
    const started = Date.now();
    const out = await runPipelineSummary({}, { deadlineMs: 50 });
    expect(Date.now() - started).toBeLessThan(300);
    expect(out).toMatchObject({
      partial: true,
      partialReason: 'Stopped at the 0.05-second time limit, so these figures cover only the records read so far. Narrow the request with modifiedAfter or a smaller limit.',
      quotesScanned: 0,
    });
  });

  it('keeps what was read before the deadline', async () => {
    client.quotes.list.mockImplementation(async ({ page }: { page: number }) => (page === 1 ? rows(100, () => ({ status: 1 })) : slow([])));
    const out = await runPipelineSummary({ maxQuotes: 200 }, { deadlineMs: 60 });
    expect(out).toMatchObject({ partial: true, quotesScanned: 100 });
    expect(out.partialReason).toContain('time limit');
  });

  it('names the actual time limit in the reason', async () => {
    const run = new Run({ maxCalls: 5, deadlineMs: 20, limiter: { acquire: async () => undefined } });
    await run.one(() => slow(1));
    expect(run.envelope().partialReason).toMatch(/^Stopped at the 0\.02-second time limit/);
    const long = new Run({ maxCalls: 5, deadlineMs: 2000, limiter: { acquire: async () => undefined } });
    expect(long.envelope().partial).toBe(false);
  });

  it('stops with "cancelled" when the client signal aborts', async () => {
    const controller = new AbortController();
    client.quotes.list.mockImplementation(() => slow(rows(100, () => ({ status: 1 }))));
    setTimeout(() => controller.abort(), 30);
    const started = Date.now();
    const res = await reportsHandler.handleCall('kqm_pipeline_summary', {}, { signal: controller.signal });
    expect(Date.now() - started).toBeLessThan(300);
    expect(unwrap(res)).toMatchObject({
      partial: true,
      partialReason: 'Cancelled before it finished, so these figures cover only the records read so far. Run it again for complete figures.',
    });
    expect(client.quotes.list).toHaveBeenCalledTimes(1);
  });

  it('makes no request when the signal is already aborted', async () => {
    const out = unwrap(await reportsHandler.handleCall('kqm_pipeline_summary', {}, { signal: AbortSignal.abort() }));
    expect(out).toMatchObject({ partial: true, callsUsed: 0 });
    expect(out.partialReason).toContain('Cancelled');
    expect(client.quotes.list).not.toHaveBeenCalled();
  });

  it('ranks budget above the record limit, and a rate limit above the budget', async () => {
    const limiter = { acquire: async () => undefined };
    const full = async () => rows(100);
    const a = new Run({ maxCalls: 1, limiter });
    await a.list(full, 100); // record limit
    expect(a.envelope().partialReason).toContain('record limit');
    await a.one(async () => 1); // budget spent
    expect(a.envelope().partialReason).toContain('maxCalls');

    const b = new Run({ maxCalls: 5, limiter });
    await b.list(full, 100);
    await b.one(async () => { throw new RateLimitError('x', 1, null); });
    expect(b.envelope().partialReason).toContain('rate limiting');
    expect(b.stopped).toBe(true);
  });

  it('a stopped run keeps its reason and makes no further requests', async () => {
    const run = new Run({ maxCalls: 5, signal: AbortSignal.abort(), limiter: { acquire: async () => undefined } });
    expect(await run.one(async () => 1)).toBeUndefined();
    const listed = await run.list(async () => rows(100));
    expect(listed).toMatchObject({ partial: true, reason: 'cancelled', items: [] });
    expect(run.budget.used).toBe(0);
  });

  it('full tools: a deadline before the record is an error; a late one leaves a partial result', async () => {
    client.quotes.get.mockImplementation(() => slow({ id: 1 }));
    const early = await quoteFullTool.run({ id: 1 }, { deadlineMs: 30 });
    expect(early.isError).toBe(true);
    expect(early.content[0].text).toBe('Stopped at the 75-second time limit before the record was read. Try again, or use the matching get tool, such as kqm_quote_get.');

    client.salesOrders.get.mockResolvedValue({ id: 2 });
    client.salesOrderLines.list.mockImplementation(() => slow([]));
    const late = unwrap(await salesOrderFullTool.run({ id: 2 }, { deadlineMs: 40 }));
    expect(late).toMatchObject({ partial: true, complete: { lines: false, payments: false } });
    expect(late.partialReason).toContain('time limit');
  });

  it('threads extra.signal from the domain handler to the full tools', async () => {
    client.salesOrders.get.mockImplementation(() => slow({ id: 2 }));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const res = await salesHandler.handleCall('kqm_sales_order_get_full', { id: 2 }, { signal: controller.signal });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe('Cancelled before the record was read.');
  });
});
