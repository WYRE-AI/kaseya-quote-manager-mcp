import { describe, expect, it } from 'vitest';
import { MAX_RESPONSE_BYTES, TRUNCATION_NOTE, okResult, renderResponse } from '../render.js';
import { UNTRUSTED_NOTICE, WRAPPER_BYTES } from '../untrusted.js';
import { isIsoDateTime } from '../validate.js';
import { safeError } from '../utils/logger.js';
import { unwrapText } from './helpers/unwrap.js';

const bytes = (s: string) => Buffer.byteLength(s, 'utf8');

describe('final result size (L2)', () => {
  const cases: Array<[string, unknown]> = [
    ['large ASCII', { note: 'a'.repeat(300_000) }],
    ['large multibyte (2-byte)', { note: 'é'.repeat(300_000) }],
    ['large multibyte (3-byte)', { note: '漢'.repeat(100_000) }],
    ['large 4-byte', { note: '😀'.repeat(80_000) }],
    ['marker-heavy text that grows when neutralized', { note: '<untrusted-content '.repeat(30_000) }],
    ['closing markers', { note: '</untrusted-content nonce="x">'.repeat(10_000) }],
    ['spaced markers', { note: '< / UNTRUSTED-CONTENT'.repeat(10_000) }],
  ];

  it.each(cases)('stays within 102400 bytes: %s', (_name, value) => {
    const text = okResult(value).content[0].text;
    expect(bytes(text)).toBeLessThanOrEqual(102_400);
    expect(MAX_RESPONSE_BYTES).toBe(102_400);
    const inner = unwrapText(text);
    expect(inner.endsWith(TRUNCATION_NOTE)).toBe(true);
    expect(inner).not.toContain('�');
    expect(inner).not.toMatch(/<\s*\/?\s*untrusted-content/i);
  });

  it('fills the budget closely instead of cutting far short', () => {
    const text = okResult({ note: 'a'.repeat(300_000) }).content[0].text;
    expect(bytes(text)).toBeGreaterThan(102_400 - 4);
  });

  it('measures the wrapper exactly', () => {
    const text = okResult({ a: 1 }).content[0].text;
    expect(bytes(text) - bytes(renderResponse({ a: 1 }))).toBe(WRAPPER_BYTES);
    expect(text.startsWith(UNTRUSTED_NOTICE)).toBe(true);
  });

  it('leaves small results unchanged', () => {
    const value = { a: 1, b: ['é', '<untrusted-content x>'] };
    const inner = unwrapText(okResult(value).content[0].text);
    expect(inner).toBe(JSON.stringify(value, null, 2).replace('<untrusted-content', '‹untrusted-content'));
    expect(renderResponse({ a: 1 })).toBe(JSON.stringify({ a: 1 }, null, 2));
    expect(inner).not.toContain('TRUNCATED');
  });

  it('does not truncate a result that fits exactly', () => {
    const room = MAX_RESPONSE_BYTES - WRAPPER_BYTES;
    const overhead = bytes(JSON.stringify({ n: '' }, null, 2));
    const value = { n: 'a'.repeat(room - overhead) };
    expect(bytes(renderResponse(value))).toBe(room);
    expect(bytes(okResult(value).content[0].text)).toBe(MAX_RESPONSE_BYTES);
    expect(okResult(value).content[0].text).not.toContain('TRUNCATED');
    const over = okResult({ n: 'a'.repeat(room - overhead + 1) }).content[0].text;
    expect(over).toContain('TRUNCATED');
    expect(bytes(over)).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
  });
});

describe('modifiedAfter (L3)', () => {
  it.each([
    '2026-01-31',
    '2026-01-31T00:00',
    '2026-01-31T00:00:00',
    '2026-01-31T00:00:00Z',
    '2026-01-31T00:00:00.123Z',
    '2026-01-31T12:30:45+05:30',
    '2026-01-31T12:30-08:00',
    '2024-02-29',
  ])('accepts %s', (value) => {
    expect(isIsoDateTime(value)).toBe(true);
  });

  it.each([
    'March 5',
    '2026/01/31',
    '1',
    '2026',
    '2026-01',
    '2026-1-5',
    '2026-02-30',
    '2025-02-29',
    '2026-13-01',
    '2026-00-10',
    '2026-04-31',
    '2026-01-31T24:00:00Z',
    '2026-01-31T12:60:00Z',
    '2026-01-31T12:00:60Z',
    '2026-01-31T12:00:00+25:00',
    '2026-01-31T12:00:00+0530',
    '2026-01-31 12:00:00',
    '2026-01-31T12',
    '2026-01-31T12:00:00.1Z',
    ' 2026-01-31',
    '2026-01-31 ',
    'Sat, 31 Jan 2026 00:00:00 GMT',
    '',
  ])('rejects %j', (value) => {
    expect(isIsoDateTime(value)).toBe(false);
  });
});

describe('safeError (L5)', () => {
  it('keeps only the type and a message capped at 200 characters', () => {
    class UpstreamError extends Error {
      apiKey = 'secret-key';
      body = { token: 'secret-token' };
    }
    const logged = safeError(Object.assign(new UpstreamError('x'.repeat(500)), { statusCode: 500 }));
    expect(Object.keys(logged)).toEqual(['errorType', 'message']);
    expect(logged.errorType).toBe('UpstreamError');
    expect(logged.message).toHaveLength(200);
    expect(JSON.stringify(logged)).not.toContain('secret');
  });

  it('copes with non-error values', () => {
    expect(safeError('boom')).toEqual({ errorType: 'String', message: '' });
    expect(safeError(undefined)).toEqual({ errorType: 'undefined', message: '' });
    expect(safeError(null)).toEqual({ errorType: 'object', message: '' });
  });
});
