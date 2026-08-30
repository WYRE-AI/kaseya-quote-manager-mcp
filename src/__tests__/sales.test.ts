import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/client.js', () => ({ getClient: vi.fn() }));

import { getClient } from '../utils/client.js';
import { salesHandler } from '../domains/sales.js';
import { createMockClient, type MockClient } from './helpers/mock-client.js';

describe('sales domain handler', () => {
  let client: MockClient;

  beforeEach(() => {
    client = createMockClient();
    vi.mocked(getClient).mockReturnValue(client as any);
  });

  it('kqm_quote_list maps every filter/pagination arg and returns the raw response as formatted JSON', async () => {
    const fixture = [{ id: 1, quoteNumber: 'Q-100' }];
    client.quotes.list.mockResolvedValue(fixture);

    const result = await salesHandler.handleCall('kqm_quote_list', {
      quoteNumber: 'Q-100',
      page: 2,
      pageSize: 50,
      modifiedAfter: '2024-01-01T00:00:00Z',
    });

    expect(client.quotes.list).toHaveBeenCalledWith({
      quoteNumber: 'Q-100',
      page: 2,
      pageSize: 50,
      modifiedAfter: '2024-01-01T00:00:00Z',
    });
    expect(result).toEqual({ content: [{ type: 'text', text: JSON.stringify(fixture, null, 2) }] });
  });

  it('kqm_quote_list omits unset filters (passes undefined, not defaults)', async () => {
    client.quotes.list.mockResolvedValue([]);
    await salesHandler.handleCall('kqm_quote_list', {});
    expect(client.quotes.list).toHaveBeenCalledWith({
      quoteNumber: undefined,
      page: undefined,
      pageSize: undefined,
      modifiedAfter: undefined,
    });
  });

  it('kqm_quote_get maps id and returns the raw response', async () => {
    const fixture = { id: 42, quoteNumber: 'Q-42' };
    client.quotes.get.mockResolvedValue(fixture);

    const result = await salesHandler.handleCall('kqm_quote_get', { id: 42 });

    expect(client.quotes.get).toHaveBeenCalledWith(42);
    expect(result).toEqual({ content: [{ type: 'text', text: JSON.stringify(fixture, null, 2) }] });
  });

  it('kqm_quote_section_list maps quoteID + pagination', async () => {
    const fixture = [{ id: 5, quoteID: 42 }];
    client.quoteSections.list.mockResolvedValue(fixture);

    const result = await salesHandler.handleCall('kqm_quote_section_list', { quoteID: 42, page: 1, pageSize: 10 });

    expect(client.quoteSections.list).toHaveBeenCalledWith({ quoteID: 42, page: 1, pageSize: 10 });
    expect(result).toEqual({ content: [{ type: 'text', text: JSON.stringify(fixture, null, 2) }] });
  });

  it('kqm_quote_section_get maps id', async () => {
    const fixture = { id: 5, quoteID: 42 };
    client.quoteSections.get.mockResolvedValue(fixture);

    const result = await salesHandler.handleCall('kqm_quote_section_get', { id: 5 });

    expect(client.quoteSections.get).toHaveBeenCalledWith(5);
    expect(result).toEqual({ content: [{ type: 'text', text: JSON.stringify(fixture, null, 2) }] });
  });

  it('kqm_quote_line_list maps quoteSectionID + pagination', async () => {
    const fixture = [{ id: 9, quoteSectionID: 5 }];
    client.quoteLines.list.mockResolvedValue(fixture);

    const result = await salesHandler.handleCall('kqm_quote_line_list', { quoteSectionID: 5, page: 1, pageSize: 10 });

    expect(client.quoteLines.list).toHaveBeenCalledWith({ quoteSectionID: 5, page: 1, pageSize: 10 });
    expect(result).toEqual({ content: [{ type: 'text', text: JSON.stringify(fixture, null, 2) }] });
  });

  it('kqm_quote_line_get maps id', async () => {
    const fixture = { id: 9, quoteSectionID: 5 };
    client.quoteLines.get.mockResolvedValue(fixture);

    const result = await salesHandler.handleCall('kqm_quote_line_get', { id: 9 });

    expect(client.quoteLines.get).toHaveBeenCalledWith(9);
    expect(result).toEqual({ content: [{ type: 'text', text: JSON.stringify(fixture, null, 2) }] });
  });

  it('kqm_sales_order_list maps every filter/pagination arg', async () => {
    const fixture = [{ id: 1, orderNumber: 'SO-1' }];
    client.salesOrders.list.mockResolvedValue(fixture);

    const result = await salesHandler.handleCall('kqm_sales_order_list', {
      orderNumber: 'SO-1',
      page: 3,
      pageSize: 25,
      modifiedAfter: '2024-06-01T00:00:00Z',
    });

    expect(client.salesOrders.list).toHaveBeenCalledWith({
      orderNumber: 'SO-1',
      page: 3,
      pageSize: 25,
      modifiedAfter: '2024-06-01T00:00:00Z',
    });
    expect(result).toEqual({ content: [{ type: 'text', text: JSON.stringify(fixture, null, 2) }] });
  });

  it('kqm_sales_order_get maps id', async () => {
    const fixture = { id: 7, orderNumber: 'SO-7' };
    client.salesOrders.get.mockResolvedValue(fixture);

    const result = await salesHandler.handleCall('kqm_sales_order_get', { id: 7 });

    expect(client.salesOrders.get).toHaveBeenCalledWith(7);
    expect(result).toEqual({ content: [{ type: 'text', text: JSON.stringify(fixture, null, 2) }] });
  });

  it('kqm_sales_order_line_list maps salesOrderID + filters', async () => {
    const fixture = [{ id: 11, salesOrderID: 7 }];
    client.salesOrderLines.list.mockResolvedValue(fixture);

    const result = await salesHandler.handleCall('kqm_sales_order_line_list', {
      salesOrderID: 7,
      page: 1,
      pageSize: 10,
      modifiedAfter: '2024-06-01T00:00:00Z',
    });

    expect(client.salesOrderLines.list).toHaveBeenCalledWith({
      salesOrderID: 7,
      page: 1,
      pageSize: 10,
      modifiedAfter: '2024-06-01T00:00:00Z',
    });
    expect(result).toEqual({ content: [{ type: 'text', text: JSON.stringify(fixture, null, 2) }] });
  });

  it('kqm_sales_order_line_get maps id', async () => {
    const fixture = { id: 11, salesOrderID: 7 };
    client.salesOrderLines.get.mockResolvedValue(fixture);

    const result = await salesHandler.handleCall('kqm_sales_order_line_get', { id: 11 });

    expect(client.salesOrderLines.get).toHaveBeenCalledWith(11);
    expect(result).toEqual({ content: [{ type: 'text', text: JSON.stringify(fixture, null, 2) }] });
  });

  it('kqm_sales_order_payment_list maps salesOrderID + filters', async () => {
    const fixture = [{ id: 21, salesOrderID: 7 }];
    client.salesOrderPayments.list.mockResolvedValue(fixture);

    const result = await salesHandler.handleCall('kqm_sales_order_payment_list', {
      salesOrderID: 7,
      page: 1,
      pageSize: 10,
      modifiedAfter: '2024-06-01T00:00:00Z',
    });

    expect(client.salesOrderPayments.list).toHaveBeenCalledWith({
      salesOrderID: 7,
      page: 1,
      pageSize: 10,
      modifiedAfter: '2024-06-01T00:00:00Z',
    });
    expect(result).toEqual({ content: [{ type: 'text', text: JSON.stringify(fixture, null, 2) }] });
  });

  it('kqm_sales_order_payment_get maps id', async () => {
    const fixture = { id: 21, salesOrderID: 7 };
    client.salesOrderPayments.get.mockResolvedValue(fixture);

    const result = await salesHandler.handleCall('kqm_sales_order_payment_get', { id: 21 });

    expect(client.salesOrderPayments.get).toHaveBeenCalledWith(21);
    expect(result).toEqual({ content: [{ type: 'text', text: JSON.stringify(fixture, null, 2) }] });
  });

  it('returns isError for an unrecognized tool name (without ever touching the client resources)', async () => {
    const result = await salesHandler.handleCall('kqm_bogus_tool', {});
    expect(result).toEqual({ content: [{ type: 'text', text: 'Unknown tool: kqm_bogus_tool' }], isError: true });
  });

  it('propagates a rejected API call rather than swallowing it', async () => {
    client.quotes.get.mockRejectedValue(new Error('upstream 500'));
    await expect(salesHandler.handleCall('kqm_quote_get', { id: 1 })).rejects.toThrow('upstream 500');
  });
});
