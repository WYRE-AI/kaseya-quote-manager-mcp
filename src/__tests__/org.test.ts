import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/client.js', () => ({ getClient: vi.fn(), getCredentials: vi.fn(() => ({ apiKey: 'k' })) }));

import { getClient } from '../utils/client.js';
import { orgHandler } from '../domains/org.js';
import { createMockClient, type MockClient } from './helpers/mock-client.js';
import { unwrap } from './helpers/unwrap.js';
import { UNKNOWN_TOOL_MESSAGE } from '../errors.js';

describe('org domain handler', () => {
  let client: MockClient;

  beforeEach(() => {
    client = createMockClient();
    vi.mocked(getClient).mockReturnValue(client as any);
  });

  it('kqm_employee_list maps pagination only (no modifiedAfter support)', async () => {
    const fixture = [{ id: 1, firstName: 'Jane' }];
    client.employees.list.mockResolvedValue(fixture);

    const result = await orgHandler.handleCall('kqm_employee_list', { page: 1, pageSize: 20 });

    expect(client.employees.list).toHaveBeenCalledWith({ page: 1, pageSize: 20 });
    expect(unwrap(result)).toEqual(fixture);
  });

  it('kqm_employee_get maps id', async () => {
    const fixture = { id: 1, firstName: 'Jane' };
    client.employees.get.mockResolvedValue(fixture);

    const result = await orgHandler.handleCall('kqm_employee_get', { id: 1 });

    expect(client.employees.get).toHaveBeenCalledWith(1);
    expect(unwrap(result)).toEqual(fixture);
  });

  it('kqm_warehouse_list maps pagination + modifiedAfter', async () => {
    const fixture = [{ id: 1, name: 'Main DC' }];
    client.warehouses.list.mockResolvedValue(fixture);

    const result = await orgHandler.handleCall('kqm_warehouse_list', { page: 1, pageSize: 20, modifiedAfter: '2024-01-01T00:00:00Z' });

    expect(client.warehouses.list).toHaveBeenCalledWith({ page: 1, pageSize: 20, modifiedAfter: '2024-01-01T00:00:00Z' });
    expect(unwrap(result)).toEqual(fixture);
  });

  it('kqm_warehouse_get maps id', async () => {
    const fixture = { id: 1, name: 'Main DC' };
    client.warehouses.get.mockResolvedValue(fixture);

    const result = await orgHandler.handleCall('kqm_warehouse_get', { id: 1 });

    expect(client.warehouses.get).toHaveBeenCalledWith(1);
    expect(unwrap(result)).toEqual(fixture);
  });

  it('returns isError for an unrecognized tool name', async () => {
    const result = await orgHandler.handleCall('kqm_bogus_tool', {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(UNKNOWN_TOOL_MESSAGE);
  });

  it('propagates a rejected API call rather than swallowing it', async () => {
    client.warehouses.get.mockRejectedValue(new Error('timeout'));
    await expect(orgHandler.handleCall('kqm_warehouse_get', { id: 1 })).rejects.toThrow('timeout');
  });
});
