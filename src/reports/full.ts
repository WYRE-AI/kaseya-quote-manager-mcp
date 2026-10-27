import { getClient } from '../utils/client.js';
import { idProp, readOnlyTool } from '../domains/schema.js';
import { okResult } from '../render.js';
import { requireId } from '../validate.js';
import type { ExtraTool } from '../domains/entity.js';
import { Run, intArg, isPositiveId, maxCallsProp } from './run.js';
import { DEFAULT_MAX_CALLS } from './budget.js';

const fullTool = (name: string, what: string, idLabel: string) =>
  readOnlyTool(
    name,
    `Get a ${what}. Read-only. Convenience tool that makes several requests (counted against maxCalls); the result is partial if maxCalls is reached. See docs/REPORTS.md.`,
    { id: idProp(`${idLabel} ID`), maxCalls: maxCallsProp },
    ['id'],
  );

/** Every child list is read page by page; `partial` marks a stop at the call budget or rate limit. */
async function readFull(args: Record<string, unknown>, build: (run: Run, id: number) => Promise<Record<string, unknown>>) {
  const id = requireId(args.id);
  const run = new Run(intArg(args, 'maxCalls', DEFAULT_MAX_CALLS));
  const body = await build(run, id);
  return okResult({ ...body, ...run.envelope() });
}

export const quoteFullTool: ExtraTool = {
  tool: fullTool('kqm_quote_get_full', 'quote with its sections and each section\'s lines, nested', 'Quote'),
  run: (args) =>
    readFull(args, async (run, id) => {
      const client = getClient({ maxRetries: 1 });
      const quote = await run.budget.call(() => client.quotes.get(id));
      const sections = await run.list((page) => client.quoteSections.list({ quoteID: id, page, pageSize: 100 }));
      const out = [];
      for (const section of sections.items) {
        const lines = isPositiveId(section.id) ? await run.list((page) => client.quoteLines.list({ quoteSectionID: section.id, page, pageSize: 100 })) : null;
        out.push({ ...section, lines: lines?.items ?? [] });
      }
      return { quote, sections: out };
    }),
};

export const salesOrderFullTool: ExtraTool = {
  tool: fullTool('kqm_sales_order_get_full', 'sales order with its lines and payments', 'SalesOrder'),
  run: (args) =>
    readFull(args, async (run, id) => {
      const client = getClient({ maxRetries: 1 });
      const salesOrder = await run.budget.call(() => client.salesOrders.get(id));
      const lines = await run.list((page) => client.salesOrderLines.list({ salesOrderID: id, page, pageSize: 100 }));
      const payments = await run.list((page) => client.salesOrderPayments.list({ salesOrderID: id, page, pageSize: 100 }));
      return { salesOrder, lines: lines.items, payments: payments.items };
    }),
};

export const purchaseOrderFullTool: ExtraTool = {
  tool: fullTool('kqm_purchase_order_get_full', 'purchase order with its lines and costs', 'PurchaseOrder'),
  run: (args) =>
    readFull(args, async (run, id) => {
      const client = getClient({ maxRetries: 1 });
      const purchaseOrder = await run.budget.call(() => client.purchaseOrders.get(id));
      const lines = await run.list((page) => client.purchaseOrderLines.list({ purchaseOrderID: id, page, pageSize: 100 }));
      const costs = await run.list((page) => client.purchaseOrderCosts.list({ purchaseOrderID: id, page, pageSize: 100 }));
      return { purchaseOrder, lines: lines.items, costs: costs.items };
    }),
};
