import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export type Prop = Record<string, unknown>;

/** Positive whole-number record ID. */
export const idProp = (description: string): Prop => ({ type: 'integer', minimum: 1, description });

export const text = (description: string, maxLength = 256): Prop => ({ type: 'string', maxLength, description });

export const intProp = (description: string, minimum: number, maximum: number, def?: number): Prop => ({
  type: 'integer',
  minimum,
  maximum,
  ...(def !== undefined ? { default: def } : {}),
  description,
});

export const PAGE: Prop = { type: 'integer', minimum: 1, description: 'Page number (1-based)' };
export const PAGE_SIZE: Prop = { type: 'integer', minimum: 1, maximum: 100, description: 'Results per page (max 100)' };
export const MODIFIED_AFTER: Prop = text('ISO 8601 timestamp; return only records modified after this time', 64);

/** A read-only tool with a strict input schema (unknown arguments are rejected). */
export function readOnlyTool(
  name: string,
  description: string,
  properties: Record<string, Prop> = {},
  required?: string[],
): Tool {
  return {
    name,
    description,
    annotations: { readOnlyHint: true, openWorldHint: true, destructiveHint: false, idempotentHint: true },
    inputSchema: {
      type: 'object' as const,
      properties,
      additionalProperties: false,
      ...(required ? { required } : {}),
    },
  };
}
