import type { PurchaseOrderModel } from '@wyre-ai/node-kaseya-quote-manager';
import { getClient } from '../utils/client.js';
import { idProp, intProp, MODIFIED_AFTER, readOnlyTool } from '../domains/schema.js';
import { Run, type RunContext, intArg, isPositiveId, maxCallsProp, num, strArg } from './run.js';
import { requireId } from '../validate.js';

export const reconciliationTool = readOnlyTool(
  'kqm_purchase_vs_sales_reconciliation',
  'Compare what a sales order sold with what was purchased and received for it, by product. Read-only. Scans purchase orders, since Quote Manager can\'t filter them by sales order: one request per page, one for the sales order lines and one per matching purchase order. See docs/REPORTS.md.',
  {
    salesOrderID: idProp('Sales order to reconcile'),
    modifiedAfter: MODIFIED_AFTER,
    maxPurchaseOrders: intProp('Maximum purchase orders to scan (default 500)', 1, 2000, 500),
    maxCalls: maxCallsProp,
  },
  ['salesOrderID'],
);

type Status = 'matched' | 'under_purchased' | 'over_purchased' | 'not_purchased' | 'not_on_sales_order';
interface Row {
  title?: string;
  onSalesOrder: boolean;
  sold: number;
  purchased: number;
  received: number;
  purchaseOrderIDs: Set<number>;
}

export async function runPurchaseVsSales(args: Record<string, unknown>, ctx: RunContext = {}) {
  const salesOrderID = requireId(args.salesOrderID, 'salesOrderID');
  const run = Run.start(args, ctx);
  try {
    return await purchaseVsSales(run, args, salesOrderID);
  } finally {
    run.close();
  }
}

async function purchaseVsSales(run: Run, args: Record<string, unknown>, salesOrderID: number) {
  const maxPurchaseOrders = intArg(args, 'maxPurchaseOrders', 500);
  const modifiedAfter = strArg(args, 'modifiedAfter');
  const client = getClient({ maxRetries: 0 });

  const rows = new Map<number, Row>();
  const row = (productID: number, title?: string): Row => {
    const r = rows.get(productID) ?? { title, onSalesOrder: false, sold: 0, purchased: 0, received: 0, purchaseOrderIDs: new Set<number>() };
    rows.set(productID, r);
    r.title ??= title;
    return r;
  };

  const soLines = await run.list((page) => client.salesOrderLines.list({ salesOrderID, page, pageSize: 100 }));
  let salesLinesWithoutProduct = 0;
  for (const line of soLines.items) {
    if (!isPositiveId(line.productID)) { salesLinesWithoutProduct++; continue; }
    const r = row(line.productID, line.title);
    r.onSalesOrder = true;
    r.sold += num(line.quantity);
  }

  const scan = await run.list<PurchaseOrderModel>((page) => client.purchaseOrders.list({ modifiedAfter, page, pageSize: 100 }), maxPurchaseOrders);
  const matched = scan.items.filter((po) => po.salesOrderID === salesOrderID);
  let purchaseLinesWithoutProduct = 0;
  let purchaseOrdersRead = 0;
  for (const po of matched) {
    if (run.stopped) break;
    if (!isPositiveId(po.id)) continue;
    const lines = await run.list((page) => client.purchaseOrderLines.list({ purchaseOrderID: po.id, page, pageSize: 100 }));
    for (const line of lines.items) {
      if (!isPositiveId(line.productID)) { purchaseLinesWithoutProduct++; continue; }
      const r = row(line.productID, line.title);
      r.purchased += num(line.quantity);
      r.received += num(line.quantityReceived);
      r.purchaseOrderIDs.add(po.id);
    }
    if (!lines.partial) purchaseOrdersRead++;
  }

  const status = (r: Row): Status =>
    !r.onSalesOrder ? 'not_on_sales_order'
    : r.purchaseOrderIDs.size === 0 ? 'not_purchased'
    : r.purchased === r.sold ? 'matched'
    : r.purchased < r.sold ? 'under_purchased'
    : 'over_purchased';

  const products = [...rows.entries()].map(([productID, r]) => ({
    productID,
    title: r.title ?? null,
    salesQuantity: r.sold,
    purchasedQuantity: r.purchased,
    receivedQuantity: r.received,
    purchaseOrderIDs: [...r.purchaseOrderIDs].sort((a, b) => a - b),
    status: status(r),
    fullyReceived: r.purchaseOrderIDs.size ? r.received >= r.purchased : null,
  }));

  const envelope = run.envelope();
  return {
    ...envelope,
    ...(envelope.partial
      ? { warning: 'Not every record was read, so a purchase order may be missing and not_purchased or under_purchased may be wrong. Raise maxCalls or maxPurchaseOrders and run it again.' }
      : {}),
    salesOrderID,
    products,
    unmatchedLines: { salesOrderLines: salesLinesWithoutProduct, purchaseOrderLines: purchaseLinesWithoutProduct },
    purchaseOrdersScanned: scan.items.length,
    purchaseOrdersMatched: matched.length,
    purchaseOrdersRead,
    method:
      'Products are joined by productID. Sold = sum of sales order line quantity; purchased and received = sums of quantity and quantityReceived on the lines of purchase orders whose salesOrderID matches. Status: matched (purchased = sold), under_purchased, over_purchased, not_purchased (on the sales order, no purchase order line), not_on_sales_order (purchased but not sold). fullyReceived = received >= purchased, null when nothing was purchased. Lines without a productID cannot be joined and are only counted in unmatchedLines. Quote Manager cannot filter purchase orders by sales order, so purchase orders are scanned and filtered client-side.',
  };
}
