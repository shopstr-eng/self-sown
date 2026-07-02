import type { ProductData } from "@/utils/parsers/product-parser-functions";

// Sample product used to render product-page section previews (template editor,
// URL-import preview, and the public preview tool) when no real product exists.
export const PLACEHOLDER_PRODUCT: ProductData = {
  id: "preview-placeholder",
  pubkey: "",
  createdAt: 0,
  title: "Sample Product",
  summary: "This is a sample product used to preview your template.",
  images: [],
  currency: "USD",
  totalCost: 0,
  shippingType: "Free",
  shippingCost: 0,
  categories: ["sample"],
  location: "Anywhere",
  status: "active",
  quantity: 0,
  d: "preview-d",
  sizes: [],
  weights: [],
  volumes: [],
} as unknown as ProductData;
