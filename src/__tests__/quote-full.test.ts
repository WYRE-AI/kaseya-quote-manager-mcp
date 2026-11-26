import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/client.js', () => ({ getClient: vi.fn() }));

import { getClient } from '../utils/client.js';
import { salesHandler } from '../domains/sales.js';
import { htmlToText } from '../domains/quote-full.js';
import { createMockClient, type MockClient } from './helpers/mock-client.js';

const QUOTE = { id: 1001, quoteNumber: 'Q-1001', title: 'Annual renewal' };

function text(result: { content: { text?: string }[] }): string {
  return result.content[0].text ?? '';
}

describe('kqm_quote_full', () => {
  let client: MockClient;

  beforeEach(() => {
    client = createMockClient();
    vi.mocked(getClient).mockReturnValue(client as any);
    client.quotes.list.mockResolvedValue([QUOTE]);
    client.quotes.get.mockResolvedValue(QUOTE);
    client.quoteSections.list.mockResolvedValue([
      { id: 2, quoteID: 1001, lineNumber: 2, type: 0, title: '<div>Annual renewal for <b>Example Co</b>:</div><div>From 1 Jan</div>' },
      { id: 1, quoteID: 1001, lineNumber: 1, type: 1, title: null },
    ]);
    client.quoteLines.list.mockImplementation(async (p: { quoteSectionID: number }) =>
      p.quoteSectionID === 2
        ? [
            { id: 11, quoteSectionID: 2, lineNumber: 2, title: 'Widget Pro', quantity: 1, price: 100, createdDate: 'x' },
            { id: 10, quoteSectionID: 2, lineNumber: 1, title: 'Widget Basic', quantity: 10, price: 25 },
          ]
        : []
    );
  });

  it('finds a quote by its number and returns its sections and lines in order', async () => {
    const result = await salesHandler.handleCall('kqm_quote_full', { quoteNumber: 'q-1001' });
    expect(result.isError).toBeUndefined();
    const v = JSON.parse(text(result));
    expect(client.quotes.list).toHaveBeenCalledWith({ quoteNumber: 'q-1001', page: 1, pageSize: 100 });
    expect(client.quoteSections.list).toHaveBeenCalledWith({ quoteID: 1001, page: 1, pageSize: 100 });
    expect(client.quotes.get).toHaveBeenCalledWith(1001);
    expect(v.quote.id).toBe(1001);
    expect(v.sectionCount).toBe(2);
    expect(v.lineCount).toBe(2);
    expect(v.sections.map((s: { id: number }) => s.id)).toEqual([1, 2]);
    expect(v.sections[1].title).toBe('Annual renewal for Example Co:\nFrom 1 Jan');
    expect(v.sections[1].lines.map((l: { title: string }) => l.title)).toEqual(['Widget Basic', 'Widget Pro']);
    expect(v.sections[1].lines[1].createdDate).toBeUndefined();
  });

  it('accepts the numeric id instead', async () => {
    const result = await salesHandler.handleCall('kqm_quote_full', { id: 1001 });
    expect(client.quotes.get).toHaveBeenCalledWith(1001);
    expect(JSON.parse(text(result)).quote.quoteNumber).toBe('Q-1001');
  });

  it('pages through long section and line lists', async () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ id: 100 + i, lineNumber: i + 1, title: `L${i}` }));
    client.quoteSections.list.mockResolvedValue([{ id: 2, lineNumber: 1, type: 0, title: null }]);
    client.quoteLines.list
      .mockResolvedValueOnce(many)
      .mockResolvedValueOnce([{ id: 999, lineNumber: 101, title: 'last' }]);
    const v = JSON.parse(text(await salesHandler.handleCall('kqm_quote_full', { quoteNumber: 'Q-1001' })));
    expect(client.quoteLines.list).toHaveBeenNthCalledWith(2, { quoteSectionID: 2, page: 2, pageSize: 100 });
    expect(v.lineCount).toBe(101);
    expect(v.note).toBeUndefined();
  });

  it('says so when the quote number is not found, or when nothing is given', async () => {
    client.quotes.list.mockResolvedValue([{ id: 1, quoteNumber: 'Q-10010' }]);
    const missing = await salesHandler.handleCall('kqm_quote_full', { quoteNumber: 'Q-1001' });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toMatch(/No quote with quote number "Q-1001"/);
    const none = await salesHandler.handleCall('kqm_quote_full', {});
    expect(none.isError).toBe(true);
    expect(text(none)).toMatch(/Give quoteNumber/);
  });

  it('reads the full quote by id after finding it by number', async () => {
    client.quotes.list.mockResolvedValue([{ id: 1001, quoteNumber: 'Q-1001' }]);
    client.quotes.get.mockResolvedValue({ ...QUOTE, notes: 'only on the full record' });
    const v = JSON.parse(text(await salesHandler.handleCall('kqm_quote_full', { quoteNumber: 'Q-1001' })));
    expect(client.quotes.get).toHaveBeenCalledWith(1001);
    expect(v.quote.notes).toBe('only on the full record');
  });

  it('pages through the quote-number lookup and lists every candidate id', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, quoteNumber: 'Q-7' }));
    client.quotes.list.mockResolvedValueOnce(page1).mockResolvedValueOnce([{ id: 101, quoteNumber: 'Q-7' }]);
    const result = await salesHandler.handleCall('kqm_quote_full', { quoteNumber: 'Q-7' });
    expect(result.isError).toBe(true);
    expect(client.quotes.list).toHaveBeenNthCalledWith(2, { quoteNumber: 'Q-7', page: 2, pageSize: 100 });
    expect(text(result)).toMatch(/^101 quotes have quote number "Q-7"/);
    expect(text(result)).toMatch(/, 101\)\.$/);
    expect(text(result)).not.toMatch(/may be incomplete/);
  });

  it('says the lookup may be incomplete when it reaches the page limit', async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, quoteNumber: i < 2 ? 'Q-8' : 'Q-80' }));
    client.quotes.list.mockResolvedValue(full);
    const result = await salesHandler.handleCall('kqm_quote_full', { quoteNumber: 'Q-8' });
    expect(client.quotes.list).toHaveBeenCalledTimes(20);
    expect(text(result)).toMatch(/limit of 2000 records, so this may be incomplete/);
  });

  it('notes that more records may exist when a list reaches the limit, without claiming they were missed', async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ id: 100 + i, lineNumber: i + 1, title: `L${i}` }));
    client.quoteSections.list.mockResolvedValue([{ id: 2, lineNumber: 1, type: 0, title: null }]);
    client.quoteLines.list.mockResolvedValue(full);
    const v = JSON.parse(text(await salesHandler.handleCall('kqm_quote_full', { id: 1001 })));
    expect(v.lineCount).toBe(2000);
    expect(v.note).toMatch(/reached the limit of 2000 records, so more sections or lines may exist/);
    expect(v.note).not.toMatch(/not read/);
  });

  it('lets a failed vendor call reject instead of reporting it as a lookup miss', async () => {
    client.quotes.get.mockRejectedValue(Object.assign(new Error('Resource not found'), { statusCode: 404 }));
    await expect(salesHandler.handleCall('kqm_quote_full', { id: 5 })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('is listed as a read-only tool', () => {
    const tool = salesHandler.getTools().find((t) => t.name === 'kqm_quote_full');
    expect(tool?.annotations?.readOnlyHint).toBe(true);
  });
});

describe('htmlToText', () => {
  it('turns stored HTML into plain lines', () => {
    expect(htmlToText('<div style="x">A &amp; B</div><div>C&nbsp;D</div>')).toBe('A & B\nC D');
    expect(htmlToText(null)).toBeNull();
    expect(htmlToText('<div></div>')).toBeNull();
  });

  it('decodes decimal and hexadecimal numeric entities', () => {
    expect(htmlToText('<div>Support &#8211; renewal</div>')).toBe('Support – renewal');
    expect(htmlToText('<div>Support &#x2013; renewal &#X2014; 2027</div>')).toBe('Support – renewal — 2027');
    expect(htmlToText('It&#39;s &apos;fine&apos; &#160;now')).toBe("It's 'fine' now");
  });

  it('decodes each entity once and leaves unknown or invalid ones alone', () => {
    expect(htmlToText('&amp;lt;b&amp;gt; &amp;#8211;')).toBe('&lt;b&gt; &#8211;');
    expect(htmlToText('&copy; &#0; &#xD800; &#99999999;')).toBe('&copy; &#0; &#xD800; &#99999999;');
  });
});
