import { wrapUntrusted } from './untrusted.js';
import type { CallToolResult } from './utils/types.js';

export const MAX_RESPONSE_BYTES = 100 * 1024;
export const TRUNCATION_NOTE =
  '\n[TRUNCATED: the result was larger than 100 KB. Ask for a smaller pageSize, a later page, or narrower filters.]';

/** Pretty JSON, cut to MAX_RESPONSE_BYTES on a character boundary with a note. */
export function renderResponse(value: unknown): string {
  const text = JSON.stringify(value, null, 2) ?? 'null';
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= MAX_RESPONSE_BYTES) return text;
  let end = MAX_RESPONSE_BYTES;
  // Back off continuation bytes (10xxxxxx) so a multi-byte character is never split.
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8') + TRUNCATION_NOTE;
}

/** Successful tool result: capped JSON inside the untrusted-content envelope. */
export function okResult(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: wrapUntrusted(renderResponse(value)) }] };
}

/** Error result with fixed, non-upstream text. Never wrapped. */
export function errorResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}
