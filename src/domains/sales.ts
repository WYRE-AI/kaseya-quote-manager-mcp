import { createEntityHandler } from './entity.js';
import { MODIFIED_AFTER, idProp, text } from './schema.js';
import { quoteFullTool, salesOrderFullTool } from '../reports/full.js';

const soFilter = { salesOrderID: idProp('Filter by salesOrderID'), modifiedAfter: MODIFIED_AFTER };

export const salesHandler = createEntityHandler(
  [
    { key: 'quote', resource: 'quotes', plural: 'quotes', singular: 'quote', idLabel: 'Quote', filters: { quoteNumber: text('Filter by quoteNumber'), modifiedAfter: MODIFIED_AFTER } },
    { key: 'quote_section', resource: 'quoteSections', plural: 'quote sections', singular: 'quote section', idLabel: 'QuoteSection', filters: { quoteID: idProp('Filter by quoteID') } },
    { key: 'quote_line', resource: 'quoteLines', plural: 'quote line items', singular: 'quote line item', idLabel: 'QuoteLine', filters: { quoteSectionID: idProp('Filter by quoteSectionID') } },
    { key: 'sales_order', resource: 'salesOrders', plural: 'sales orders', singular: 'sales order', idLabel: 'SalesOrder', filters: { orderNumber: text('Filter by orderNumber'), modifiedAfter: MODIFIED_AFTER } },
    { key: 'sales_order_line', resource: 'salesOrderLines', plural: 'sales order line items', singular: 'sales order line item', idLabel: 'SalesOrderLine', filters: soFilter },
    { key: 'sales_order_payment', resource: 'salesOrderPayments', plural: 'sales order payments', singular: 'sales order payment', idLabel: 'SalesOrderPayment', filters: soFilter },
  ],
  [quoteFullTool, salesOrderFullTool],
);
