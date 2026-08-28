import { vi } from 'vitest';

/**
 * Every resource on KaseyaQuoteManagerClient exposes the same `list`/`get`
 * shape. Domain handlers call `getClient()` (mocked in each test file via
 * `vi.mock('../utils/client.js')`) and then invoke a resource method
 * directly, so a single generic fake covering every resource name lets each
 * domain test stub only the calls it exercises.
 */
const RESOURCE_NAMES = [
  'brands',
  'categories',
  'contacts',
  'customers',
  'customerAddress',
  'employees',
  'products',
  'productImages',
  'productSuppliers',
  'purchaseOrders',
  'purchaseOrderCosts',
  'purchaseOrderLines',
  'quotes',
  'quoteLines',
  'quoteSections',
  'salesOrders',
  'salesOrderLines',
  'salesOrderPayments',
  'suppliers',
  'warehouses',
] as const;

export type MockResourceName = (typeof RESOURCE_NAMES)[number];

export type MockClient = {
  [K in MockResourceName]: {
    list: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
  };
};

export function createMockClient(): MockClient {
  const client = {} as MockClient;
  for (const name of RESOURCE_NAMES) {
    client[name] = { list: vi.fn(), get: vi.fn() };
  }
  return client;
}
