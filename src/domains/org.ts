import { createEntityHandler } from './entity.js';
import { MODIFIED_AFTER } from './schema.js';

export const orgHandler = createEntityHandler([
  { key: 'employee', resource: 'employees', plural: 'employees', singular: 'employee', idLabel: 'Employee' },
  { key: 'warehouse', resource: 'warehouses', plural: 'warehouses', singular: 'warehouse', idLabel: 'Warehouse', filters: { modifiedAfter: MODIFIED_AFTER } },
]);
