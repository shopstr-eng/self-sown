import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchAllProductsFromDb } from "@/utils/db/db-service";
import { buildUcpCatalog } from "@/utils/ucp/catalog";

export function registerResources(server: McpServer) {
  server.resource(
    "product-catalog",
    "milkmarket://catalog/products",
    {
      description:
        "Full product catalog with all available listings, in the canonical UCP product shape (shared with the /api/ucp/catalog endpoints)",
      mimeType: "application/json",
    },
    async () => {
      const events = await fetchAllProductsFromDb();
      const products = buildUcpCatalog(events);

      return {
        contents: [
          {
            uri: "milkmarket://catalog/products",
            mimeType: "application/json",
            text: JSON.stringify({ count: products.length, products }, null, 2),
          },
        ],
      };
    }
  );
}
