import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchAllProductsFromDb } from "@/utils/db/db-service";
import { tryGetStockForProducts } from "@/utils/db/inventory-service";
import { buildUcpCatalog } from "@/utils/ucp/catalog";

export function registerResources(server: McpServer) {
  server.resource(
    "product-catalog",
    "selfsown://catalog/products",
    {
      description:
        "Full product catalog with all available listings, in the canonical UCP product shape (shared with the /api/ucp/catalog endpoints)",
      mimeType: "application/json",
    },
    async () => {
      const events = await fetchAllProductsFromDb();
      const inventories = await tryGetStockForProducts(events.map((e) => e.id));
      const products = buildUcpCatalog(events, { inventories });

      return {
        contents: [
          {
            uri: "selfsown://catalog/products",
            mimeType: "application/json",
            text: JSON.stringify({ count: products.length, products }, null, 2),
          },
        ],
      };
    }
  );
}
