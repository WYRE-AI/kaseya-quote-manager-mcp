import type { SalesOrderModel } from '@wyre-technology/node-kaseya-quote-manager';
import { getClient } from '../utils/client.js';
import { intProp, MODIFIED_AFTER, readOnlyTool } from '../domains/schema.js';
import { Run, intArg, isPositiveId, maxCallsProp, num, round1, round2, strArg } from './run.js';
import { DEFAULT_MAX_CALLS } from './budget.js';

export const marginTool = readOnlyTool(
  'kqm_sales_order_margin_report',
  'Report revenue, cost and margin per sales order, from each sales order line\'s own price and cost. Read-only. One request per page of sales orders plus one per sales order for its lines. See docs/REPORTS.md.',
  {
    modifiedAfter: MODIFIED_AFTER,
    maxOrders: intProp('Maximum sales orders to scan (default 50)', 1, 200, 50),
    maxCalls: maxCallsProp,
  },
);

export async function runSalesOrderMargin(args: Record<string, unknown>) {
  const maxOrders = intArg(args, 'maxOrders', 50);
  const modifiedAfter = strArg(args, 'modifiedAfter');
  const run = new Run(intArg(args, 'maxCalls', DEFAULT_MAX_CALLS));
  const client = getClient({ maxRetries: 1 });

  const orders = (await run.list<SalesOrderModel>((page) => client.salesOrders.list({ modifiedAfter, page, pageSize: 100 }), maxOrders)).items;

  const rows = [];
  const totals = { revenue: 0, cost: 0, lines: 0, linesMissingCost: 0 };
  for (const order of orders) {
    if (run.stopped) break;
    if (!isPositiveId(order.id)) continue;
    const lines = await run.list((page) => client.salesOrderLines.list({ salesOrderID: order.id, page, pageSize: 100 }));
    if (lines.partial) break;
    let revenue = 0;
    let cost = 0;
    let missing = 0;
    for (const line of lines.items) {
      const qty = num(line.quantity);
      revenue += num(line.price) * qty;
      if (typeof line.cost === 'number') cost += line.cost * qty;
      else missing++;
    }
    rows.push({
      salesOrderID: order.id,
      orderNumber: order.orderNumber ?? null,
      customerID: order.customerID ?? null,
      orderDate: order.orderDate ?? null,
      revenue: round2(revenue),
      cost: round2(cost),
      margin: round2(revenue - cost),
      marginPercent: revenue ? round1(((revenue - cost) / revenue) * 100) : null,
      lines: lines.items.length,
      linesMissingCost: missing,
    });
    totals.revenue += revenue;
    totals.cost += cost;
    totals.lines += lines.items.length;
    totals.linesMissingCost += missing;
  }

  return {
    orders: rows,
    totals: {
      revenue: round2(totals.revenue),
      cost: round2(totals.cost),
      margin: round2(totals.revenue - totals.cost),
      marginPercent: totals.revenue ? round1(((totals.revenue - totals.cost) / totals.revenue) * 100) : null,
      lines: totals.lines,
      linesMissingCost: totals.linesMissingCost,
    },
    ordersScanned: orders.length,
    ordersPriced: rows.length,
    method:
      'Revenue = sum of line price x quantity; cost = sum of line cost x quantity; margin = revenue - cost. All figures are before tax and discounts and exclude delivery. Lines with no cost still count toward revenue, add 0 cost and are counted in linesMissingCost, so margin is overstated when linesMissingCost > 0. Sales orders whose lines could not be read before the call budget ran out or Quote Manager rate limited requests are left out (see ordersPriced).',
    ...run.envelope(),
  };
}
