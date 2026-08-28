import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/client.js', () => ({ getClient: vi.fn() }));

import { getClient } from '../utils/client.js';
import { catalogHandler } from '../domains/catalog.js';
import { createMockClient, type MockClient } from './helpers/mock-client.js';

describe('catalog domain handler', () => {
  let client: MockClient;

  beforeEach(() => {
    client = createMockClient();
    vi.mocked(getClient).mockReturnValue(client as any);
  });

  it('kqm_product_list maps filter/pagination args', async () => {
    const fixture = [{ id: 1, manufacturerPartNumber: 'MPN-1' }];
    client.products.list.mockResolvedValue(fixture);

    const result = await catalogHandler.handleCall('kqm_product_list', {
      manufacturerPartNumber: 'MPN-1',
      page: 1,
      pageSize: 20,
      modifiedAfter: '2024-01-01T00:00:00Z',
    });

    expect(client.products.list).toHaveBeenCalledWith({
      manufacturerPartNumber: 'MPN-1',
      page: 1,
      pageSize: 20,
      modifiedAfter: '2024-01-01T00:00:00Z',
    });
    expect(result).toEqual({ content: [{ type: 'text', text: JSON.stringify(fixture, null, 2) }] });
  });

  it('kqm_product_get maps id', async () => {
    const fixture = { id: 1, title: 'Widget' };
    client.products.get.mockResolvedValue(fixture);

    const result = await catalogHandler.handleCall('kqm_product_get', { id: 1 });

    expect(client.products.get).toHaveBeenCalledWith(1);
    expect(result).toEqual({ content: [{ type: 'text', text: JSON.stringify(fixture, null, 2) }] });
  });

  it('kqm_product_image_list maps productID + pagination (no modifiedAfter support)', async () => {
    const fixture = [{ productNumber: 'MPN-1', url: 'https://x/y.png' }];
    client.productImages.list.mockResolvedValue(fixture);

    const result = await catalogHandler.handleCall('kqm_product_image_list', { productID: 1, page: 1, pageSize: 10 });

    expect(client.productImages.list).toHaveBeenCalledWith({ productID: 1, page: 1, pageSize: 10 });
    expect(result).toEqual({ content: [{ type: 'text', text: JSON.stringify(fixture, null, 2) }] });
  });

  it('kqm_category_list calls the API with no params', async () => {
    const fixture = [{ id: 1, name: 'Hardware' }];
    client.categories.list.mockResolvedValue(fixture);

    const result = await catalogHandler.handleCall('kqm_category_list', {});

    expect(client.categories.list).toHaveBeenCalledWith();
    expect(result).toEqual({ content: [{ type: 'text', text: JSON.stringify(fixture, null, 2) }] });
  });

  it('kqm_category_get maps id', async () => {
    const fixture = { id: 1, name: 'Hardware' };
    client.categories.get.mockResolvedValue(fixture);

    const result = await catalogHandler.handleCall('kqm_category_get', { id: 1 });

    expect(client.categories.get).toHaveBeenCalledWith(1);
    expect(result).toEqual({ content: [{ type: 'text', text: JSON.stringify(fixture, null, 2) }] });
  });

  it('kqm_brand_list maps pagination + modifiedAfter (no name filter)', async () => {
    const fixture = [{ id: 1, name: 'Acme' }];
    client.brands.list.mockResolvedValue(fixture);

    const result = await catalogHandler.handleCall('kqm_brand_list', { page: 2, pageSize: 5, modifiedAfter: '2024-01-01T00:00:00Z' });

    expect(client.brands.list).toHaveBeenCalledWith({ page: 2, pageSize: 5, modifiedAfter: '2024-01-01T00:00:00Z' });
    expect(result).toEqual({ content: [{ type: 'text', text: JSON.stringify(fixture, null, 2) }] });
  });

  it('kqm_brand_get maps id', async () => {
    const fixture = { id: 1, name: 'Acme' };
    client.brands.get.mockResolvedValue(fixture);

    const result = await catalogHandler.handleCall('kqm_brand_get', { id: 1 });

    expect(client.brands.get).toHaveBeenCalledWith(1);
    expect(result).toEqual({ content: [{ type: 'text', text: JSON.stringify(fixture, null, 2) }] });
  });

  it('returns isError for an unrecognized tool name', async () => {
    const result = await catalogHandler.handleCall('kqm_bogus_tool', {});
    expect(result).toEqual({ content: [{ type: 'text', text: 'Unknown tool: kqm_bogus_tool' }], isError: true });
  });

  it('propagates a rejected API call rather than swallowing it', async () => {
    client.products.get.mockRejectedValue(new Error('not found'));
    await expect(catalogHandler.handleCall('kqm_product_get', { id: 999 })).rejects.toThrow('not found');
  });
});
