import type { Tool } from '@modelcontextprotocol/sdk/types.js';

export type DomainName = 'sales' | 'procurement' | 'catalog' | 'crm' | 'org' | 'reports';

export type CallToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

/** Per-request context passed from the MCP server down to report and entity handlers. */
export interface RequestContext {
  /** Aborts when the MCP client cancels the request. */
  signal?: AbortSignal;
}

/** Pick the request context out of the MCP `extra` argument. */
export function requestContext(extra: unknown): RequestContext {
  const signal = (extra as { signal?: unknown } | null | undefined)?.signal;
  return signal instanceof AbortSignal ? { signal } : {};
}

export interface DomainHandler {
  getTools(): Tool[];
  handleCall(
    toolName: string,
    args: Record<string, unknown>,
    extra?: unknown
  ): Promise<CallToolResult>;
}
