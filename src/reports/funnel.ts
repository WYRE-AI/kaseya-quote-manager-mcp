import type { QuoteModel } from '@wyre-technology/node-kaseya-quote-manager';
import { getClient } from '../utils/client.js';
import { errorStatus } from '../errors.js';
import { intProp, MODIFIED_AFTER, readOnlyTool } from '../domains/schema.js';
import { Run, boolArg, intArg, isPositiveId, maxCallsProp, round1, round4, strArg } from './run.js';
import { DEFAULT_MAX_CALLS } from './budget.js';

export const funnelTool = readOnlyTool(
  'kqm_quote_conversion_funnel',
  'Measure quote conversion: counts by raw status code, converted quotes (linked sales order), expired unconverted quotes, conversion rate, inferred win rate and average days to close. Read-only. One request per page of quotes, plus one per converted quote with useOrderDate. See docs/REPORTS.md.',
  {
    modifiedAfter: MODIFIED_AFTER,
    maxQuotes: intProp('Maximum quotes to scan (default 500)', 1, 2000, 500),
    useOrderDate: { type: 'boolean', default: true, description: 'Fetch each converted quote\'s sales order to use its order date as the close date (one request per converted quote)' },
    maxCalls: maxCallsProp,
  },
);

const DAY_MS = 86_400_000;

export async function runQuoteConversionFunnel(args: Record<string, unknown>) {
  const maxQuotes = intArg(args, 'maxQuotes', 500);
  const useOrderDate = boolArg(args, 'useOrderDate', true);
  const modifiedAfter = strArg(args, 'modifiedAfter');
  const run = new Run(intArg(args, 'maxCalls', DEFAULT_MAX_CALLS));
  const client = getClient({ maxRetries: 1 });
  const now = Date.now();

  const quotes = (await run.list<QuoteModel>((page) => client.quotes.list({ modifiedAfter, page, pageSize: 100 }), maxQuotes)).items;

  const statusCounts = new Map<number | null, number>();
  let converted = 0;
  let expiredUnconverted = 0;
  let daysSum = 0;
  let daysCount = 0;
  const closeDateSource = { orderDate: 0, modifiedDate: 0 };

  for (const quote of quotes) {
    const status = typeof quote.status === 'number' ? quote.status : null;
    statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1);

    if (!isPositiveId(quote.salesOrderId)) {
      if (quote.expiryDate && Date.parse(quote.expiryDate) < now) expiredUnconverted++;
      continue;
    }
    converted++;

    let closeDate: string | undefined = quote.modifiedDate;
    let source: 'orderDate' | 'modifiedDate' = 'modifiedDate';
    if (useOrderDate) {
      const soId = quote.salesOrderId;
      // A deleted or hidden sales order (404) falls back to the quote's modifiedDate.
      const order = await run.one(async () => {
        try {
          return await client.salesOrders.get(soId);
        } catch (err) {
          if (errorStatus(err) === 404) return null;
          throw err;
        }
      });
      if (order?.orderDate) { closeDate = order.orderDate; source = 'orderDate'; }
    }
    const days = quote.createdDate && closeDate ? (Date.parse(closeDate) - Date.parse(quote.createdDate)) / DAY_MS : NaN;
    if (Number.isFinite(days)) {
      daysSum += days;
      daysCount++;
      closeDateSource[source]++;
    }
  }

  const decided = converted + expiredUnconverted;
  return {
    byStatus: [...statusCounts.entries()]
      .sort(([a], [b]) => (a ?? Number.POSITIVE_INFINITY) - (b ?? Number.POSITIVE_INFINITY))
      .map(([status, count]) => ({ status, count })),
    quotesScanned: quotes.length,
    converted,
    expiredUnconverted,
    conversionRate: quotes.length ? round4(converted / quotes.length) : null,
    winRate: decided ? round4(converted / decided) : null,
    averageDaysToClose: daysCount ? round1(daysSum / daysCount) : null,
    closeDateSource,
    method:
      'Converted = the quote has a linked sales order. Expired unconverted = no linked sales order and expiryDate is in the past. conversionRate = converted / quotesScanned. winRate = converted / (converted + expiredUnconverted) and is INFERRED: Quote Manager status codes are not documented, so wins are linked sales orders and losses are expired, unconverted quotes. Days to close = close date minus quote createdDate, averaged over converted quotes; the close date is the linked sales order orderDate when fetched, otherwise the quote modifiedDate (inferred). Status is the raw numeric code.',
    ...run.envelope(),
  };
}
