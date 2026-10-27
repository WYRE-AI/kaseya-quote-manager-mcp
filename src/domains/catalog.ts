import { createEntityHandler } from './entity.js';
import { MODIFIED_AFTER, idProp, text } from './schema.js';

export const catalogHandler = createEntityHandler([
  { key: 'product', resource: 'products', plural: 'products', singular: 'product', idLabel: 'Product', filters: { manufacturerPartNumber: text('Filter by manufacturerPartNumber'), modifiedAfter: MODIFIED_AFTER } },
  { key: 'product_image', resource: 'productImages', plural: 'product images', singular: 'product image', idLabel: 'ProductImage', filters: { productID: idProp('Filter by productID') }, noGet: true },
  { key: 'category', resource: 'categories', plural: 'product categories', singular: 'product category', idLabel: 'Category', noParams: true },
  { key: 'brand', resource: 'brands', plural: 'brands', singular: 'brand', idLabel: 'Brand', filters: { modifiedAfter: MODIFIED_AFTER } },
]);
