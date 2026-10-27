import type { SalesOrderLineModel, SalesOrderModel } from '@wyre-ai/node-kaseya-quote-manager';
import { getClient } from '../utils/client.js';
import { intProp, MODIFIED_AFTER, readOnlyTool } from '../domains/schema.js';
import { Run, type RunContext, boolArg, intArg, isPositiveId, maxCallsProp, num, round2, strArg } from './run.js';

export const velocityTool = readOnlyTool(
  'kqm_product_velocity_report',
  'Rank best-selling products by units and revenue across sales order lines. Read-only. One request per 100 sales order lines, then, with includeCustomers, one per 100 sales orders from the calls left in maxCalls. See docs/REPORTS.md.',
  {
    modifiedAfter: MODIFIED_AFTER,
    maxLines: intProp('Maximum sales order lines to scan (default 2000)', 1, 10000, 2000),
    top: intProp('Number of products to return (default 25)', 1, 100, 25),
    includeCustomers: { type: 'boolean', default: true, description: 'Count distinct customers per product (pages sales orders first to map each order to its customer)' },
    maxCalls: maxCallsProp,
  },
);

/** Upper bound on sales orders read to map order -> customer. */
const MAX_ORDERS_FOR_CUSTOMERS = 10_000;

interface Velocity { title?: string; units: number; revenue: number; orders: Set<number>; customers: Set<number> }

export async function runProductVelocity(args: Record<string, unknown>, ctx: RunContext = {}) {
  const run = Run.start(args, ctx);
  try {
    return await productVelocity(run, args);
  } finally {
    run.close();
  }
}

async function productVelocity(run: Run, args: Record<string, unknown>) {
  const maxLines = intArg(args, 'maxLines', 2000);
  const top = intArg(args, 'top', 25);
  const includeCustomers = boolArg(args, 'includeCustomers', true);
  const modifiedAfter = strArg(args, 'modifiedAfter');
  const client = getClient({ maxRetries: 0 });

  // Lines first, so the order -> customer map only uses the budget that is left.
  const lines = (await run.list<SalesOrderLineModel>((page) => client.salesOrderLines.list({ modifiedAfter, page, pageSize: 100 }), maxLines)).items;

  const customerOf = new Map<number, number>();
  if (includeCustomers && lines.length) {
    const orders = await run.list<SalesOrderModel>((page) => client.salesOrders.list({ modifiedAfter, page, pageSize: 100 }), MAX_ORDERS_FOR_CUSTOMERS);
    for (const o of orders.items) if (isPositiveId(o.id) && isPositiveId(o.customerID)) customerOf.set(o.id, o.customerID);
  }

  const products = new Map<number, Velocity>();
  let linesWithoutProduct = 0;
  let linesWithoutCustomer = 0;
  for (const line of lines) {
    const customerID = isPositiveId(line.salesOrderID) ? customerOf.get(line.salesOrderID) : undefined;
    if (includeCustomers && customerID === undefined) linesWithoutCustomer++;
    if (!isPositiveId(line.productID)) { linesWithoutProduct++; continue; }
    const p = products.get(line.productID) ?? { title: line.title, units: 0, revenue: 0, orders: new Set<number>(), customers: new Set<number>() };
    products.set(line.productID, p);
    p.title ??= line.title;
    const qty = num(line.quantity);
    p.units += qty;
    p.revenue += num(line.price) * qty;
    if (isPositiveId(line.salesOrderID)) p.orders.add(line.salesOrderID);
    if (customerID !== undefined) p.customers.add(customerID);
  }

  const ranked = [...products.entries()]
    .sort(([, a], [, b]) => b.units - a.units || b.revenue - a.revenue)
    .slice(0, top)
    .map(([productID, p]) => ({
      productID,
      title: p.title ?? null,
      units: p.units,
      revenue: round2(p.revenue),
      orders: p.orders.size,
      customers: includeCustomers ? p.customers.size : null,
    }));

  return {
    ...run.envelope(),
    products: ranked,
    productsFound: products.size,
    linesScanned: lines.length,
    linesWithoutProduct,
    linesWithoutCustomer: includeCustomers ? linesWithoutCustomer : null,
    method:
      'Units = sum of line quantity; revenue = sum of line price x quantity, before tax and discounts. Orders and customers are distinct counts. Customers come from the order of each line. Sales orders are read after the lines, with the calls left over, so lines whose order was not read (counted in linesWithoutCustomer) add no customer. Products are ranked by units, then revenue; the title is the first one seen.',
  };
}
