import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NotFoundError, RateLimitError, ServerError } from '@wyre-technology/node-kaseya-quote-manager';

vi.mock('../utils/client.js', () => ({ getClient: vi.fn() }));

import { getClient } from '../utils/client.js';
import { reportsHandler } from '../domains/reports.js';
import { salesHandler } from '../domains/sales.js';
import { procurementHandler } from '../domains/procurement.js';
import { CallBudget, BudgetExhausted, paginate } from '../reports/budget.js';
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
const PARTIAL_BUDGET = (n: number) => `Stopped at maxCalls (${n} API calls), so these figures cover only the records read so far. Narrow the request with modifiedAfter or a smaller limit, or raise maxCalls.`;
const PARTIAL_RECORDS = 'Stopped at the record limit (maxQuotes, maxOrders, maxLines or maxPurchaseOrders), so more records may exist. Narrow the request with modifiedAfter or raise that limit.';
const PARTIAL_RATE = 'Stopped early because Quote Manager is rate limiting requests (HTTP 429), so these figures cover only the records read before that. Wait a minute and try again, or narrow the request with modifiedAfter.';

describe('paginate / CallBudget', () => {
  it('counts calls and throws when exhausted', async () => {
    const budget = new CallBudget(1);
    await budget.call(async () => 1);
    expect(budget.used).toBe(1);
    await expect(budget.call(async () => 1)).rejects.toBeInstanceOf(BudgetExhausted);
    expect(budget.used).toBe(1);
  });

  it('stops on a short page and reads 1-based pages of 100', async () => {
    const fetchPage = vi.fn(async (page: number) => rows(page === 1 ? 100 : 20));
    const r = await paginate(fetchPage, { budget: new CallBudget(10), maxItems: 1000 });
    expect(r).toMatchObject({ partial: false, reason: 'complete' });
    expect(r.items).toHaveLength(120);
    expect(fetchPage.mock.calls.map((c) => c[0])).toEqual([1, 2]);
  });

  it('is partial at maxItems when the last page was full, complete when exactly drained by a short page', async () => {
    const full = await paginate(async () => rows(100), { budget: new CallBudget(10), maxItems: 100 });
    expect(full).toMatchObject({ partial: true, reason: 'maxItems' });
    const cut = await paginate(async () => rows(70), { budget: new CallBudget(10), maxItems: 50 });
    expect(cut.items).toHaveLength(50);
    expect(cut).toMatchObject({ partial: true, reason: 'maxItems' });
    const exact = await paginate(async () => rows(50), { budget: new CallBudget(10), maxItems: 50 });
    expect(exact).toMatchObject({ partial: false, reason: 'complete' });
  });

  it('is partial when the budget runs out and when the key is rate limited', async () => {
    const b = await paginate(async () => rows(100), { budget: new CallBudget(2), maxItems: 1000 });
    expect(b).toMatchObject({ partial: true, reason: 'budget' });
    expect(b.items).toHaveLength(200);
    const rl = await paginate(async (p) => { if (p === 2) throw new RateLimitError('x', 1, null); return rows(100); }, { budget: new CallBudget(10), maxItems: 1000 });
    expect(rl).toMatchObject({ partial: true, reason: 'rateLimit' });
    expect(rl.items).toHaveLength(100);
    await expect(paginate(async () => { throw new ServerError('x', null); }, { budget: new CallBudget(10), maxItems: 5 })).rejects.toBeInstanceOf(ServerError);
  });
});

describe('kqm_pipeline_summary', () => {
  function fixture() {
    client.quotes.list.mockResolvedValue([
      { id: 1, status: 2 },
      { id: 2, status: 1 },
      { id: 3, status: 1 },
    ]);
    client.quoteSections.list.mockImplementation(async ({ quoteID }: { quoteID: number }) =>
      ({
        1: [{ id: 10 }, { id: 11, isMultiChoice: true, isSelected: false }, { id: 12, isMultiChoice: true, isSelected: true }],
        2: [{ id: 20 }],
        3: [{ id: 30 }],
      })[quoteID],
    );
    client.quoteLines.list.mockImplementation(async ({ quoteSectionID }: { quoteSectionID: number }) =>
      ({
        10: [
          { price: 100, quantity: 2, productID: 500 },
          { price: 50, quantity: 1, isOptional: true, isSelected: false, productID: 500 },
          { price: 10, quantity: 3, isOptional: true, isSelected: true },
          { quantity: 4, productID: 501 },
        ],
        12: [{ price: 1, quantity: 1, productID: 500 }],
        20: [{ price: 5.555, quantity: 2, productID: 500 }],
        30: [{ price: 1000, quantity: 1 }],
      })[quoteSectionID] ?? [],
    );
  }

  it('totals lines, skips unselected optional lines and unselected multi-choice sections, groups by raw status', async () => {
    fixture();
    const out = await report('kqm_pipeline_summary');
    expect(out.byStatus).toEqual([
      { status: 1, count: 2, total: 1011.11 },
      { status: 2, count: 1, total: 231 },
    ]);
    expect(out.totals).toEqual({ count: 3, total: 1242.11 });
    expect(out).toMatchObject({ quotesScanned: 3, quotesPriced: 3, partial: false });
    expect(out.partialReason).toBeUndefined();
    expect(out.method).toContain('before tax and discounts');
    expect(new Date(out.generatedAt).toString()).not.toBe('Invalid Date');
    const sectionIds = client.quoteLines.list.mock.calls.map((c) => c[0].quoteSectionID);
    expect(sectionIds).not.toContain(11);
    // 1 quotes + 3 sections + 4 lines (sections 10, 12, 20, 30)
    expect(out.callsUsed).toBe(8);
    expect(getClient).toHaveBeenCalledTimes(1);
    expect(getClient).toHaveBeenCalledWith({ maxRetries: 1 });
  });

  it('passes modifiedAfter through', async () => {
    client.quotes.list.mockResolvedValue([]);
    await report('kqm_pipeline_summary', { modifiedAfter: '2026-01-01T00:00:00Z' });
    expect(client.quotes.list).toHaveBeenCalledWith({ modifiedAfter: '2026-01-01T00:00:00Z', page: 1, pageSize: 100 });
  });

  it('includeCost uses the lowest supplier cost per product, cached, and counts lines without cost', async () => {
    fixture();
    client.productSuppliers.list.mockImplementation(async ({ productID }: { productID: number }) =>
      productID === 500 ? [{ cost: 30 }, { cost: 20 }, {}] : [],
    );
    const out = await report('kqm_pipeline_summary', { includeCost: true });
    // quote 1: 500 x2 @20 = 40, 500 x1 (section 12) @20 = 20; 501 has no supplier cost, 10x3 line has no product
    // quote 2: 500 x2 @20 = 40; quote 3: no product
    expect(out.byStatus).toEqual([
      { status: 1, count: 2, total: 1011.11, cost: 40, margin: 971.11 },
      { status: 2, count: 1, total: 231, cost: 60, margin: 171 },
    ]);
    expect(out.totals).toEqual({ count: 3, total: 1242.11, cost: 100, margin: 1142.11, linesWithoutCost: 3 });
    expect(client.productSuppliers.list).toHaveBeenCalledTimes(2);
    expect(out.method).toContain('INFERRED');
  });

  it('without includeCost it makes no supplier calls and has no cost fields', async () => {
    fixture();
    const out = await report('kqm_pipeline_summary');
    expect(client.productSuppliers.list).not.toHaveBeenCalled();
    expect(out.byStatus[0]).not.toHaveProperty('cost');
  });

  it('stops at maxCalls with partial results: unread quotes count but are not priced', async () => {
    fixture();
    const out = await report('kqm_pipeline_summary', { maxCalls: 4 });
    expect(out.callsUsed).toBe(4);
    expect(out.partial).toBe(true);
    expect(out.partialReason).toBe(PARTIAL_BUDGET(4));
    expect(out.quotesScanned).toBe(3);
    expect(out.quotesPriced).toBeLessThan(3);
    expect(out.totals.count).toBe(3);
  });

  it('is partial at the record limit', async () => {
    client.quotes.list.mockResolvedValue(rows(100, (i) => ({ id: i + 1, status: 1 })));
    client.quoteSections.list.mockResolvedValue([]);
    const out = await report('kqm_pipeline_summary', { maxQuotes: 5 });
    expect(out).toMatchObject({ partial: true, partialReason: PARTIAL_RECORDS, quotesScanned: 5, quotesPriced: 5 });
  });

  it('reads quotes across pages of 100', async () => {
    client.quotes.list.mockImplementation(async ({ page }: { page: number }) => rows(page === 1 ? 100 : 20, (i) => ({ id: page * 1000 + i, status: 1 })));
    client.quoteSections.list.mockResolvedValue([]);
    const out = await report('kqm_pipeline_summary', { maxQuotes: 200, maxCalls: 500 });
    expect(out.quotesScanned).toBe(120);
    expect(out.partial).toBe(false);
    expect(client.quotes.list.mock.calls.map((c) => c[0].page)).toEqual([1, 2]);
  });

  it('returns what it gathered when rate limited mid-run, and propagates other errors', async () => {
    fixture();
    client.quoteLines.list.mockRejectedValueOnce(new RateLimitError('x', 1, null));
    const out = await report('kqm_pipeline_summary');
    expect(out).toMatchObject({ partial: true, partialReason: PARTIAL_RATE });
    expect(out.totals.count).toBe(3);
    fixture();
    client.quoteSections.list.mockRejectedValue(new ServerError('boom', null));
    await expect(reportsHandler.handleCall('kqm_pipeline_summary', {})).rejects.toBeInstanceOf(ServerError);
  });
});

describe('kqm_quote_conversion_funnel', () => {
  const quotes = () => [
    { id: 1, status: 3, salesOrderId: 5, createdDate: '2026-01-01T00:00:00Z', modifiedDate: '2026-01-20T00:00:00Z', expiryDate: '2020-01-01T00:00:00Z' },
    { id: 2, status: 3, salesOrderId: 6, createdDate: '2026-01-01T00:00:00Z', modifiedDate: '2026-01-04T00:00:00Z' },
    { id: 3, status: 1, expiryDate: '2020-01-01T00:00:00Z' },
    { id: 4, status: 1, salesOrderId: 0, expiryDate: '2020-06-01T00:00:00Z' },
    { id: 5, status: 1, expiryDate: '2999-01-01T00:00:00Z' },
  ];

  it('computes rates, win rate, average days and close date sources', async () => {
    client.quotes.list.mockResolvedValue(quotes());
    client.salesOrders.get.mockImplementation(async (id: number) => {
      if (id === 5) return { id: 5, orderDate: '2026-01-11T00:00:00Z' };
      throw new NotFoundError('gone', null);
    });
    const out = await report('kqm_quote_conversion_funnel');
    expect(out).toMatchObject({
      quotesScanned: 5,
      converted: 2,
      expiredUnconverted: 2,
      conversionRate: 0.4,
      winRate: 0.5,
      averageDaysToClose: 6.5,
      closeDateSource: { orderDate: 1, modifiedDate: 1 },
      partial: false,
      callsUsed: 3,
    });
    expect(out.byStatus).toEqual([{ status: 1, count: 3 }, { status: 3, count: 2 }]);
    expect(out.method).toContain('INFERRED');
  });

  it('useOrderDate false makes no sales order calls and uses the quote modifiedDate', async () => {
    client.quotes.list.mockResolvedValue(quotes());
    const out = await report('kqm_quote_conversion_funnel', { useOrderDate: false });
    expect(client.salesOrders.get).not.toHaveBeenCalled();
    expect(out.closeDateSource).toEqual({ orderDate: 0, modifiedDate: 2 });
    expect(out.averageDaysToClose).toBe(11);
    expect(out.callsUsed).toBe(1);
  });

  it('winRate and averageDaysToClose are null with nothing decided', async () => {
    client.quotes.list.mockResolvedValue([{ id: 5, status: 1, expiryDate: '2999-01-01T00:00:00Z' }]);
    const out = await report('kqm_quote_conversion_funnel');
    expect(out).toMatchObject({ winRate: null, averageDaysToClose: null, conversionRate: 0 });
    client.quotes.list.mockResolvedValue([]);
    expect(await report('kqm_quote_conversion_funnel')).toMatchObject({ conversionRate: null, winRate: null });
  });

  it('falls back to modifiedDate and is partial when the budget stops sales order lookups', async () => {
    client.quotes.list.mockResolvedValue(quotes());
    client.salesOrders.get.mockResolvedValue({ orderDate: '2026-01-11T00:00:00Z' });
    const out = await report('kqm_quote_conversion_funnel', { maxCalls: 2 });
    expect(out).toMatchObject({ partial: true, partialReason: PARTIAL_BUDGET(2), converted: 2, closeDateSource: { orderDate: 1, modifiedDate: 1 } });
  });

  it('is partial at the record limit and across pages', async () => {
    client.quotes.list.mockImplementation(async ({ page }: { page: number }) => rows(100, (i) => ({ id: page * 1000 + i, status: 1 })));
    const out = await report('kqm_quote_conversion_funnel', { maxQuotes: 150 });
    expect(out).toMatchObject({ partial: true, partialReason: PARTIAL_RECORDS, quotesScanned: 150, callsUsed: 2 });
  });

  it('handles a rate limit on the first page', async () => {
    client.quotes.list.mockRejectedValue(new RateLimitError('x', 1, null));
    const out = await report('kqm_quote_conversion_funnel');
    expect(out).toMatchObject({ partial: true, partialReason: PARTIAL_RATE, quotesScanned: 0 });
  });
});

describe('kqm_sales_order_margin_report', () => {
  function fixture() {
    client.salesOrders.list.mockResolvedValue([
      { id: 1, orderNumber: 'SO-1', customerID: 7, orderDate: '2026-02-01T00:00:00Z' },
      { id: 2, orderNumber: 'SO-2', customerID: 8 },
    ]);
    client.salesOrderLines.list.mockImplementation(async ({ salesOrderID }: { salesOrderID: number }) =>
      salesOrderID === 1
        ? [{ price: 100, cost: 60, quantity: 2 }, { price: 50, quantity: 1 }]
        : [],
    );
  }

  it('computes revenue, cost, margin and flags lines missing cost', async () => {
    fixture();
    const out = await report('kqm_sales_order_margin_report');
    expect(out.orders).toEqual([
      { salesOrderID: 1, orderNumber: 'SO-1', customerID: 7, orderDate: '2026-02-01T00:00:00Z', revenue: 250, cost: 120, margin: 130, marginPercent: 52, lines: 2, linesMissingCost: 1 },
      { salesOrderID: 2, orderNumber: 'SO-2', customerID: 8, orderDate: null, revenue: 0, cost: 0, margin: 0, marginPercent: null, lines: 0, linesMissingCost: 0 },
    ]);
    expect(out.totals).toEqual({ revenue: 250, cost: 120, margin: 130, marginPercent: 52, lines: 2, linesMissingCost: 1 });
    expect(out).toMatchObject({ ordersScanned: 2, ordersPriced: 2, partial: false, callsUsed: 3 });
    expect(out.method).toContain('overstated');
  });

  it('stops at maxCalls and reports partial', async () => {
    fixture();
    const out = await report('kqm_sales_order_margin_report', { maxCalls: 2 });
    expect(out).toMatchObject({ partial: true, partialReason: PARTIAL_BUDGET(2), ordersScanned: 2, ordersPriced: 1 });
  });

  it('is partial at the record limit', async () => {
    client.salesOrders.list.mockResolvedValue(rows(100, (i) => ({ id: i + 1 })));
    client.salesOrderLines.list.mockResolvedValue([]);
    const out = await report('kqm_sales_order_margin_report', { maxOrders: 3 });
    expect(out).toMatchObject({ partial: true, partialReason: PARTIAL_RECORDS, ordersScanned: 3 });
  });

  it('keeps finished orders when rate limited', async () => {
    fixture();
    client.salesOrderLines.list.mockResolvedValueOnce([{ price: 10, cost: 5, quantity: 1 }]).mockRejectedValueOnce(new RateLimitError('x', 1, null));
    const out = await report('kqm_sales_order_margin_report');
    expect(out).toMatchObject({ partial: true, partialReason: PARTIAL_RATE, ordersPriced: 1 });
  });
});

describe('kqm_customer_spend_summary', () => {
  function fixture() {
    client.salesOrders.list.mockResolvedValue([
      { id: 1, customerID: 7, deliveryAmount: 10, deliveryTax: 1 },
      { id: 2, customerID: 7 },
      { id: 3, customerID: 8 },
    ]);
    client.salesOrderLines.list.mockImplementation(async ({ salesOrderID }: { salesOrderID: number }) =>
      ({
        1: [{ price: 100, quantity: 2, cost: 50, tax: 20 }],
        2: [{ price: 40, quantity: 1, cost: 10, tax: 4 }],
        3: [{ price: 1000, quantity: 1 }],
      })[salesOrderID],
    );
    client.salesOrderPayments.list.mockImplementation(async ({ salesOrderID }: { salesOrderID: number }) =>
      salesOrderID === 1 ? [{ amount: 100 }] : salesOrderID === 2 ? [{ amount: 100 }] : [],
    );
  }

  it('aggregates per customer, sorted by revenue, with outstanding estimate', async () => {
    fixture();
    const out = await report('kqm_customer_spend_summary');
    expect(out.customers).toEqual([
      { customerID: 8, orders: 1, revenue: 1000, cost: 0, payments: 0, outstandingEstimate: 1000 },
      { customerID: 7, orders: 2, revenue: 250, cost: 110, payments: 200, outstandingEstimate: 75 },
    ]);
    expect(out).toMatchObject({ customersFound: 2, ordersScanned: 3, ordersMatched: 3, ordersPriced: 3, partial: false });
    // 1 orders + 3 x (lines + payments)
    expect(out.callsUsed).toBe(7);
    expect(out.method).toContain('INFERRED');
  });

  it('limits to top N but still reports customersFound', async () => {
    fixture();
    const out = await report('kqm_customer_spend_summary', { top: 1 });
    expect(out.customers).toHaveLength(1);
    expect(out.customers[0].customerID).toBe(8);
    expect(out.customersFound).toBe(2);
  });

  it('filters by customerID client-side and does not fetch other customers\' lines', async () => {
    fixture();
    const out = await report('kqm_customer_spend_summary', { customerID: 7 });
    expect(out.customers.map((c: { customerID: number }) => c.customerID)).toEqual([7]);
    expect(out).toMatchObject({ ordersScanned: 3, ordersMatched: 2, callsUsed: 5 });
    expect(client.salesOrderLines.list).toHaveBeenCalledTimes(2);
  });

  it('never goes below zero outstanding', async () => {
    client.salesOrders.list.mockResolvedValue([{ id: 1, customerID: 7 }]);
    client.salesOrderLines.list.mockResolvedValue([{ price: 10, quantity: 1 }]);
    client.salesOrderPayments.list.mockResolvedValue([{ amount: 500 }]);
    const out = await report('kqm_customer_spend_summary');
    expect(out.customers[0].outstandingEstimate).toBe(0);
  });

  it('stops at maxCalls and reports partial; leaves out unfinished orders', async () => {
    fixture();
    const out = await report('kqm_customer_spend_summary', { maxCalls: 4 });
    expect(out).toMatchObject({ partial: true, partialReason: PARTIAL_BUDGET(4), ordersPriced: 1 });
  });

  it('is partial at the record limit', async () => {
    client.salesOrders.list.mockResolvedValue(rows(100, (i) => ({ id: i + 1, customerID: 1 })));
    client.salesOrderLines.list.mockResolvedValue([]);
    client.salesOrderPayments.list.mockResolvedValue([]);
    const out = await report('kqm_customer_spend_summary', { maxOrders: 2 });
    expect(out).toMatchObject({ partial: true, partialReason: PARTIAL_RECORDS, ordersScanned: 2 });
  });
});

describe('kqm_product_velocity_report', () => {
  function fixture() {
    client.salesOrders.list.mockResolvedValue([
      { id: 1, customerID: 7 },
      { id: 2, customerID: 8 },
      { id: 3, customerID: 7 },
    ]);
    client.salesOrderLines.list.mockResolvedValue([
      { salesOrderID: 1, productID: 100, title: 'Alpha', price: 10, quantity: 5 },
      { salesOrderID: 2, productID: 100, title: 'Alpha v2', price: 10, quantity: 5 },
      { salesOrderID: 1, productID: 200, title: 'Beta', price: 100, quantity: 10 },
      { salesOrderID: 9, productID: 300, title: 'Gamma', price: 1, quantity: 1 },
      { salesOrderID: 1, title: 'Misc', price: 5, quantity: 5 },
    ]);
  }

  it('ranks by units then revenue, counts distinct orders and customers', async () => {
    fixture();
    const out = await report('kqm_product_velocity_report', { top: 2 });
    expect(out.products).toEqual([
      { productID: 200, title: 'Beta', units: 10, revenue: 1000, orders: 1, customers: 1 },
      { productID: 100, title: 'Alpha', units: 10, revenue: 100, orders: 2, customers: 2 },
    ]);
    expect(out).toMatchObject({ productsFound: 3, linesScanned: 5, linesWithoutProduct: 1, linesWithoutCustomer: 1, partial: false, callsUsed: 2 });
  });

  it('includeCustomers false skips the sales order calls', async () => {
    fixture();
    const out = await report('kqm_product_velocity_report', { includeCustomers: false });
    expect(client.salesOrders.list).not.toHaveBeenCalled();
    expect(out.callsUsed).toBe(1);
    expect(out.products[0].customers).toBeNull();
    expect(out.linesWithoutCustomer).toBeNull();
  });

  it('pages lines in blocks of 100 and passes modifiedAfter', async () => {
    client.salesOrderLines.list.mockImplementation(async ({ page }: { page: number }) => rows(page === 1 ? 100 : 50, () => ({ productID: 1, quantity: 1, price: 1 })));
    const out = await report('kqm_product_velocity_report', { includeCustomers: false, modifiedAfter: '2026-01-01' });
    expect(out).toMatchObject({ linesScanned: 150, partial: false, callsUsed: 2 });
    expect(client.salesOrderLines.list).toHaveBeenLastCalledWith({ modifiedAfter: '2026-01-01', page: 2, pageSize: 100 });
  });

  it('is partial at the record limit and at maxCalls', async () => {
    client.salesOrderLines.list.mockResolvedValue(rows(100, () => ({ productID: 1, quantity: 1, price: 1 })));
    const limited = await report('kqm_product_velocity_report', { includeCustomers: false, maxLines: 50 });
    expect(limited).toMatchObject({ partial: true, partialReason: PARTIAL_RECORDS, linesScanned: 50 });
    const budget = await report('kqm_product_velocity_report', { includeCustomers: false, maxLines: 10000, maxCalls: 3 });
    expect(budget).toMatchObject({ partial: true, partialReason: PARTIAL_BUDGET(3), linesScanned: 300, callsUsed: 3 });
  });

  it('returns partial when rate limited while mapping customers', async () => {
    client.salesOrders.list.mockRejectedValue(new RateLimitError('x', 1, null));
    client.salesOrderLines.list.mockResolvedValue([{ salesOrderID: 1, productID: 1, quantity: 2, price: 3 }]);
    const out = await report('kqm_product_velocity_report');
    expect(out).toMatchObject({ partial: true, partialReason: PARTIAL_RATE, linesScanned: 1, linesWithoutCustomer: 1 });
    expect(out.products[0]).toMatchObject({ productID: 1, units: 2, revenue: 6, customers: 0 });
  });

  it('reads lines before the customer map, so a small budget still yields units and revenue', async () => {
    client.salesOrderLines.list.mockImplementation(async ({ page }: { page: number }) => rows(page === 1 ? 100 : 20, () => ({ salesOrderID: 1, productID: 1, quantity: 1, price: 1 })));
    const out = await report('kqm_product_velocity_report', { maxCalls: 2 });
    expect(client.salesOrders.list).not.toHaveBeenCalled();
    expect(out).toMatchObject({ partial: true, partialReason: PARTIAL_BUDGET(2), linesScanned: 120, linesWithoutCustomer: 120, callsUsed: 2 });
    expect(out.products[0]).toMatchObject({ units: 120, customers: 0 });
  });

  it('skips the customer map when there are no lines', async () => {
    client.salesOrderLines.list.mockResolvedValue([]);
    const out = await report('kqm_product_velocity_report');
    expect(client.salesOrders.list).not.toHaveBeenCalled();
    expect(out).toMatchObject({ partial: false, callsUsed: 1 });
  });
});

describe('kqm_purchase_vs_sales_reconciliation', () => {
  function fixture() {
    client.salesOrderLines.list.mockResolvedValue([
      { productID: 1, title: 'A', quantity: 5 },
      { productID: 2, title: 'B', quantity: 2 },
      { productID: 3, title: 'C', quantity: 1 },
      { productID: 5, title: 'E', quantity: 4 },
      { title: 'No product', quantity: 1 },
    ]);
    client.purchaseOrders.list.mockResolvedValue([
      { id: 100, salesOrderID: 10 },
      { id: 101, salesOrderID: 10 },
      { id: 102, salesOrderID: 11 },
    ]);
    client.purchaseOrderLines.list.mockImplementation(async ({ purchaseOrderID }: { purchaseOrderID: number }) =>
      purchaseOrderID === 100
        ? [{ productID: 1, quantity: 3, quantityReceived: 3 }, { productID: 4, title: 'D', quantity: 1, quantityReceived: 0 }, { quantity: 9 }]
        : [{ productID: 1, quantity: 2, quantityReceived: 1 }, { productID: 2, quantity: 3, quantityReceived: 3 }, { productID: 5, quantity: 1, quantityReceived: 0 }],
    );
  }

  it('joins sales and purchase lines by product and assigns statuses', async () => {
    fixture();
    const out = await report('kqm_purchase_vs_sales_reconciliation', { salesOrderID: 10 });
    const byId = Object.fromEntries(out.products.map((p: { productID: number }) => [p.productID, p]));
    expect(byId[1]).toEqual({ productID: 1, title: 'A', salesQuantity: 5, purchasedQuantity: 5, receivedQuantity: 4, purchaseOrderIDs: [100, 101], status: 'matched', fullyReceived: false });
    expect(byId[2]).toMatchObject({ salesQuantity: 2, purchasedQuantity: 3, receivedQuantity: 3, status: 'over_purchased', fullyReceived: true });
    expect(byId[3]).toMatchObject({ salesQuantity: 1, purchasedQuantity: 0, purchaseOrderIDs: [], status: 'not_purchased', fullyReceived: null });
    expect(byId[4]).toMatchObject({ salesQuantity: 0, purchasedQuantity: 1, status: 'not_on_sales_order', title: 'D' });
    expect(byId[5]).toMatchObject({ status: 'under_purchased' });
    expect(out.unmatchedLines).toEqual({ salesOrderLines: 1, purchaseOrderLines: 1 });
    expect(out).toMatchObject({ purchaseOrdersScanned: 3, purchaseOrdersMatched: 2, partial: false });
    expect(out.warning).toBeUndefined();
    // sales lines + PO list + 2 matched POs
    expect(out.callsUsed).toBe(4);
    expect(client.purchaseOrderLines.list).not.toHaveBeenCalledWith(expect.objectContaining({ purchaseOrderID: 102 }));
    expect(client.salesOrderLines.list).toHaveBeenCalledWith({ salesOrderID: 10, page: 1, pageSize: 100 });
  });

  it('warns that a purchase order may be missing when the scan stops early', async () => {
    fixture();
    client.purchaseOrders.list.mockResolvedValue(rows(100, (i) => ({ id: 1000 + i, salesOrderID: 99 })));
    const limited = await report('kqm_purchase_vs_sales_reconciliation', { salesOrderID: 10, maxPurchaseOrders: 100 });
    expect(limited).toMatchObject({ partial: true, partialReason: PARTIAL_RECORDS });
    expect(limited.warning).toContain('a purchase order may be missing');
    const budget = await report('kqm_purchase_vs_sales_reconciliation', { salesOrderID: 10, maxCalls: 2 });
    expect(budget).toMatchObject({ partial: true, partialReason: PARTIAL_BUDGET(2) });
    expect(budget.warning).toBeTruthy();
  });

  it('scans purchase orders across pages and passes modifiedAfter', async () => {
    fixture();
    client.purchaseOrders.list.mockImplementation(async ({ page }: { page: number }) =>
      page === 1 ? rows(100, (i) => ({ id: i + 1, salesOrderID: 99 })) : [{ id: 500, salesOrderID: 10 }],
    );
    const out = await report('kqm_purchase_vs_sales_reconciliation', { salesOrderID: 10, modifiedAfter: '2026-01-01' });
    expect(out).toMatchObject({ purchaseOrdersScanned: 101, purchaseOrdersMatched: 1, partial: false });
    expect(client.purchaseOrders.list).toHaveBeenLastCalledWith({ modifiedAfter: '2026-01-01', page: 2, pageSize: 100 });
  });

  it('keeps a partial result when rate limited', async () => {
    fixture();
    client.purchaseOrders.list.mockRejectedValue(new RateLimitError('x', 1, null));
    const out = await report('kqm_purchase_vs_sales_reconciliation', { salesOrderID: 10 });
    expect(out).toMatchObject({ partial: true, partialReason: PARTIAL_RATE });
    expect(out.products).toHaveLength(4);
  });

  it('rejects a bad salesOrderID at the handler', async () => {
    await expect(reportsHandler.handleCall('kqm_purchase_vs_sales_reconciliation', { salesOrderID: '../1' })).rejects.toThrow('Invalid salesOrderID');
    expect(getClient).not.toHaveBeenCalled();
  });
});

describe('get_full tools', () => {
  it('kqm_quote_get_full nests lines under sections', async () => {
    client.quotes.get.mockResolvedValue({ id: 1, title: 'Q' });
    client.quoteSections.list.mockResolvedValue([{ id: 10 }, { id: 11 }]);
    client.quoteLines.list.mockImplementation(async ({ quoteSectionID }: { quoteSectionID: number }) => [{ id: quoteSectionID * 10 }]);
    const out = unwrap(await salesHandler.handleCall('kqm_quote_get_full', { id: 1 }));
    expect(out).toMatchObject({
      quote: { id: 1 },
      sections: [{ id: 10, lines: [{ id: 100 }] }, { id: 11, lines: [{ id: 110 }] }],
      partial: false,
      callsUsed: 4,
    });
    expect(getClient).toHaveBeenCalledWith({ maxRetries: 1 });
  });

  it('kqm_quote_get_full is partial at maxCalls', async () => {
    client.quotes.get.mockResolvedValue({ id: 1 });
    client.quoteSections.list.mockResolvedValue([{ id: 10 }, { id: 11 }]);
    client.quoteLines.list.mockResolvedValue([{ id: 1 }]);
    const out = unwrap(await salesHandler.handleCall('kqm_quote_get_full', { id: 1, maxCalls: 3 }));
    expect(out).toMatchObject({ partial: true, partialReason: PARTIAL_BUDGET(3), callsUsed: 3 });
    expect(out.sections).toHaveLength(2);
    expect(out.sections[1].lines).toEqual([]);
  });

  it('kqm_sales_order_get_full returns order, lines and payments', async () => {
    client.salesOrders.get.mockResolvedValue({ id: 2 });
    client.salesOrderLines.list.mockResolvedValue(rows(100));
    client.salesOrderLines.list.mockResolvedValueOnce(rows(100)).mockResolvedValueOnce(rows(5));
    client.salesOrderPayments.list.mockResolvedValue([{ id: 9, amount: 5 }]);
    const out = unwrap(await salesHandler.handleCall('kqm_sales_order_get_full', { id: 2 }));
    expect(out.salesOrder).toEqual({ id: 2 });
    expect(out.lines).toHaveLength(105);
    expect(out.payments).toEqual([{ id: 9, amount: 5 }]);
    expect(out).toMatchObject({ partial: false, callsUsed: 4 });
  });

  it('kqm_purchase_order_get_full returns order, lines and costs', async () => {
    client.purchaseOrders.get.mockResolvedValue({ id: 3 });
    client.purchaseOrderLines.list.mockResolvedValue([{ id: 1 }]);
    client.purchaseOrderCosts.list.mockResolvedValue([{ id: 2 }]);
    const out = unwrap(await procurementHandler.handleCall('kqm_purchase_order_get_full', { id: 3 }));
    expect(out).toMatchObject({ purchaseOrder: { id: 3 }, lines: [{ id: 1 }], costs: [{ id: 2 }], partial: false, callsUsed: 3 });
  });

  it('rejects a bad id before touching the SDK and propagates not-found', async () => {
    await expect(salesHandler.handleCall('kqm_quote_get_full', { id: '../1' })).rejects.toThrow('Invalid id');
    expect(getClient).not.toHaveBeenCalled();
    client.salesOrders.get.mockRejectedValue(new NotFoundError('x', null));
    await expect(salesHandler.handleCall('kqm_sales_order_get_full', { id: 1 })).rejects.toBeInstanceOf(NotFoundError);
  });
});
