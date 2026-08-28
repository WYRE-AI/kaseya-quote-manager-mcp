import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/client.js', () => ({ getClient: vi.fn() }));

import { getClient } from '../utils/client.js';
import { crmHandler } from '../domains/crm.js';
import { createMockClient, type MockClient } from './helpers/mock-client.js';

describe('crm domain handler', () => {
  let client: MockClient;

  beforeEach(() => {
    client = createMockClient();
    vi.mocked(getClient).mockReturnValue(client as any);
  });

  it('kqm_customer_list maps pagination + modifiedAfter (no name/id filter)', async () => {
    const fixture = [{ id: 1, name: 'Acme Corp' }];
    client.customers.list.mockResolvedValue(fixture);

    const result = await crmHandler.handleCall('kqm_customer_list', { page: 1, pageSize: 20, modifiedAfter: '2024-01-01T00:00:00Z' });

    expect(client.customers.list).toHaveBeenCalledWith({ page: 1, pageSize: 20, modifiedAfter: '2024-01-01T00:00:00Z' });
    expect(result).toEqual({ content: [{ type: 'text', text: JSON.stringify(fixture, null, 2) }] });
  });

  it('kqm_customer_get maps id', async () => {
    const fixture = { id: 1, name: 'Acme Corp' };
    client.customers.get.mockResolvedValue(fixture);

    const result = await crmHandler.handleCall('kqm_customer_get', { id: 1 });

    expect(client.customers.get).toHaveBeenCalledWith(1);
    expect(result).toEqual({ content: [{ type: 'text', text: JSON.stringify(fixture, null, 2) }] });
  });

  it('kqm_customer_address_list maps customerID + filters', async () => {
    const fixture = [{ id: 2, customerID: 1 }];
    client.customerAddress.list.mockResolvedValue(fixture);

    const result = await crmHandler.handleCall('kqm_customer_address_list', {
      customerID: 1,
      page: 1,
      pageSize: 10,
      modifiedAfter: '2024-01-01T00:00:00Z',
    });

    expect(client.customerAddress.list).toHaveBeenCalledWith({
      customerID: 1,
      page: 1,
      pageSize: 10,
      modifiedAfter: '2024-01-01T00:00:00Z',
    });
    expect(result).toEqual({ content: [{ type: 'text', text: JSON.stringify(fixture, null, 2) }] });
  });

  it('kqm_customer_address_get maps id', async () => {
    const fixture = { id: 2, customerID: 1 };
    client.customerAddress.get.mockResolvedValue(fixture);

    const result = await crmHandler.handleCall('kqm_customer_address_get', { id: 2 });

    expect(client.customerAddress.get).toHaveBeenCalledWith(2);
    expect(result).toEqual({ content: [{ type: 'text', text: JSON.stringify(fixture, null, 2) }] });
  });

  it('kqm_contact_list maps customerID + filters', async () => {
    const fixture = [{ id: 3, customerID: 1 }];
    client.contacts.list.mockResolvedValue(fixture);

    const result = await crmHandler.handleCall('kqm_contact_list', {
      customerID: 1,
      page: 1,
      pageSize: 10,
      modifiedAfter: '2024-01-01T00:00:00Z',
    });

    expect(client.contacts.list).toHaveBeenCalledWith({
      customerID: 1,
      page: 1,
      pageSize: 10,
      modifiedAfter: '2024-01-01T00:00:00Z',
    });
    expect(result).toEqual({ content: [{ type: 'text', text: JSON.stringify(fixture, null, 2) }] });
  });

  it('kqm_contact_get maps id', async () => {
    const fixture = { id: 3, customerID: 1 };
    client.contacts.get.mockResolvedValue(fixture);

    const result = await crmHandler.handleCall('kqm_contact_get', { id: 3 });

    expect(client.contacts.get).toHaveBeenCalledWith(3);
    expect(result).toEqual({ content: [{ type: 'text', text: JSON.stringify(fixture, null, 2) }] });
  });

  it('returns isError for an unrecognized tool name', async () => {
    const result = await crmHandler.handleCall('kqm_bogus_tool', {});
    expect(result).toEqual({ content: [{ type: 'text', text: 'Unknown tool: kqm_bogus_tool' }], isError: true });
  });

  it('propagates a rejected API call rather than swallowing it', async () => {
    client.customers.get.mockRejectedValue(new Error('forbidden'));
    await expect(crmHandler.handleCall('kqm_customer_get', { id: 1 })).rejects.toThrow('forbidden');
  });
});
