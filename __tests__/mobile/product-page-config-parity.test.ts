/** @jest-environment node */

// Drift guard for the per-product page customization (the page_config tag on
// a kind:30402 listing event) — the sibling of the section-editor guard
// (section-field-specs-parity.test.ts). PRODUCT_PAGE_CONFIG_FIELDS
// (packages/domain/src/product-page-config.ts) lists every
// StorefrontProductPageConfig key; adding one is a compile error there until
// it is listed. This suite then fails until BOTH editors reference every key:
// 1. the web "Customize Product Page" modal (customize-product-page-modal.tsx)
// 2. the mobile listing design screens (app/(tabs)/listings/design/*) plus
//    the product design store they write through.
// It also pins both editors to the shared domain builder/validator and both
// republish writers to the shared tag helper — the guarantees that make
// "settings carry over both ways" hold.

import * as fs from "fs";
import * as path from "path";

import { PRODUCT_PAGE_CONFIG_FIELDS } from "@self-sown/domain";

const read = (rel: string) =>
  fs.readFileSync(path.join(__dirname, "../..", rel), "utf8");

const WEB_MODAL = read("components/customize-product-page-modal.tsx");
const WEB_REPUBLISH = read("utils/nostr/nostr-helper-functions.ts");
const MOBILE_EDITOR =
  read("apps/mobile/app/(tabs)/listings/design/[listingId].tsx") +
  "\n" +
  read("apps/mobile/lib/product-page-design-store.ts");
const MOBILE_REPUBLISH = read("packages/nostr/src/index.ts");

describe("product page config editor parity", () => {
  it.each([...PRODUCT_PAGE_CONFIG_FIELDS])(
    "web modal references the %s key",
    (key) => {
      expect(WEB_MODAL).toMatch(new RegExp(`\\b${key}\\b`));
    }
  );

  it.each([...PRODUCT_PAGE_CONFIG_FIELDS])(
    "mobile design editor references the %s key",
    (key) => {
      expect(MOBILE_EDITOR).toMatch(new RegExp(`\\b${key}\\b`));
    }
  );

  it("both editors build the payload via the shared domain builder", () => {
    expect(WEB_MODAL).toContain("buildProductPageConfig");
    expect(MOBILE_EDITOR).toContain("buildProductPageConfig");
  });

  it("both editors gate saves via the shared domain validator", () => {
    expect(WEB_MODAL).toContain("validateProductPageConfig");
    expect(MOBILE_EDITOR).toContain("validateProductPageConfig");
  });

  it("both republish writers serialize the tag via the shared domain helper", () => {
    expect(WEB_REPUBLISH).toContain("withProductPageConfig");
    expect(MOBILE_REPUBLISH).toContain("withProductPageConfig");
  });
});
