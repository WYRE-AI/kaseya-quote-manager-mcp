import { UNTRUSTED_NOTICE } from '../../untrusted.js';

/** Strip the untrusted-content envelope from tool result text and return the inner text. */
export function unwrapText(text: string): string {
  const match = /^([\s\S]*?)\n<untrusted-content nonce="([0-9a-f]{32})">\n([\s\S]*)\n<\/untrusted-content nonce="\2">$/.exec(text);
  if (!match) throw new Error('Tool result is not wrapped in an untrusted-content envelope');
  if (match[1] !== UNTRUSTED_NOTICE) throw new Error('Unexpected untrusted-content notice');
  return match[3];
}

/** Parse the JSON payload out of a successful tool result. */
export function unwrap(result: { content: Array<{ text: string }> }): any {
  return JSON.parse(unwrapText(result.content[0].text));
}
