/**
 * Retry counting: the real SDK client runs here (only globalThis.fetch is faked),
 * so a budget unit has to equal one HTTP attempt. The shared limiter is widened so the test is fast.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ServerError } from '@wyre-technology/node-kaseya-quote-manager';
import { reportsHandler } from '../domains/reports.js';
import { salesHandler } from '../domains/sales.js';
import { resetLimiters } from '../utils/rate-limit.js';
import { unwrap } from './helpers/unwrap.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fullPage = () => Array.from({ length: 100 }, () => ({ status: 1 }));

const savedKey = process.env.KASEYA_QUOTE_MANAGER_API_KEY;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env.KASEYA_QUOTE_MANAGER_API_KEY = 'test-key-not-real';
  resetLimiters({ limit: 1_000_000 });
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (savedKey === undefined) delete process.env.KASEYA_QUOTE_MANAGER_API_KEY;
  else process.env.KASEYA_QUOTE_MANAGER_API_KEY = savedKey;
});

describe('retry counting (real SDK client, fake fetch)', () => {
  it.each([1, 3, 5])('maxCalls %i makes exactly that many HTTP requests against endless full pages', async (n) => {
    fetchMock.mockImplementation(async () => json(fullPage()));
    const out = unwrap(await reportsHandler.handleCall('kqm_quote_conversion_funnel', { maxQuotes: 2000, maxCalls: n }));
    expect(fetchMock).toHaveBeenCalledTimes(n);
    expect(out).toMatchObject({ partial: true, callsUsed: n });
  });

  it('does not retry a 500: one request, and the error surfaces', async () => {
    fetchMock.mockImplementationOnce(async () => json({ error: 'boom' }, 500)).mockImplementation(async () => json([]));
    await expect(reportsHandler.handleCall('kqm_pipeline_summary', { maxCalls: 10 })).rejects.toBeInstanceOf(ServerError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry a 429: one request, partial result', async () => {
    fetchMock.mockImplementation(async () => json({}, 429));
    const out = unwrap(await reportsHandler.handleCall('kqm_pipeline_summary', { maxCalls: 10 }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ partial: true, callsUsed: 1 });
    expect(out.partialReason).toContain('rate limiting');
  });

  it('does not retry a network error', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    await expect(reportsHandler.handleCall('kqm_pipeline_summary', { maxCalls: 10 })).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('applies to *_get_full tools too', async () => {
    fetchMock.mockImplementationOnce(async () => json({ id: 1 })).mockImplementation(async () => json(fullPage()));
    const out = unwrap(await salesHandler.handleCall('kqm_sales_order_get_full', { id: 1, maxCalls: 4 }));
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(out).toMatchObject({ partial: true, callsUsed: 4 });

    fetchMock.mockReset();
    fetchMock.mockImplementationOnce(async () => json({ id: 1 })).mockImplementationOnce(async () => json({}, 500));
    await expect(salesHandler.handleCall('kqm_sales_order_get_full', { id: 1, maxCalls: 10 })).rejects.toBeInstanceOf(ServerError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a 429 on a get_full child list keeps the partial result', async () => {
    fetchMock.mockImplementationOnce(async () => json({ id: 1 })).mockImplementation(async () => json({}, 429));
    const out = unwrap(await salesHandler.handleCall('kqm_sales_order_get_full', { id: 1 }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(out).toMatchObject({ partial: true, complete: { lines: false, payments: false } });
  });
});
