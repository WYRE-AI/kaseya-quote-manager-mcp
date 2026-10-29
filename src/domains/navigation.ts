import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { DomainName } from '../utils/types.js';
import { readOnlyTool } from './schema.js';

export const DOMAINS: DomainName[] = ["sales", "procurement", "catalog", "crm", "org", "reports"];

export function getNavigationTools(): Tool[] {
  return [
    readOnlyTool(
      'kqm_navigate',
      `Discover available Kaseya Quote Manager tools by domain. All tools are callable at any time — this is a help/discovery aid, not a prerequisite.`,
      {
        domain: {
          type: 'string',
          maxLength: 32,
          enum: DOMAINS,
          description: `The domain to explore:
- sales: quotes, quote sections/lines, sales orders, order lines, and payments (plus full quote and order views)
- procurement: purchase orders, order lines, costs, suppliers, and product-supplier links (plus a full purchase order view)
- catalog: products, product images, categories, and brands
- crm: customers, customer addresses, and contacts
- org: employees and warehouses
- reports: read-only pipeline, conversion, margin, customer spend, product velocity, and purchase reconciliation reports
`,
        },
      },
      ['domain'],
    ),
    readOnlyTool('kqm_status', 'Check Kaseya Quote Manager API connection status and available domains.'),
  ];
}
