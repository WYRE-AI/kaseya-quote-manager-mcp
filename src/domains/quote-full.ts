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

export interface QuoteFullClient {
  quotes: { list: (p: Rec) => Promise<unknown>; get: (id: number) => Promise<unknown> };
  quoteSections: { list: (p: Rec) => Promise<unknown> };
  quoteLines: { list: (p: Rec) => Promise<unknown> };
}

/** Section titles are stored as HTML; this gives readable text. */
export function htmlToText(html: unknown): string | null {
  if (typeof html !== 'string' || html.trim() === '') return null;
  const text = html
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(div|p|li|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
  return text || null;
}

/** Every page of a list call (page size 100, at most MAX_PAGES pages). */
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

export type QuoteFullResult =
  | { ok: true; value: Rec }
  | { ok: false; error: string };

export async function quoteFull(
  client: QuoteFullClient,
  args: { quoteNumber?: unknown; id?: unknown }
): Promise<QuoteFullResult> {
  const wantedNumber = typeof args.quoteNumber === 'string' ? args.quoteNumber.trim() : '';
  const wantedId = typeof args.id === 'number' && Number.isInteger(args.id) && args.id > 0 ? args.id : undefined;
  if (!wantedNumber && wantedId === undefined) {
    return { ok: false, error: 'Give quoteNumber (for example "Q-1001") or the numeric quote id.' };
  }

  let quote: Rec | undefined;
  if (wantedNumber) {
    const res = await client.quotes.list({ quoteNumber: wantedNumber, page: 1, pageSize: PAGE_SIZE });
    const found = (Array.isArray(res) ? (res as Rec[]) : []).filter(
      (q) => typeof q.quoteNumber === 'string' && q.quoteNumber.toLowerCase() === wantedNumber.toLowerCase()
    );
    if (found.length === 0) {
      return { ok: false, error: `No quote with quote number "${wantedNumber}".` };
    }
    if (found.length > 1) {
      return { ok: false, error: `${found.length} quotes have quote number "${wantedNumber}"; give the id instead (ids: ${found.map((q) => q.id).join(', ')}).` };
    }
    quote = found[0];
  } else {
    const res = await client.quotes.get(wantedId as number);
    if (!res || typeof res !== 'object') return { ok: false, error: `No quote with id ${wantedId}.` };
    quote = res as Rec;
  }

  const quoteId = Number(quote.id);
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

  return {
    ok: true,
    value: {
      quote,
      sectionCount: sections.length,
      lineCount,
      sections,
      ...(truncated ? { note: `Some sections or lines were not read (more than ${MAX_PAGES * PAGE_SIZE} in one list).` } : {}),
    },
  };
}
