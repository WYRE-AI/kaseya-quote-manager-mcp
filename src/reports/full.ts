import { getClient } from '../utils/client.js';
import { idProp, readOnlyTool } from '../domains/schema.js';
import { okResult, errorResult } from '../render.js';
import { requireId } from '../validate.js';
import type { ExtraTool } from '../domains/entity.js';
import { RunAborted } from './budget.js';
import { REPORT_DEADLINE_MS, Run, type RunContext, isPositiveId, maxCallsProp } from './run.js';

const fullTool = (name: string, what: string, idLabel: string) =>
  readOnlyTool(
    name,
    `Get a ${what}. Read-only. Makes several requests, counted against maxCalls; the result is partial if maxCalls is reached. See docs/REPORTS.md.`,
    { id: idProp(`${idLabel} ID`), maxCalls: maxCallsProp },
    ['id'],
  );

/** What a full-record build returns: the data, and whether each child list was read to its end. */
interface Built {
  data: Record<string, unknown>;
  complete: Record<string, boolean>;
}

const STOPPED_BEFORE_RECORD: Record<'deadline' | 'cancelled', string> = {
  deadline: `Stopped at the ${REPORT_DEADLINE_MS / 1000}-second time limit before the record was read. Try again, or use the matching get tool, such as kqm_quote_get.`,
  cancelled: 'Cancelled before the record was read.',
};

/**
 * Every child list is read page by page. `partial` marks a stop at the call budget, rate limit,
 * time limit or cancel, and `complete` says which child lists were read to their end.
 */
async function readFull(args: Record<string, unknown>, ctx: RunContext, build: (run: Run, id: number) => Promise<Built>) {
  const id = requireId(args.id);
  const run = Run.start(args, ctx);
  try {
    let built: Built;
    try {
      built = await build(run, id);
    } catch (err) {
      if (err instanceof RunAborted) return errorResult(STOPPED_BEFORE_RECORD[err.reason]);
      throw err;
    }
    return okResult({ ...run.envelope(), complete: built.complete, ...built.data });
  } finally {
    run.close();
  }
}

export const quoteFullTool: ExtraTool = {
  tool: fullTool('kqm_quote_get_full', 'quote with its sections and each section\'s lines, nested', 'Quote'),
  run: (args, ctx) =>
    readFull(args, ctx ?? {}, async (run, id) => {
      const client = getClient({ maxRetries: 0 });
      const quote = await run.exec(() => client.quotes.get(id));
      const sections = await run.list((page) => client.quoteSections.list({ quoteID: id, page, pageSize: 100 }));
      const out = [];
      let linesComplete = !sections.partial;
      for (const section of sections.items) {
        const lines = isPositiveId(section.id) ? await run.list((page) => client.quoteLines.list({ quoteSectionID: section.id, page, pageSize: 100 })) : null;
        const complete = lines !== null && !lines.partial;
        if (!complete) linesComplete = false;
        out.push({ ...section, lines: lines?.items ?? [], linesComplete: complete });
      }
      return { data: { quote, sections: out }, complete: { sections: !sections.partial, lines: linesComplete } };
    }),
};

export const salesOrderFullTool: ExtraTool = {
  tool: fullTool('kqm_sales_order_get_full', 'sales order with its lines and payments', 'SalesOrder'),
  run: (args, ctx) =>
    readFull(args, ctx ?? {}, async (run, id) => {
      const client = getClient({ maxRetries: 0 });
      const salesOrder = await run.exec(() => client.salesOrders.get(id));
      const lines = await run.list((page) => client.salesOrderLines.list({ salesOrderID: id, page, pageSize: 100 }));
      const payments = await run.list((page) => client.salesOrderPayments.list({ salesOrderID: id, page, pageSize: 100 }));
      return { data: { salesOrder, lines: lines.items, payments: payments.items }, complete: { lines: !lines.partial, payments: !payments.partial } };
    }),
};

export const purchaseOrderFullTool: ExtraTool = {
  tool: fullTool('kqm_purchase_order_get_full', 'purchase order with its lines and costs', 'PurchaseOrder'),
  run: (args, ctx) =>
    readFull(args, ctx ?? {}, async (run, id) => {
      const client = getClient({ maxRetries: 0 });
      const purchaseOrder = await run.exec(() => client.purchaseOrders.get(id));
      const lines = await run.list((page) => client.purchaseOrderLines.list({ purchaseOrderID: id, page, pageSize: 100 }));
      const costs = await run.list((page) => client.purchaseOrderCosts.list({ purchaseOrderID: id, page, pageSize: 100 }));
      return { data: { purchaseOrder, lines: lines.items, costs: costs.items }, complete: { lines: !lines.partial, costs: !costs.partial } };
    }),
};
