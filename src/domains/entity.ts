import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { requestContext, type DomainHandler, type CallToolResult } from '../utils/types.js';
import { getClient } from '../utils/client.js';
import { acquireForCurrentKey } from '../utils/rate-limit.js';
import type { RunContext } from '../reports/run.js';
import { logger } from '../utils/logger.js';
import { okResult, errorResult } from '../render.js';
import { UNKNOWN_TOOL_MESSAGE } from '../errors.js';
import { requireId } from '../validate.js';
import { PAGE, PAGE_SIZE, idProp, readOnlyTool, type Prop } from './schema.js';

/** One API entity: a `kqm_<key>_list` tool and, unless `noGet`, a `kqm_<key>_get` tool. */
export interface Entity {
  key: string;
  /** SDK client resource name, e.g. `quoteLines`. */
  resource: string;
  plural: string;
  singular: string;
  /** Model name used in the id description, e.g. `QuoteLine`. */
  idLabel: string;
  /** Filter properties beyond page/pageSize. */
  filters?: Record<string, Prop>;
  /** List takes no parameters at all. */
  noParams?: boolean;
  noGet?: boolean;
}

/** A hand-written tool that runs next to the entity tools in one domain. */
export interface ExtraTool {
  tool: Tool;
  run(args: Record<string, unknown>, ctx?: RunContext): Promise<CallToolResult>;
}

/** Copy only the named, defined args. Callers have already validated them against the schema. */
function pick(args: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (args[key] !== undefined) out[key] = args[key];
  return out;
}

export function createEntityHandler(entities: Entity[], extras: ExtraTool[] = []): DomainHandler {
  const getTools = (): Tool[] => [
    ...entities.flatMap((e) => {
      const list = readOnlyTool(
        `kqm_${e.key}_list`,
        `List ${e.plural}. Read-only. Returns up to pageSize (max 100) results per page.`,
        e.noParams ? {} : { ...e.filters, page: PAGE, pageSize: PAGE_SIZE },
      );
      if (e.noGet) return [list];
      return [
        list,
        readOnlyTool(`kqm_${e.key}_get`, `Get a single ${e.singular} record by ID. Read-only.`, { id: idProp(`${e.idLabel} ID`) }, ['id']),
      ];
    }),
    ...extras.map((x) => x.tool),
  ];

  async function handleCall(toolName: string, args: Record<string, unknown>, mcpExtra?: unknown): Promise<CallToolResult> {
    const ctx = requestContext(mcpExtra);
    const extra = extras.find((x) => x.tool.name === toolName);
    if (extra) return extra.run(args, ctx);
    const match = /^kqm_(.+)_(list|get)$/.exec(toolName);
    const entity = match ? entities.find((e) => e.key === match[1]) : undefined;
    if (!match || !entity || (match[2] === 'get' && entity.noGet)) return errorResult(UNKNOWN_TOOL_MESSAGE);

    const client = await getClient();
    // Resources share the same list/get shape, so one dynamic lookup serves every entity.
    const resource = (client as unknown as Record<string, { list(p?: unknown): Promise<unknown>; get(id: number): Promise<unknown> }>)[
      entity.resource
    ];
    logger.info(`API call: ${entity.resource}.${match[2]}`);
    await acquireForCurrentKey(ctx.signal);
    if (match[2] === 'get') return okResult(await resource.get(requireId(args.id)));
    if (entity.noParams) return okResult(await resource.list());
    return okResult(await resource.list(pick(args, [...Object.keys(entity.filters ?? {}), 'page', 'pageSize'])));
  }

  return { getTools, handleCall };
}
