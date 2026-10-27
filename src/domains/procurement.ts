import { createEntityHandler } from './entity.js';
import { MODIFIED_AFTER, idProp, text } from './schema.js';
import { purchaseOrderFullTool } from '../reports/full.js';

const poFilter = { purchaseOrderID: idProp('Filter by purchaseOrderID'), modifiedAfter: MODIFIED_AFTER };

export const procurementHandler = createEntityHandler(
  [
    { key: 'purchase_order', resource: 'purchaseOrders', plural: 'purchase orders', singular: 'purchase order', idLabel: 'PurchaseOrder', filters: { orderNumber: text('Filter by orderNumber'), modifiedAfter: MODIFIED_AFTER } },
    { key: 'purchase_order_line', resource: 'purchaseOrderLines', plural: 'purchase order line items', singular: 'purchase order line item', idLabel: 'PurchaseOrderLine', filters: poFilter },
    { key: 'purchase_order_cost', resource: 'purchaseOrderCosts', plural: 'purchase order costs', singular: 'purchase order cost', idLabel: 'PurchaseOrderCost', filters: poFilter },
    { key: 'supplier', resource: 'suppliers', plural: 'suppliers', singular: 'supplier', idLabel: 'Supplier', filters: { modifiedAfter: MODIFIED_AFTER } },
    { key: 'product_supplier', resource: 'productSuppliers', plural: 'product-supplier links', singular: 'product-supplier link', idLabel: 'ProductSupplier', filters: { productID: idProp('Filter by productID'), modifiedAfter: MODIFIED_AFTER } },
  ],
  [purchaseOrderFullTool],
);
