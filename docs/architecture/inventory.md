# Inventory

- **Centralized**: Postgres `inventory` (product_id, seller_pubkey, variant_key, quantity, source) + `inventory_log`. Variant keys: `_default` for global, `size:Name` for per-size.
- **Auto deduction**: All order flows deduct on success. Bulk/bundle orders multiply bundle size × quantity.
- **Seller override**: Publishing kind 30402 with quantity tags syncs inventory with `source: 'seller_override'`.
- **API**: `/api/inventory` actions: `check`, `deduct`, `set`, `restore`, `sync`. Service: `utils/db/inventory-service.ts`.
- MCP availability checks consult inventory first, falling back to Nostr event quantities for untracked products.
- **Newer wins**: a listing's own `quantity` / `size` tags are the source of truth. Postgres only knows about sales made on this marketplace, so it is a local fallback: a stock row overrides the listing only when its `updated_at` is later than the listing's `created_at` (`newerStockOnly` in `utils/inventory/live-stock.ts`, shared by server and browser). Rows with no timestamp are trusted; a missing row means the listing's own tags apply.
- **Batch read**: `getStockForProducts(ids)` returns one snapshot per product (with per-row unix-second timestamps) in a single query; `tryGetStockForProducts` never throws, so a database problem falls back to the listing tags. `GET /api/inventory?productIds=a,b,c` exposes it (max 100 ids, rate limited, `no-store`).
- **Where it applies**: UCP lookup + search, the MCP catalog resource, listing and stall JSON-LD (`InStock` / `OutOfStock`), and the browser (`useProductWithLiveStock`: "Sold out here" / "Only N left" on product cards and the listing page, sold-out sizes hidden). Flash sales (zapsnag) keep counting their own sales.
