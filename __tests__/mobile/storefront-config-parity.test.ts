/** @jest-environment node */

// Drift guard for config-level (non-section) storefront design settings — the
// sibling of the section-editor guard (section-field-specs-parity.test.ts).
// STOREFRONT_CONFIG_DESIGN_KEYS (packages/domain/src/storefront.ts) lists
// every StorefrontConfig key the visual editors own; adding a key to
// StorefrontConfig is a compile error there until it is placed in the design
// or non-design list. This suite then fails until BOTH apps reference every
// design key:
// 1. the web settings (shop-profile-form.tsx, product-page-template-form.tsx,
//    and the storefront/* editors), and
// 2. the mobile design screens (app/(tabs)/storefront/design/* plus the
//    design store/scopes libs the screens write through).
// Both editors are hand-written UI with no importable key lists, so the check
// is a word-boundary source scan — the same pragmatic pattern the web
// section-editor check uses. It catches "key never wired into this app's
// editor", which is the drift this contract exists to prevent. Non-design
// keys (shop slug, custom domain, payment settings) are intentionally only
// required to round-trip — see storefront-config-roundtrip.test.ts.

import * as fs from "fs";
import * as path from "path";

import {
  STOREFRONT_CONFIG_DESIGN_KEYS,
  STOREFRONT_CONFIG_NON_DESIGN_KEYS,
} from "@self-sown/domain";

function collectSources(...roots: string[]): string {
  let out = "";
  const walk = (p: string) => {
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      for (const entry of fs.readdirSync(p)) walk(path.join(p, entry));
    } else if (/\.tsx?$/.test(p)) {
      out += fs.readFileSync(p, "utf8") + "\n";
    }
  };
  for (const root of roots) walk(root);
  return out;
}

const WEB_SOURCES = collectSources(
  path.join(__dirname, "../../components/settings/shop-profile-form.tsx"),
  path.join(__dirname, "../../components/settings/product-page-template-form.tsx"),
  path.join(__dirname, "../../components/settings/storefront")
);

const MOBILE_SOURCES = collectSources(
  path.join(__dirname, "../../apps/mobile/app/(tabs)/storefront/design"),
  path.join(__dirname, "../../apps/mobile/lib/storefront-design-store.ts"),
  path.join(__dirname, "../../apps/mobile/lib/storefront-design-scopes.ts"),
  path.join(__dirname, "../../apps/mobile/lib/section-field-specs.ts")
);

describe("storefront config design-key parity", () => {
  it("design + non-design lists are disjoint and non-empty", () => {
    // The compile-time partition in storefront.ts is the real guard; assert
    // the runtime shape too so a list built via `any` still fails here.
    expect(STOREFRONT_CONFIG_DESIGN_KEYS.length).toBeGreaterThan(0);
    expect(STOREFRONT_CONFIG_NON_DESIGN_KEYS.length).toBeGreaterThan(0);
    const all = [
      ...STOREFRONT_CONFIG_DESIGN_KEYS,
      ...STOREFRONT_CONFIG_NON_DESIGN_KEYS,
    ];
    expect(new Set(all).size).toBe(all.length);
  });

  it.each([...STOREFRONT_CONFIG_DESIGN_KEYS])(
    'web settings reference the design key "%s"',
    (key) => {
      // Failure reads: no web settings surface references this config key —
      // wire it into shop-profile-form.tsx, product-page-template-form.tsx,
      // or a components/settings/storefront/* editor.
      expect(new RegExp(`\\b${key}\\b`).test(WEB_SOURCES)).toBe(true);
    }
  );

  it.each([...STOREFRONT_CONFIG_DESIGN_KEYS])(
    'mobile design screens reference the design key "%s"',
    (key) => {
      // Failure reads: no mobile design surface references this config key —
      // wire it into the matching screen under
      // apps/mobile/app/(tabs)/storefront/design/.
      expect(new RegExp(`\\b${key}\\b`).test(MOBILE_SOURCES)).toBe(true);
    }
  );
});
