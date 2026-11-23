import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { DomainHandler, CallToolResult } from '../utils/types.js';
import { getClient } from '../utils/client.js';
import { logger } from '../utils/logger.js';
import { quoteFull, type QuoteFullClient } from './quote-full.js';

function getTools(): Tool[] {
  return [
    {
      name: 'kqm_quote_full',
      description:
        'Get one quote with all its sections and line items in one call, by quote number (for example "Q-1001") ' +
        'or by numeric quote id. Use this to read or summarise a quote: kqm_quote_get needs the numeric id, and ' +
        'line items otherwise have to be listed section by section. Section titles are returned as plain text. Read-only.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        type: 'object' as const,
        properties: {
          quoteNumber: { type: 'string', description: 'The quote number people use, for example "Q-1001"' },
          id: { type: 'number', description: 'The numeric quote id (alternative to quoteNumber)' },
        },
      },
    },
    {
      name: 'kqm_quote_list',
      description: 'List quotes. Read-only. Returns up to pageSize (max 100) results per page.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        type: 'object' as const,
        properties: {
          quoteNumber: { type: 'string', description: "Filter by quoteNumber" },
          page: { type: 'number', description: "Page number (1-based)" },
          pageSize: { type: 'number', description: "Results per page (max 100)" },
          modifiedAfter: { type: 'string', description: "ISO 8601 timestamp; return only records modified after this time" },
        },
      },
    },
    {
      name: 'kqm_quote_get',
      description: 'Get a single quote record by ID. Read-only.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        type: 'object' as const,
        properties: { id: { type: 'number', description: 'Quote ID' } },
        required: ['id'],
      },
    },
    {
      name: 'kqm_quote_section_list',
      description: 'List quote sections. Read-only. Returns up to pageSize (max 100) results per page.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        type: 'object' as const,
        properties: {
          quoteID: { type: 'number', description: "Filter by quoteID" },
          page: { type: 'number', description: "Page number (1-based)" },
          pageSize: { type: 'number', description: "Results per page (max 100)" },
        },
      },
    },
    {
      name: 'kqm_quote_section_get',
      description: 'Get a single quote section record by ID. Read-only.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        type: 'object' as const,
        properties: { id: { type: 'number', description: 'QuoteSection ID' } },
        required: ['id'],
      },
    },
    {
      name: 'kqm_quote_line_list',
      description: 'List quote line items. Read-only. Returns up to pageSize (max 100) results per page.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        type: 'object' as const,
        properties: {
          quoteSectionID: { type: 'number', description: "Filter by quoteSectionID" },
          page: { type: 'number', description: "Page number (1-based)" },
          pageSize: { type: 'number', description: "Results per page (max 100)" },
        },
      },
    },
    {
      name: 'kqm_quote_line_get',
      description: 'Get a single quote line item record by ID. Read-only.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        type: 'object' as const,
        properties: { id: { type: 'number', description: 'QuoteLine ID' } },
        required: ['id'],
      },
    },
    {
      name: 'kqm_sales_order_list',
      description: 'List sales orders. Read-only. Returns up to pageSize (max 100) results per page.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        type: 'object' as const,
        properties: {
          orderNumber: { type: 'string', description: "Filter by orderNumber" },
          page: { type: 'number', description: "Page number (1-based)" },
          pageSize: { type: 'number', description: "Results per page (max 100)" },
          modifiedAfter: { type: 'string', description: "ISO 8601 timestamp; return only records modified after this time" },
        },
      },
    },
    {
      name: 'kqm_sales_order_get',
      description: 'Get a single sales order record by ID. Read-only.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        type: 'object' as const,
        properties: { id: { type: 'number', description: 'SalesOrder ID' } },
        required: ['id'],
      },
    },
    {
      name: 'kqm_sales_order_line_list',
      description: 'List sales order line items. Read-only. Returns up to pageSize (max 100) results per page.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        type: 'object' as const,
        properties: {
          salesOrderID: { type: 'number', description: "Filter by salesOrderID" },
          page: { type: 'number', description: "Page number (1-based)" },
          pageSize: { type: 'number', description: "Results per page (max 100)" },
          modifiedAfter: { type: 'string', description: "ISO 8601 timestamp; return only records modified after this time" },
        },
      },
    },
    {
      name: 'kqm_sales_order_line_get',
      description: 'Get a single sales order line item record by ID. Read-only.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        type: 'object' as const,
        properties: { id: { type: 'number', description: 'SalesOrderLine ID' } },
        required: ['id'],
      },
    },
    {
      name: 'kqm_sales_order_payment_list',
      description: 'List sales order payments. Read-only. Returns up to pageSize (max 100) results per page.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        type: 'object' as const,
        properties: {
          salesOrderID: { type: 'number', description: "Filter by salesOrderID" },
          page: { type: 'number', description: "Page number (1-based)" },
          pageSize: { type: 'number', description: "Results per page (max 100)" },
          modifiedAfter: { type: 'string', description: "ISO 8601 timestamp; return only records modified after this time" },
        },
      },
    },
    {
      name: 'kqm_sales_order_payment_get',
      description: 'Get a single sales order payment record by ID. Read-only.',
      annotations: { readOnlyHint: true, openWorldHint: true },
      inputSchema: {
        type: 'object' as const,
        properties: { id: { type: 'number', description: 'SalesOrderPayment ID' } },
        required: ['id'],
      },
    },
  ];
}

async function handleCall(toolName: string, args: Record<string, unknown>): Promise<CallToolResult> {
  const client = await getClient();
  switch (toolName) {
    case 'kqm_quote_full': {
      logger.info('API call: quote full', { quoteNumber: args.quoteNumber, id: args.id });
      const res = await quoteFull(client as unknown as QuoteFullClient, { quoteNumber: args.quoteNumber, id: args.id });
      if (!res.ok) return { content: [{ type: 'text', text: res.error }], isError: true };
      return { content: [{ type: 'text', text: JSON.stringify(res.value, null, 2) }] };
    }
    case 'kqm_quote_list': {
      logger.info('API call: quotes.list', args);
      const res = await client.quotes.list({ quoteNumber: args.quoteNumber as string | undefined, page: args.page as number | undefined, pageSize: args.pageSize as number | undefined, modifiedAfter: args.modifiedAfter as string | undefined });
      return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
    }
    case 'kqm_quote_get': {
      const id = args.id as number;
      logger.info('API call: quotes.get', { id });
      const res = await client.quotes.get(id);
      return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
    }
    case 'kqm_quote_section_list': {
      logger.info('API call: quoteSections.list', args);
      const res = await client.quoteSections.list({ quoteID: args.quoteID as number | undefined, page: args.page as number | undefined, pageSize: args.pageSize as number | undefined });
      return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
    }
    case 'kqm_quote_section_get': {
      const id = args.id as number;
      logger.info('API call: quoteSections.get', { id });
      const res = await client.quoteSections.get(id);
      return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
    }
    case 'kqm_quote_line_list': {
      logger.info('API call: quoteLines.list', args);
      const res = await client.quoteLines.list({ quoteSectionID: args.quoteSectionID as number | undefined, page: args.page as number | undefined, pageSize: args.pageSize as number | undefined });
      return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
    }
    case 'kqm_quote_line_get': {
      const id = args.id as number;
      logger.info('API call: quoteLines.get', { id });
      const res = await client.quoteLines.get(id);
      return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
    }
    case 'kqm_sales_order_list': {
      logger.info('API call: salesOrders.list', args);
      const res = await client.salesOrders.list({ orderNumber: args.orderNumber as string | undefined, page: args.page as number | undefined, pageSize: args.pageSize as number | undefined, modifiedAfter: args.modifiedAfter as string | undefined });
      return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
    }
    case 'kqm_sales_order_get': {
      const id = args.id as number;
      logger.info('API call: salesOrders.get', { id });
      const res = await client.salesOrders.get(id);
      return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
    }
    case 'kqm_sales_order_line_list': {
      logger.info('API call: salesOrderLines.list', args);
      const res = await client.salesOrderLines.list({ salesOrderID: args.salesOrderID as number | undefined, page: args.page as number | undefined, pageSize: args.pageSize as number | undefined, modifiedAfter: args.modifiedAfter as string | undefined });
      return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
    }
    case 'kqm_sales_order_line_get': {
      const id = args.id as number;
      logger.info('API call: salesOrderLines.get', { id });
      const res = await client.salesOrderLines.get(id);
      return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
    }
    case 'kqm_sales_order_payment_list': {
      logger.info('API call: salesOrderPayments.list', args);
      const res = await client.salesOrderPayments.list({ salesOrderID: args.salesOrderID as number | undefined, page: args.page as number | undefined, pageSize: args.pageSize as number | undefined, modifiedAfter: args.modifiedAfter as string | undefined });
      return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
    }
    case 'kqm_sales_order_payment_get': {
      const id = args.id as number;
      logger.info('API call: salesOrderPayments.get', { id });
      const res = await client.salesOrderPayments.get(id);
      return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
    }
    default:
      return { content: [{ type: 'text', text: `Unknown tool: ${toolName}` }], isError: true };
  }
}

export const salesHandler: DomainHandler = { getTools, handleCall };
