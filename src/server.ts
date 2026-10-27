import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { getNavigationTools, DOMAINS } from './domains/navigation.js';
import { getDomainHandler } from './domains/index.js';
import { getCredentials } from './utils/client.js';
import { logger } from './utils/logger.js';
import type { DomainName } from './utils/types.js';
import { registerPromptHandlers } from './prompts.js';
import { toolInputTooLarge, toolInputTooLargeResult } from './input-limits.js';
import { validateArgs, type ObjectSchema } from './validate.js';
import { okResult, errorResult } from './render.js';
import { errorStatus, toolErrorMessage, UNKNOWN_TOOL_MESSAGE } from './errors.js';

interface ToolEntry { tool: Tool; domain: DomainName | null }

// Tool definitions never change at runtime, so the name -> definition index is built once.
let toolIndex: Promise<Map<string, ToolEntry>> | undefined;

function getToolIndex(): Promise<Map<string, ToolEntry>> {
  toolIndex ??= (async () => {
    const index = new Map<string, ToolEntry>();
    for (const tool of getNavigationTools()) index.set(tool.name, { tool, domain: null });
    for (const domain of DOMAINS) {
      for (const tool of (await getDomainHandler(domain)).getTools()) index.set(tool.name, { tool, domain });
    }
    return index;
  })();
  return toolIndex;
}

export function createServer(): Server {
  const server = new Server(
    { name: 'kaseya-quote-manager-mcp', version: '1.0.0' },
    {
      capabilities: {
        tools: {},
        logging: {},
        prompts: {},
      },
    }
  );

  // Register prompt handlers
  registerPromptHandlers(server);

  // Return ALL tools upfront — navigation is a stateless help/discovery tool
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: [...(await getToolIndex()).values()].map((e) => e.tool) };
  });

  // Route tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: rawArgs } = request.params;

    const args = rawArgs ?? {};
    if (typeof args !== 'object' || Array.isArray(args)) {
      return errorResult('Tool input must be an object. Check the tool input schema.');
    }
    if (toolInputTooLarge(args)) return toolInputTooLargeResult();

    const entry = (await getToolIndex()).get(name);
    if (!entry) return errorResult(UNKNOWN_TOOL_MESSAGE);

    try {
      if (name === 'kqm_navigate' && !DOMAINS.includes(args.domain as DomainName)) {
        return errorResult(`Invalid domain. Valid: ${DOMAINS.join(', ')}`);
      }
      validateArgs(entry.tool.inputSchema as ObjectSchema, args);

      // Navigation: navigate (stateless discovery aid)
      if (name === 'kqm_navigate') {
        const domain = args.domain as DomainName;
        const tools = (await getDomainHandler(domain)).getTools().map(t => `${t.name}: ${t.description}`);
        return {
          content: [{
            type: 'text' as const,
            text: `Domain: ${domain}\n\nAvailable tools:\n${tools.join('\n')}`,
          }],
        };
      }

      // Navigation: status
      if (name === 'kqm_status') {
        return okResult({
          connected: !!getCredentials(),
          domains: DOMAINS,
          status: 'No domain selected. Call conduit__my_access to see which tools you can use under the gateway, or kqm_navigate to browse tools by domain when running standalone.',
        });
      }

      if (!entry.domain) return errorResult(UNKNOWN_TOOL_MESSAGE);
      return await (await getDomainHandler(entry.domain)).handleCall(name, args, extra);
    } catch (error) {
      // Type and status only: never the message, arguments, ids or upstream body.
      logger.error('Tool call failed', {
        tool: name,
        errorType: (error as { constructor?: { name?: string } } | null)?.constructor?.name,
        status: errorStatus(error),
      });
      return errorResult(toolErrorMessage(error));
    }
  });

  return server;
}
