import type { SalesOrderModel } from '@wyre-technology/node-kaseya-quote-manager';
import { getClient } from '../utils/client.js';
import { idProp, intProp, MODIFIED_AFTER, readOnlyTool } from '../domains/schema.js';
import { Run, intArg, isPositiveId, maxCallsProp, num, round2, strArg } from './run.js';
import { DEFAULT_MAX_CALLS } from './budget.js';

export const spendTool = readOnlyTool(
  'kqm_customer_spend_summary',
  'Summarize revenue, cost, payments and estimated outstanding balance per customer, ranked by revenue. Read-only. One request per page of sales orders plus two per matching sales order (lines and payments). Names aren\'t included; use kqm_customer_get. See docs/REPORTS.md.',
  {
    customerID: idProp('Only include this customer (filtered client-side from the scanned orders)'),
    modifiedAfter: MODIFIED_AFTER,
    maxOrders: intProp('Maximum sales orders to scan (default 100)', 1, 500, 100),
    top: intProp('Number of customers to return (default 25)', 1, 100, 25),
    maxCalls: maxCallsProp,
  },
);

interface Spend { orders: number; revenue: number; cost: number; payments: number; tax: number }

export async function runCustomerSpend(args: Record<string, unknown>) {
  const maxOrders = intArg(args, 'maxOrders', 100);
  const top = intArg(args, 'top', 25);
  const customerID = typeof args.customerID === 'number' ? args.customerID : undefined;
  const modifiedAfter = strArg(args, 'modifiedAfter');
  const run = new Run(intArg(args, 'maxCalls', DEFAULT_MAX_CALLS));
  const client = getClient({ maxRetries: 1 });

  const scanned = (await run.list<SalesOrderModel>((page) => client.salesOrders.list({ modifiedAfter, page, pageSize: 100 }), maxOrders)).items;
  const matched = customerID === undefined ? scanned : scanned.filter((o) => o.customerID === customerID);

  const byCustomer = new Map<number | null, Spend>();
  let ordersPriced = 0;
  for (const order of matched) {
    if (run.stopped) break;
    if (!isPositiveId(order.id)) continue;
    const lines = await run.list((page) => client.salesOrderLines.list({ salesOrderID: order.id, page, pageSize: 100 }));
    if (lines.partial) break;
    const payments = await run.list((page) => client.salesOrderPayments.list({ salesOrderID: order.id, page, pageSize: 100 }));
    if (payments.partial) break;

    const key = isPositiveId(order.customerID) ? order.customerID : null;
    const spend = byCustomer.get(key) ?? { orders: 0, revenue: 0, cost: 0, payments: 0, tax: 0 };
    byCustomer.set(key, spend);
    spend.orders++;
    spend.revenue += num(order.deliveryAmount);
    spend.tax += num(order.deliveryTax);
    for (const line of lines.items) {
      const qty = num(line.quantity);
      spend.revenue += num(line.price) * qty;
      spend.cost += num(line.cost) * qty;
      spend.tax += num(line.tax);
    }
    for (const p of payments.items) spend.payments += num(p.amount);
    ordersPriced++;
  }

  const customers = [...byCustomer.entries()]
    .map(([id, s]) => ({
      customerID: id,
      orders: s.orders,
      revenue: round2(s.revenue),
      cost: round2(s.cost),
      payments: round2(s.payments),
      outstandingEstimate: round2(Math.max(0, s.revenue + s.tax - s.payments)),
      _revenue: s.revenue,
    }))
    .sort((a, b) => b._revenue - a._revenue)
    .slice(0, top)
    .map(({ _revenue, ...rest }) => rest);

  return {
    customers,
    customersFound: byCustomer.size,
    ordersScanned: scanned.length,
    ordersMatched: matched.length,
    ordersPriced,
    method:
      'Revenue = sum of line price x quantity + order deliveryAmount, before tax. Cost = sum of line cost x quantity (missing cost counts as 0, so cost can be understated). Payments = sum of payment amounts. outstandingEstimate = max(0, revenue + line tax + deliveryTax - payments) per customer and is INFERRED: each line\'s tax is treated as the line\'s total tax, not a per-unit amount. Quote Manager has no customer filter on sales orders, so customerID filters the scanned orders client-side. Customers are ranked by revenue; names are not fetched, use kqm_customer_get. Sales orders whose lines or payments could not be read are left out (see ordersPriced).',
    ...run.envelope(),
  };
}
