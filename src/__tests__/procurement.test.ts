import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/client.js', () => ({ getClient: vi.fn() }));

import { getClient } from '../utils/client.js';
import { procurementHandler } from '../domains/procurement.js';
import { createMockClient, type MockClient } from './helpers/mock-client.js';

describe('procurement domain handler', () => {
  let client: MockClient;

  beforeEach(() => {
    client = createMockClient();
    vi.mocked(getClient).mockReturnValue(client as any);
  });

  it('kqm_purchase_order_list maps every filter/pagination arg', async () => {
    const fixture = [{ id: 1, orderNumber: 'PO-1' }];
    client.purchaseOrders.list.mockResolvedValue(fixture);

    const result = await procurementHandler.handleCall('kqm_purchase_order_list', {
      orderNumber: 'PO-1',
      page: 1,
      pageSize: 20,
      modifiedAfter: '2024-01-01T00:00:00Z',
    });

    expect(client.purchaseOrders.list).toHaveBeenCalledWith({
      orderNumber: 'PO-1',
      page: 1,
      pageSize: 20,
      modifiedAfter: '2024-01-01T00:00:00Z',
    });
    expect(result).toEqual({ content: [{ type: 'text', text: JSON.stringify(fixture, null, 2) }] });
  });

  it('kqm_purchase_order_get maps id', async () => {
    const fixture = { id: 1, orderNumber: 'PO-1' };
    client.purchaseOrders.get.mockResolvedValue(fixture);

    const result = await procurementHandler.handleCall('kqm_purchase_order_get', { id: 1 });

    expect(client.purchaseOrders.get).toHaveBeenCalledWith(1);
    expect(result).toEqual({ content: [{ type: 'text', text: JSON.stringify(fixture, null, 2) }] });
  });

  it('kqm_purchase_order_line_list maps purchaseOrderID + filters', async () => {
    const fixture = [{ id: 2, purchaseOrderID: 1 }];
    client.purchaseOrderLines.list.mockResolvedValue(fixture);

    const result = await procurementHandler.handleCall('kqm_purchase_order_line_list', {
      purchaseOrderID: 1,
      page: 1,
      pageSize: 10,
      modifiedAfter: '2024-01-01T00:00:00Z',
    });

    expect(client.purchaseOrderLines.list).toHaveBeenCalledWith({
      purchaseOrderID: 1,
      page: 1,
      pageSize: 10,
      modifiedAfter: '2024-01-01T00:00:00Z',
    });
    expect(result).toEqual({ content: [{ type: 'text', text: JSON.stringify(fixture, null, 2) }] });
  });

  it('kqm_purchase_order_line_get maps id', async () => {
    const fixture = { id: 2, purchaseOrderID: 1 };
    client.purchaseOrderLines.get.mockResolvedValue(fixture);

    const result = await procurementHandler.handleCall('kqm_purchase_order_line_get', { id: 2 });

    expect(client.purchaseOrderLines.get).toHaveBeenCalledWith(2);
    expect(result).toEqual({ content: [{ type: 'text', text: JSON.stringify(fixture, null, 2) }] });
  });

  it('kqm_purchase_order_cost_list maps purchaseOrderID + filters', async () => {
    const fixture = [{ id: 3, purchaseOrderID: 1 }];
    client.purchaseOrderCosts.list.mockResolvedValue(fixture);

    const result = await procurementHandler.handleCall('kqm_purchase_order_cost_list', {
      purchaseOrderID: 1,
      page: 1,
      pageSize: 10,
      modifiedAfter: '2024-01-01T00:00:00Z',
    });

    expect(client.purchaseOrderCosts.list).toHaveBeenCalledWith({
      purchaseOrderID: 1,
      page: 1,
      pageSize: 10,
      modifiedAfter: '2024-01-01T00:00:00Z',
    });
    expect(result).toEqual({ content: [{ type: 'text', text: JSON.stringify(fixture, null, 2) }] });
  });

  it('kqm_purchase_order_cost_get maps id', async () => {
    const fixture = { id: 3, purchaseOrderID: 1 };
    client.purchaseOrderCosts.get.mockResolvedValue(fixture);

    const result = await procurementHandler.handleCall('kqm_purchase_order_cost_get', { id: 3 });

    expect(client.purchaseOrderCosts.get).toHaveBeenCalledWith(3);
    expect(result).toEqual({ content: [{ type: 'text', text: JSON.stringify(fixture, null, 2) }] });
  });

  it('kqm_supplier_list maps pagination + modifiedAfter', async () => {
    const fixture = [{ id: 4, name: 'Ingram Micro' }];
    client.suppliers.list.mockResolvedValue(fixture);

    const result = await procurementHandler.handleCall('kqm_supplier_list', {
      page: 1,
      pageSize: 10,
      modifiedAfter: '2024-01-01T00:00:00Z',
    });

    expect(client.suppliers.list).toHaveBeenCalledWith({ page: 1, pageSize: 10, modifiedAfter: '2024-01-01T00:00:00Z' });
    expect(result).toEqual({ content: [{ type: 'text', text: JSON.stringify(fixture, null, 2) }] });
  });

  it('kqm_supplier_get maps id', async () => {
    const fixture = { id: 4, name: 'Ingram Micro' };
    client.suppliers.get.mockResolvedValue(fixture);

    const result = await procurementHandler.handleCall('kqm_supplier_get', { id: 4 });

    expect(client.suppliers.get).toHaveBeenCalledWith(4);
    expect(result).toEqual({ content: [{ type: 'text', text: JSON.stringify(fixture, null, 2) }] });
  });

  it('kqm_product_supplier_list maps productID + filters', async () => {
    const fixture = [{ id: 5, productID: 10, supplierID: 4 }];
    client.productSuppliers.list.mockResolvedValue(fixture);

    const result = await procurementHandler.handleCall('kqm_product_supplier_list', {
      productID: 10,
      page: 1,
      pageSize: 10,
      modifiedAfter: '2024-01-01T00:00:00Z',
    });

    expect(client.productSuppliers.list).toHaveBeenCalledWith({
      productID: 10,
      page: 1,
      pageSize: 10,
      modifiedAfter: '2024-01-01T00:00:00Z',
    });
    expect(result).toEqual({ content: [{ type: 'text', text: JSON.stringify(fixture, null, 2) }] });
  });

  it('kqm_product_supplier_get maps id', async () => {
    const fixture = { id: 5, productID: 10, supplierID: 4 };
    client.productSuppliers.get.mockResolvedValue(fixture);

    const result = await procurementHandler.handleCall('kqm_product_supplier_get', { id: 5 });

    expect(client.productSuppliers.get).toHaveBeenCalledWith(5);
    expect(result).toEqual({ content: [{ type: 'text', text: JSON.stringify(fixture, null, 2) }] });
  });

  it('returns isError for an unrecognized tool name', async () => {
    const result = await procurementHandler.handleCall('kqm_bogus_tool', {});
    expect(result).toEqual({ content: [{ type: 'text', text: 'Unknown tool: kqm_bogus_tool' }], isError: true });
  });

  it('propagates a rejected API call rather than swallowing it', async () => {
    client.purchaseOrders.get.mockRejectedValue(new Error('rate limited'));
    await expect(procurementHandler.handleCall('kqm_purchase_order_get', { id: 1 })).rejects.toThrow('rate limited');
  });
});
