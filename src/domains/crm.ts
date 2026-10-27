import { createEntityHandler } from './entity.js';
import { MODIFIED_AFTER, idProp } from './schema.js';

export const crmHandler = createEntityHandler([
  { key: 'customer', resource: 'customers', plural: 'customers', singular: 'customer', idLabel: 'Customer', filters: { modifiedAfter: MODIFIED_AFTER } },
  { key: 'customer_address', resource: 'customerAddress', plural: 'customer addresses', singular: 'customer address', idLabel: 'CustomerAddress', filters: { customerID: idProp('Filter by customerID'), modifiedAfter: MODIFIED_AFTER } },
  { key: 'contact', resource: 'contacts', plural: 'contacts', singular: 'contact', idLabel: 'Contact', filters: { customerID: idProp('Filter by customerID'), modifiedAfter: MODIFIED_AFTER } },
]);
