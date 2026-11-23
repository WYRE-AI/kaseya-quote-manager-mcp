// MCP Prompt Handlers for the Kaseya Quote Manager MCP Server
// Exposes pre-baked prompt templates via ListPrompts and GetPrompt handlers.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

export function registerPromptHandlers(server: Server): void {
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [
      {
        name: 'quote-pipeline-review',
        description: 'Review open quotes and summarize the sales pipeline by status and value',
        arguments: [],
      },
      {
        name: 'quote-detail',
        description: 'Pull a full quote breakdown — sections, line items, and customer',
        arguments: [
          {
            name: 'quote_number',
            description: 'The quote number to expand (e.g. Q-1024)',
            required: true,
          },
        ],
      },
      {
        name: 'purchasing-summary',
        description: 'Summarize open purchase orders, costs, and supplier exposure',
        arguments: [],
      },
    ],
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    switch (name) {
      case 'quote-pipeline-review':
        return {
          description: 'Review open quotes and summarize the sales pipeline',
          messages: [
            {
              role: 'user' as const,
              content: {
                type: 'text' as const,
                text: [
                  'Review the current Kaseya Quote Manager sales pipeline and produce a summary.',
                  '',
                  'Use the available tools to:',
                  '1. List quotes (kqm_quote_list), paging through results,',
                  '2. Group by status and count quotes in each,',
                  '3. Sum the delivery + line totals to estimate pipeline value where available,',
                  '4. Flag quotes that are expiring soon (expiryDate) and still open,',
                  '5. Identify the largest open quotes by value.',
                  '',
                  'Present a pipeline dashboard: totals by status, expiring soon, and top opportunities.',
                ].join('\n'),
              },
            },
          ],
        };

      case 'quote-detail':
        return {
          description: 'Expand a single quote into a full breakdown',
          messages: [
            {
              role: 'user' as const,
              content: {
                type: 'text' as const,
                text: [
                  `Produce a full breakdown of Kaseya Quote Manager quote ${args?.quote_number}.`,
                  '',
                  'Use the available tools to:',
                  '1. Read the quote with its sections and line items in one call: kqm_quote_full (quoteNumber),',
                  '2. Resolve the customer with kqm_customer_get and primary contact if present.',
                  '',
                  'Present the quote header (customer, owner, status, expiry), then each section with its',
                  'line items in a table (description, qty, unit price, total), and a grand total.',
                ].join('\n'),
              },
            },
          ],
        };

      case 'purchasing-summary':
        return {
          description: 'Summarize open purchase orders and supplier exposure',
          messages: [
            {
              role: 'user' as const,
              content: {
                type: 'text' as const,
                text: [
                  'Summarize current purchasing activity in Kaseya Quote Manager.',
                  '',
                  'Use the available tools to:',
                  '1. List purchase orders with kqm_purchase_order_list,',
                  '2. For notable POs, expand lines (kqm_purchase_order_line_list) and costs (kqm_purchase_order_cost_list),',
                  '3. Group spend by supplier (resolve names via kqm_supplier_get),',
                  '4. Flag POs not yet fully received or with outstanding costs.',
                  '',
                  'Present a purchasing summary: open PO count and value, spend by supplier, and any exceptions.',
                ].join('\n'),
              },
            },
          ],
        };

      default:
        throw new Error(`Unknown prompt: ${name}`);
    }
  });
}
