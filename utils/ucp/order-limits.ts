/**
 * Shared order-quantity bounds, imported by BOTH the MCP tool schemas
 * (pages/api/mcp/index.ts) and the order engine (utils/ucp/order-service.ts).
 *
 * This module must stay dependency-free: the MCP route imports it but cannot
 * import order-service.ts, which pulls in the DB layer. Defining the bounds
 * here (instead of duplicating literals + pinning tests) makes drift between
 * the schema-level and service-level caps impossible.
 */

/**
 * Upper bound on per-line order quantity. Quantity multiplies the unit price
 * straight into subtotal/invoice amounts, so an absurd value must be rejected
 * by the schema AND enforced in the order service for direct REST callers.
 */
export const MAX_ORDER_QUANTITY = 10000;

/**
 * Upper bound on the selected bulk/bundle tier size (number of units).
 * selectedBulkUnits multiplies quantity into the effective quantity, so it
 * needs the same schema-side bound as quantity itself.
 */
export const MAX_SELECTED_BULK_UNITS = 100000;
