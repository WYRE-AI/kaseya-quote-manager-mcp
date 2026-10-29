/**
 * Request / tool-input limits (CVE-2026-111768 / GHSA-46jr-4wx8-v453,
 * GHSA-f897-62hf-6gxq; WYREAI-454).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_TOOL_INPUT_ELEMENTS,
  countToolInputElements,
  toolInputTooLarge,
  toolInputTooLargeResult,
} from '../input-limits.js';
import { connect } from './helpers/connect.js';

vi.mock('../utils/client.js', () => ({ getClient: vi.fn(), getCredentials: vi.fn() }));

describe('countToolInputElements', () => {
  it('counts nested arrays and object keys at every depth', () => {
    expect(countToolInputElements({}, 100)).toBe(0);
    expect(countToolInputElements('x', 100)).toBe(0);
    expect(countToolInputElements({ a: 1, b: [1, 2, 3] }, 100)).toBe(5);
    expect(countToolInputElements({ a: { b: { c: [1, { d: 1 }] } } }, 100)).toBe(6);
    expect(countToolInputElements([[1, 2], [3, [4]]], 100)).toBe(7);
  });

  it('exits early once the count exceeds max', () => {
    const big = new Array(1_000_000).fill(0);
    expect(countToolInputElements(big, 10)).toBeGreaterThan(10);
    const nested = Array.from({ length: 1000 }, () => new Array(1000).fill(0));
    // Stops after the outer array; never walks the 1,000 inner arrays.
    expect(countToolInputElements(nested, 10)).toBe(1000);
    expect(countToolInputElements(new Array(11).fill(0), 10)).toBe(11);
  });

  it('does not recurse (very deep nesting does not overflow the stack)', () => {
    let deep: unknown = [];
    for (let i = 0; i < 200_000; i++) deep = [deep];
    expect(countToolInputElements(deep, 1_000_000)).toBe(200_000);
  });

  it('allows exactly the limit and rejects one over', () => {
    expect(toolInputTooLarge(new Array(MAX_TOOL_INPUT_ELEMENTS).fill(0))).toBe(false);
    expect(toolInputTooLarge(new Array(MAX_TOOL_INPUT_ELEMENTS + 1).fill(0))).toBe(true);
    expect(toolInputTooLarge(undefined)).toBe(false);
  });

  it('builds the McpServer-compatible error result', () => {
    expect(toolInputTooLargeResult()).toEqual({
      content: [{ type: 'text', text: 'Tool input has more than 10000 values. Send fewer or shorter values.' }],
      isError: true,
    });
  });
});

describe('server tool input size guard', () => {
  let session: Awaited<ReturnType<typeof connect>> | undefined;
  afterEach(async () => {
    await session?.close();
    session = undefined;
  });

  it('rejects tools/call with >10000 argument elements without dispatching', async () => {
    session = await connect();
    const res = await session.call('kqm_quote_list', { quoteNumber: new Array(MAX_TOOL_INPUT_ELEMENTS + 1).fill(1) });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe('Tool input has more than 10000 values. Send fewer or shorter values.');
  });
});
