import { WRAPPER_BYTES, neutralize, wrapUntrusted } from './untrusted.js';
import type { CallToolResult } from './utils/types.js';

export const MAX_RESPONSE_BYTES = 100 * 1024;
export const TRUNCATION_NOTE =
  '\n[TRUNCATED: the result was larger than 100 KB, so the rest was cut. Ask for less: a smaller pageSize, top or record limit, a later page, or narrower filters such as modifiedAfter. For a *_get_full tool, read the child records with their list tools instead.]';

const NOTE_BYTES = Buffer.byteLength(TRUNCATION_NOTE);

/**
 * Pretty JSON, defanged, and cut on a character boundary so that the final
 * envelope (notice, tags and truncation note included) fits in MAX_RESPONSE_BYTES.
 */
export function renderResponse(value: unknown): string {
  const text = neutralize(JSON.stringify(value, null, 2) ?? 'null');
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length + WRAPPER_BYTES <= MAX_RESPONSE_BYTES) return text;
  let end = MAX_RESPONSE_BYTES - WRAPPER_BYTES - NOTE_BYTES;
  // Back off continuation bytes (10xxxxxx) so a multi-byte character is never split.
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8') + TRUNCATION_NOTE;
}

/** Successful tool result: capped JSON inside the untrusted-content envelope, at most MAX_RESPONSE_BYTES in all. */
export function okResult(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: wrapUntrusted(renderResponse(value)) }] };
}

/** Error result with fixed, non-upstream text. Never wrapped. */
export function errorResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}
