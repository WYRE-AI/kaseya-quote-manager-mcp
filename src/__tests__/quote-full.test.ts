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
});
