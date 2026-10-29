import type { DomainName, DomainHandler } from '../utils/types.js';

const domainCache = new Map<DomainName, DomainHandler>();

export async function getDomainHandler(domain: DomainName): Promise<DomainHandler> {
  const cached = domainCache.get(domain);
  if (cached) return cached;

  let handler: DomainHandler;
  switch (domain) {
    case 'sales': {
      const { salesHandler } = await import('./sales.js');
      handler = salesHandler;
      break;
    }
    case 'procurement': {
      const { procurementHandler } = await import('./procurement.js');
      handler = procurementHandler;
      break;
    }
    case 'catalog': {
      const { catalogHandler } = await import('./catalog.js');
      handler = catalogHandler;
      break;
    }
    case 'crm': {
      const { crmHandler } = await import('./crm.js');
      handler = crmHandler;
      break;
    }
    case 'org': {
      const { orgHandler } = await import('./org.js');
      handler = orgHandler;
      break;
    }
    case 'reports': {
      const { reportsHandler } = await import('./reports.js');
      handler = reportsHandler;
      break;
    }
    default:
      throw new Error(`Unknown domain: ${domain}`);
  }

  domainCache.set(domain, handler);
  return handler;
}
