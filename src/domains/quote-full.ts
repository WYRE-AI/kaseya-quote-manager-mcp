/**
 * kqm_quote_full: one quote with all its sections and line items, by quote number or ID.
 *
 * Reading a quote otherwise takes several steps that are easy to get wrong: kqm_quote_get
 * needs the numeric quote ID (not the quote number shown to people, such as "Q-1001"),
 * sections come from kqm_quote_section_list, and line items can only be listed one section
 * at a time with kqm_quote_line_list. This does all of that in one call, sequentially (one
 * request at a time, so it stays inside the API rate limit).
 */

const PAGE_SIZE = 100;
const MAX_PAGES = 20;

type Rec = Record<string, unknown>;

/**
 * The parts of the Quote Manager client that {@link quoteFull} uses: the quote list (to find a
 * quote by its number), the quote get (to read it in full by id), and the section and line lists.
 */
export interface QuoteFullClient {
  quotes: { list: (p: Rec) => Promise<unknown>; get: (id: number) => Promise<unknown> };
  quoteSections: { list: (p: Rec) => Promise<unknown> };
  quoteLines: { list: (p: Rec) => Promise<unknown> };
}

const NAMED_ENTITIES: Record<string, string> = { nbsp: ' ', lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' };

/** Decodes the named entities above and decimal or hex numeric ones (`&#8211;`, `&#x2013;`) in one pass. */
function decodeEntities(text: string): string {
  return text.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const code = hex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return match;
      return code === 0xa0 ? ' ' : String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? match;
  });
}

/** Section titles are stored as HTML; this gives readable text. */
export function htmlToText(html: unknown): string | null {
  if (typeof html !== 'string' || html.trim() === '') return null;
  const stripped = html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(div|p|li|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '');
  const text = decodeEntities(stripped)
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
  return text || null;
}

/** Every page of a list call (page size PAGE_SIZE, at most MAX_PAGES pages). */
async function allPages(list: (p: Rec) => Promise<unknown>, params: Rec): Promise<{ items: Rec[]; truncated: boolean }> {
  const items: Rec[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await list({ ...params, page, pageSize: PAGE_SIZE });
    const batch = Array.isArray(res) ? (res as Rec[]) : [];
    items.push(...batch);
    if (batch.length < PAGE_SIZE) return { items, truncated: false };
  }
  return { items, truncated: true };
}

const LINE_FIELDS = [
  'id', 'lineNumber', 'title', 'description', 'productID', 'productNumber', 'quantity', 'price',
  'tax', 'taxRate', 'discountMethod', 'discountValue', 'isOptional', 'isSelected',
  'isQuantityEditable', 'isRecurring', 'recurringType', 'recurringDuration',
] as const;

function pick(rec: Rec, keys: readonly string[]): Rec {
  const out: Rec = {};
  for (const k of keys) if (k in rec) out[k] = rec[k];
  return out;
}

function byLineNumber(a: Rec, b: Rec): number {
  return (Number(a.lineNumber) || 0) - (Number(b.lineNumber) || 0);
}

/**
 * What {@link quoteFull} returns. `ok: false` covers only invalid arguments, a quote number that
 * matches no quote or several, and an id that returns nothing. A failed vendor call is not turned
 * into `ok: false`: it rejects the promise, so the caller's error handling sees the vendor's own
 * error and status code.
 */
export type QuoteFullResult =
  | { ok: true; value: Rec }
  | { ok: false; error: string };

/**
 * Reads one quote with all its sections and line items.
 *
 * Identifier precedence: a non-empty (trimmed) `quoteNumber` selects the lookup by number, matched
 * case-insensitively, and the match is then read in full by id. `id` is used only when no
 * `quoteNumber` is given.
 *
 * Pagination: every list (the quote-number lookup, the sections, and each section's lines) is read
 * with a page size of 100 and at most 20 pages. When a list reaches that cap, more records may
 * exist, and the result says so in `note` (or, for a failed lookup, in the error).
 *
 * Errors: see {@link QuoteFullResult}. A failed vendor call rejects the returned promise.
 */
export async function quoteFull(
  client: QuoteFullClient,
  args: { quoteNumber?: unknown; id?: unknown }
): Promise<QuoteFullResult> {
  const wantedNumber = typeof args.quoteNumber === 'string' ? args.quoteNumber.trim() : '';
  const wantedId = typeof args.id === 'number' && Number.isInteger(args.id) && args.id > 0 ? args.id : undefined;
  if (!wantedNumber && wantedId === undefined) {
    return { ok: false, error: 'Give quoteNumber (for example "Q-1001") or the numeric quote id.' };
  }

  const notes: string[] = [];
  let quoteId = wantedId as number;
  if (wantedNumber) {
    const lookup = await allPages((p) => client.quotes.list(p), { quoteNumber: wantedNumber });
    const found = lookup.items.filter(
      (q) => typeof q.quoteNumber === 'string' && q.quoteNumber.toLowerCase() === wantedNumber.toLowerCase()
    );
    const capped = lookup.truncated
      ? ` The lookup reached its limit of ${MAX_PAGES * PAGE_SIZE} records, so this may be incomplete.`
      : '';
    if (found.length === 0) {
      return { ok: false, error: `No quote with quote number "${wantedNumber}".${capped}` };
    }
    if (found.length > 1) {
      return { ok: false, error: `${found.length} quotes have quote number "${wantedNumber}"; give the id instead (ids: ${found.map((q) => q.id).join(', ')}).${capped}` };
    }
    if (lookup.truncated) {
      notes.push(`The quote-number lookup reached its limit of ${MAX_PAGES * PAGE_SIZE} records, so another quote with this number may exist.`);
    }
    quoteId = Number(found[0].id);
  }

  // Always read the quote by id: a list row may leave out fields the full record has.
  const res = await client.quotes.get(quoteId);
  if (!res || typeof res !== 'object') return { ok: false, error: `No quote with id ${quoteId}.` };
  const quote = res as Rec;

  const sectionsRes = await allPages((p) => client.quoteSections.list(p), { quoteID: quoteId });
  const sections: Rec[] = [];
  let lineCount = 0;
  let truncated = sectionsRes.truncated;
  for (const s of [...sectionsRes.items].sort(byLineNumber)) {
    const linesRes = await allPages((p) => client.quoteLines.list(p), { quoteSectionID: s.id });
    truncated = truncated || linesRes.truncated;
    const lines = [...linesRes.items].sort(byLineNumber).map((l) => pick(l, LINE_FIELDS));
    lineCount += lines.length;
    sections.push({
      id: s.id,
      lineNumber: s.lineNumber,
      type: s.type,
      title: htmlToText(s.title),
      isMultiChoice: s.isMultiChoice,
      isSelected: s.isSelected,
      lines,
    });
  }
  if (truncated) {
    notes.push(`A section or line list reached the limit of ${MAX_PAGES * PAGE_SIZE} records, so more sections or lines may exist.`);
  }

  return {
    ok: true,
    value: {
      quote,
      sectionCount: sections.length,
      lineCount,
      sections,
      ...(notes.length ? { note: notes.join(' ') } : {}),
    },
  };
}
