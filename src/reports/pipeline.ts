import type { QuoteModel } from '@wyre-technology/node-kaseya-quote-manager';
import { getClient } from '../utils/client.js';
import { intProp, MODIFIED_AFTER, readOnlyTool } from '../domains/schema.js';
import { Run, boolArg, intArg, isPositiveId, maxCallsProp, num, round2, strArg } from './run.js';
import { DEFAULT_MAX_CALLS } from './budget.js';

export const pipelineTool = readOnlyTool(
  'kqm_pipeline_summary',
  'Quote pipeline grouped by raw status code: quote count, total value and (optionally) estimated cost and margin. Read-only. Makes one request per page of quotes, one per quote for sections, one per selected section for lines, plus one per distinct product when includeCost is true. See docs/REPORTS.md.',
  {
    modifiedAfter: MODIFIED_AFTER,
    maxQuotes: intProp('Maximum quotes to scan (default 50)', 1, 200, 50),
    includeCost: { type: 'boolean', default: false, description: 'Estimate cost from the lowest supplier cost per product (one extra request per distinct product)' },
    maxCalls: maxCallsProp,
  },
);

interface Bucket { count: number; total: number; cost: number }

export async function runPipelineSummary(args: Record<string, unknown>) {
  const maxQuotes = intArg(args, 'maxQuotes', 50);
  const includeCost = boolArg(args, 'includeCost', false);
  const modifiedAfter = strArg(args, 'modifiedAfter');
  const run = new Run(intArg(args, 'maxCalls', DEFAULT_MAX_CALLS));
  const client = getClient({ maxRetries: 1 });

  const quotes = (await run.list<QuoteModel>((page) => client.quotes.list({ modifiedAfter, page, pageSize: 100 }), maxQuotes)).items;

  const supplierCost = new Map<number, number | null>();
  /** Lowest supplier cost for a product, null when none, undefined when the run stopped first. */
  const unitCost = async (productID: number): Promise<number | null | undefined> => {
    if (supplierCost.has(productID)) return supplierCost.get(productID);
    const links = await run.one(() => client.productSuppliers.list({ productID, pageSize: 100 }));
    if (!links) return undefined;
    const costs = links.map((l) => l.cost).filter((c): c is number => typeof c === 'number' && Number.isFinite(c));
    const lowest = costs.length ? Math.min(...costs) : null;
    supplierCost.set(productID, lowest);
    return lowest;
  };

  const buckets = new Map<number | null, Bucket>();
  let quotesPriced = 0;
  let linesWithoutCost = 0;

  for (const quote of quotes) {
    const status = typeof quote.status === 'number' ? quote.status : null;
    const bucket = buckets.get(status) ?? { count: 0, total: 0, cost: 0 };
    buckets.set(status, bucket);
    bucket.count++;
    if (run.stopped || !isPositiveId(quote.id)) continue;

    let total = 0;
    let cost = 0;
    let missing = 0;
    let complete = true;
    const sections = await run.list((page) => client.quoteSections.list({ quoteID: quote.id, page, pageSize: 100 }));
    complete = !sections.partial;
    for (const section of sections.items) {
      if (!complete) break;
      if (section.isMultiChoice && !section.isSelected) continue;
      if (!isPositiveId(section.id)) continue;
      const lines = await run.list((page) => client.quoteLines.list({ quoteSectionID: section.id, page, pageSize: 100 }));
      if (lines.partial) { complete = false; break; }
      for (const line of lines.items) {
        if (line.isOptional && !line.isSelected) continue;
        const qty = num(line.quantity);
        total += num(line.price) * qty;
        if (!includeCost) continue;
        const unit = isPositiveId(line.productID) ? await unitCost(line.productID) : null;
        if (unit === undefined) { complete = false; break; }
        if (unit === null) missing++;
        else cost += unit * qty;
      }
      if (!complete) break;
    }
    if (!complete) continue;
    quotesPriced++;
    bucket.total += total;
    bucket.cost += cost;
    linesWithoutCost += missing;
  }

  const rows = [...buckets.entries()]
    .sort(([a], [b]) => (a ?? Number.POSITIVE_INFINITY) - (b ?? Number.POSITIVE_INFINITY))
    .map(([status, b]) => ({
      status,
      count: b.count,
      total: round2(b.total),
      ...(includeCost ? { cost: round2(b.cost), margin: round2(b.total - b.cost) } : {}),
    }));
  const sum = (pick: (b: Bucket) => number) => [...buckets.values()].reduce((s, b) => s + pick(b), 0);
  const totals = {
    count: sum((b) => b.count),
    total: round2(sum((b) => b.total)),
    ...(includeCost ? { cost: round2(sum((b) => b.cost)), margin: round2(sum((b) => b.total - b.cost)), linesWithoutCost } : {}),
  };

  return {
    byStatus: rows,
    totals,
    quotesScanned: quotes.length,
    quotesPriced,
    method:
      'Quote total = sum of line price x quantity, before tax and discounts, excluding delivery. Optional lines that are not selected, and sections that are multi-choice and not selected, are left out. Status is the raw numeric code from Quote Manager. ' +
      (includeCost
        ? 'Cost is INFERRED: quote lines carry no cost, so each line uses the lowest supplier cost for its product; lines without a product or supplier cost are counted in linesWithoutCost and add no cost, so margin is overstated. '
        : '') +
      'Quotes whose lines could not be read within the call budget are counted but not priced.',
    ...run.envelope(),
  };
}
