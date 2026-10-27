# Reports

Six read-only report tools (domain `reports`) and three `*_get_full` convenience tools. They
only call `list` and `get` on the Quote Manager API.

## Shared behavior

- **Call budget.** Every report takes `maxCalls` (integer, 1–120, default 60). Each Quote
  Manager request counts as one call, and reports never retry (`maxRetries: 0`), so one call
  is exactly one HTTP attempt. When the budget is spent the report stops, computes
  from what it has, and returns `partial: true` with
  `Stopped at maxCalls (N API calls), so these figures cover only the records read so far. Narrow the request with modifiedAfter or a smaller limit, or raise maxCalls.`
- **Dates.** `modifiedAfter` is strict ISO 8601: `YYYY-MM-DD` or
  `YYYY-MM-DDTHH:MM[:SS[.fff]]` with an optional `Z` or `±HH:MM`. Impossible dates such as
  `2026-02-30` are refused.
- **Record limits.** Each report has a cap on the records it scans (`maxQuotes`,
  `maxOrders`, `maxLines`, `maxPurchaseOrders`). If the cap is reached while more records
  may exist (the last page was full, or the page held more than the cap) the result is
  `partial: true` with
  `Stopped at the record limit (maxQuotes, maxOrders, maxLines or maxPurchaseOrders), so more records may exist. Narrow the request with modifiedAfter or raise that limit.`
- **Rate limit.** If Quote Manager returns 429 mid-run the report keeps what it gathered and
  returns `partial: true` with
  `Stopped early because Quote Manager is rate limiting requests (HTTP 429), so these figures cover only the records read before that. Wait a minute and try again, or narrow the request with modifiedAfter.`
  Any other upstream error fails the call with the usual fixed error message.
- **Time limit and cancel.** A run stops at 75 seconds overall. It also stops when the client
  cancels the request, and does not start another request after that. The SDK cannot cancel a
  request in flight, so the run returns at once and a request already running is left to finish
  unread. The result is `partial: true` with
  `Stopped at the 75-second time limit, so these figures cover only the records read so far. Narrow the request with modifiedAfter or a smaller limit.`
  or
  `Cancelled before it finished, so these figures cover only the records read so far. Run it again for complete figures.`
  When more than one reason applies, the most serious wins: cancelled, then time limit, then
  rate limit, then maxCalls, then the record limit. A `*_get_full` tool that is stopped before
  it has read the main record returns an error instead.
- **Requests.** Sequential, never retried. Every request first takes a slot from a limiter
  shared by all calls with the same API key (60 a minute, sliding window, keyed by a hash of
  the key), so concurrent runs and plain list/get tools cannot exceed it together. Waiting for
  a slot counts against the time limit. Lists are read as 1-based pages of 100; a page with
  fewer than 100 rows ends the list.
- **Output.** Every report returns `partial`, `partialReason` (when partial), `callsUsed` and
  `generatedAt` first, so they survive the 100 KB cut, then its data, counts of what was
  scanned, and `method` (how it was calculated and what is inferred). Money is rounded to 2 decimals at the end; sums keep full precision. A missing
  number counts as 0 and, where it matters, is counted separately.
- **Daily allowance.** Quote Manager allows 10,000 calls a day per key, shared with every
  other integration. Plan accordingly.
- **Untrusted content.** Results are wrapped in the untrusted-content envelope like every
  other tool.

## kqm_pipeline_summary

**Inputs:** `modifiedAfter?`, `maxQuotes` (1–200, default 50), `includeCost` (default false),
`maxCalls`.

**Calls:** `ceil(quotes / 100)` quote pages + 1 section list per quote + 1 line list per
section that counts (sections that are multi-choice and not selected are not read) +, with
`includeCost`, 1 supplier list per distinct product, plus one more call per further 100
supplier links. Pages beyond the first 100 rows of a list add a call each. If the supplier
list for a product is cut short (maxCalls, rate limit, time limit or cancel), its cost is not
used or cached, the quote is left unpriced, and the result is partial.

**Calculation:**
- Quote total = Σ line `price` × `quantity`, over lines that count.
- Lines that do not count: `isOptional` and not `isSelected`; any line in a section with
  `isMultiChoice` and not `isSelected`.
- Pre-tax, pre-discount, excluding delivery.
- `byStatus` groups quotes by the raw numeric `status`, sorted by status:
  `{ status, count, total, cost?, margin? }`. `totals` sums every group.
- `quotesScanned` = quotes listed. `quotesPriced` = quotes whose sections and lines (and, with
  `includeCost`, supplier costs) were fully read. A quote that could not be read within the
  budget is counted in `count` but adds nothing to `total`, and the run is partial.
- With `includeCost`: cost per unit = the lowest `cost` among the product's supplier links
  (first 100 links, one call per product, cached for the run). Line cost = unit cost ×
  `quantity`. Lines with no `productID` or no supplier cost are counted in
  `totals.linesWithoutCost` and add no cost. `margin` = total − cost.

## kqm_quote_conversion_funnel

**Inputs:** `modifiedAfter?`, `maxQuotes` (1–2000, default 500), `useOrderDate` (default
true), `maxCalls`.

**Calls:** `ceil(quotes / 100)` + (with `useOrderDate`) 1 per converted quote.

**Calculation:**
- `byStatus`: counts by raw status code.
- `converted`: `salesOrderId` is a positive number.
- `expiredUnconverted`: not converted and `expiryDate` is before now.
- `conversionRate` = `converted` / `quotesScanned` (4 decimals; null with no quotes).
- `winRate` = converted / (converted + expiredUnconverted) (null when the denominator is 0).
- `averageDaysToClose` = mean of (close date − `createdDate`) in days over converted quotes,
  1 decimal (null with none). Close date is the linked sales order's `orderDate` when it was
  fetched, else the quote's `modifiedDate`. `closeDateSource` counts how many quotes used each.
  A sales order that no longer exists (404) falls back to `modifiedDate`.

## kqm_sales_order_margin_report

**Inputs:** `modifiedAfter?`, `maxOrders` (1–200, default 50), `maxCalls`.

**Calls:** `ceil(orders / 100)` + 1 line list per order.

**Calculation:** per order `revenue` = Σ price × quantity, `cost` = Σ cost × quantity,
`margin` = revenue − cost, `marginPercent` = margin / revenue × 100 (1 decimal; null when
revenue is 0). Price and cost are the line's own values. Pre-tax, pre-discount, excluding
delivery. A line with no `cost` still counts toward revenue, adds 0 cost, and is counted in
`linesMissingCost`, so **margin is overstated** when that count is above 0. Orders whose lines
could not be fully read are left out (`ordersScanned` vs `ordersPriced`). `totals` sums the
priced orders.

## kqm_customer_spend_summary

**Inputs:** `customerID?`, `modifiedAfter?`, `maxOrders` (1–500, default 100), `top` (1–100,
default 25), `maxCalls`.

**Calls:** `ceil(orders / 100)` + for each matching order, 1 line list + 1 payment list.

**Calculation:** Quote Manager has no customer filter on sales orders, so the first
`maxOrders` orders are listed and `customerID` (when given) filters them client-side; only
matching orders have their lines and payments read. Per customer:
`revenue` = Σ line price × quantity + order `deliveryAmount` (pre-tax); `cost` = Σ line cost ×
quantity; `payments` = Σ payment `amount`; `outstandingEstimate` =
max(0, revenue + Σ line `tax` + Σ `deliveryTax` − payments). Customers are sorted by revenue
and cut to `top`; `customersFound` is the number before the cut. Names are not fetched (no
extra calls); use `kqm_customer_get`.

## kqm_product_velocity_report

**Inputs:** `modifiedAfter?`, `maxLines` (1–10000, default 2000), `top` (1–100, default 25),
`includeCustomers` (default true), `maxCalls`.

**Calls:** `ceil(lines / 100)` first, then (with `includeCustomers`) `ceil(orders / 100)` for
the order to customer map (up to 10,000 orders), using only the calls left in `maxCalls`.
Reading lines first means a busy tenant still gets unit and revenue figures; when the map
runs out of calls, `customers` undercounts, `linesWithoutCustomer` says by how much, and the
result is `partial`.

**Calculation:** per `productID`: `units` = Σ quantity, `revenue` = Σ price × quantity,
`orders` = distinct `salesOrderID`, `customers` = distinct customers among the mapped orders
(null when `includeCustomers` is false), `title` = first title seen. Lines without a
`productID` are counted in `linesWithoutProduct`; lines whose order is not in the map in
`linesWithoutCustomer`. Sorted by units, then revenue, descending; cut to `top`.
`productsFound` is the count before the cut.

## kqm_purchase_vs_sales_reconciliation

**Inputs:** `salesOrderID` (required), `modifiedAfter?` (narrows the purchase order scan; purchase orders last changed before it are skipped, so leave it out unless the scan runs out of calls),
`maxPurchaseOrders` (1–2000, default 500), `maxCalls`.

**Calls:** 1 sales order line list + `ceil(purchase orders / 100)` + 1 line list per
purchase order whose `salesOrderID` matches.

**Calculation:** Quote Manager cannot filter purchase orders by sales order, so purchase
orders are scanned and filtered client-side. Lines are joined by `productID`. Per product:
`salesQuantity`, `purchasedQuantity`, `receivedQuantity` (Σ `quantityReceived`),
`purchaseOrderIDs`, and `status`:

| Status | Meaning |
|--------|---------|
| `matched` | purchased = sold |
| `under_purchased` | purchased < sold |
| `over_purchased` | purchased > sold |
| `not_purchased` | on the sales order, no purchase order line |
| `not_on_sales_order` | on a matching purchase order, not on the sales order |

`fullyReceived` = received ≥ purchased (null when nothing was purchased). Lines without a
`productID` cannot be joined and are counted in `unmatchedLines`. When the purchase order scan
stops early (record limit, budget, or rate limit) the result is partial and carries a
`warning`: a purchase order may be missing, so `not_purchased` or `under_purchased` may be wrong.

## Convenience tools

`kqm_quote_get_full` (quote, sections, each section's lines), `kqm_sales_order_get_full`
(order, lines, payments) and `kqm_purchase_order_get_full` (order, lines, costs) take `id` and
`maxCalls` (default 60). Calls: 1 for the record, plus every page of each child list (quotes:
1 section list + 1 line list per section). Same partial semantics; `partial`, `partialReason`,
`callsUsed` and `generatedAt` come first. `complete` then says which child lists were read to
their end: `{ sections, lines }` for a quote (and `linesComplete` on each section),
`{ lines, payments }` for a sales order, `{ lines, costs }` for a purchase order. A flag is
`true` only when that pagination finished.

## Inferred values

Quote Manager does not document these, so treat them as estimates:

- **Quote cost** (`kqm_pipeline_summary` with `includeCost`): quote lines carry no cost, so the
  lowest supplier cost for the product is used. Lines without it add no cost, so margin is
  overstated.
- **Win and loss** (`winRate`): a win is a quote with a linked sales order; a loss is an
  expired quote with none. Status codes are numeric and undocumented, so they are returned
  raw and not interpreted. Open quotes are neither.
- **Close date**: the linked sales order's `orderDate` when fetched, otherwise the quote's
  `modifiedDate`.
- **Outstanding** (`outstandingEstimate`): revenue + tax + delivery tax − payments, with each
  line's `tax` treated as the line's total tax rather than a per-unit amount.
- **Sales order margin**: lines with no cost count as zero cost.
- **Totals** are pre-tax and pre-discount, and exclude delivery, except customer spend, which
  includes `deliveryAmount` in revenue.
