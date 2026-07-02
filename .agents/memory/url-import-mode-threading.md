---
name: URL website-import mode threading
description: How the seller "import from website URL" feature adds a stall-vs-product mode without breaking existing signed auth.
---

The URL-import feature has two ingress points that share one modal (`components/stall/import-design-modal.tsx`): the public outreach tool (`pages/stall-preview.tsx`, unauthed, no Pro) and the authed Pro settings import. Both hit `preview-from-url.ts` (public) and `import-from-url.ts` (authed). A `mode` param ("stall" | "product") selects the draft builder; product drafts are deterministic (`buildProductPageDraft`, no AI), stall drafts get optional AI styling.

**Rule:** any param that changes an import's auth binding must be threaded through BOTH the client signed fields AND the server `authFields`, and gated so legacy paths stay byte-identical.

**Why:** `verifyNostrAuth` binding is subset-based over sorted `["field",name,value]` tags. The client signs `{url}` for stall and `{url, mode:"product"}` for product; the server mirrors exactly. If you unconditionally added `mode` to the signed fields, every already-shipped stall signature (and any external caller) would break. Binding the new field ONLY for the new mode keeps old stall signatures valid forever. (Subset verification means a product-signed event would also pass stall verification, but same pubkey/endpoint/Pro-gate so nothing is gained — safe.)

**How to apply:** when extending this feature with another mode/param, add it to the signed `fields` object in the modal, the request body, and the server `authFields` — but keep the default/legacy branch signing the original field set. Also cache preview results per `${mode}:${url}` (same URL yields different drafts per mode).

Related: `PLACEHOLDER_PRODUCT` was lifted to `utils/storefront/placeholder-product.ts` so the public marketing page can render a product preview via `SectionRenderer` without bundling the heavy `product-page-editor`. `rehostProductPageImages` mirrors the stall rehost (fail-open, keeps original URLs on upload failure).
