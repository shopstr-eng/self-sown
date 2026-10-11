/** @jest-environment node */

// Round-trip guard for the mobile section editor's unit/type converters.
// Key-set parity (section-field-specs-parity.test.ts) proves both editors
// LIST the same fields; this suite proves the VALUES a mobile control writes
// survive the published-profile parse in the units/types the web renderers
// and domain parser expect:
// - overlayOpacity stores a 0–1 fraction (control edits 0–100 like the web
//   slider) — a raw percentage would render as a near-opaque overlay.
// - bannerInterval stores MILLISECONDS (carousel setInterval floor is
//   1500ms) — a raw seconds value clamps every slide to 1.5s.
// - imageWidth stores a NUMBER from an allowlist — the domain parser drops
//   string widths, so string-writing chips would silently discard the edit.

import {
  SECTION_FIELD_SPECS,
  type FieldSpec,
} from "@/apps/mobile/lib/section-field-specs";
import {
  parseSellerShopProfileEvent,
  type StorefrontSectionType,
} from "@self-sown/domain";

type ConvertibleSpec = Extract<FieldSpec, { kind: "number" | "chips" }>;

function specFor(
  type: StorefrontSectionType,
  key: string
): ConvertibleSpec {
  const spec = (SECTION_FIELD_SPECS[type] ?? []).find(
    (s): s is ConvertibleSpec =>
      (s.kind === "number" || s.kind === "chips") && s.key === key
  );
  if (!spec) throw new Error(`no "${key}" spec for "${type}"`);
  return spec;
}

// Simulate a mobile edit: apply the spec's toStore converter (as
// design/section/[id].tsx does on change) and publish the section inside a
// kind:30019 profile event.
function publishSection(
  type: StorefrontSectionType,
  key: string,
  displayed: number | string
): Record<string, unknown> {
  const spec = specFor(type, key);
  const stored =
    spec.toStore !== undefined
      ? spec.toStore(displayed as never)
      : displayed;
  return {
    id: "s1",
    type,
    [key]: stored,
  };
}

// The read-back path every web render and editor goes through: parse the
// published profile event (normalizeStorefrontConfig sanitizes each section).
function parseBack(
  section: Record<string, unknown>
): Record<string, unknown> {
  const profile = parseSellerShopProfileEvent({
    id: "e1",
    pubkey: "f".repeat(64),
    created_at: 1,
    kind: 30019,
    tags: [],
    content: JSON.stringify({ storefront: { sections: [section] } }),
  });
  const parsed = profile?.content.storefront?.sections?.[0] as
    | Record<string, unknown>
    | undefined;
  if (!parsed) throw new Error("section did not survive profile parse");
  return parsed;
}

describe("mobile section editor value round-trip", () => {
  it("overlayOpacity edits a percentage but stores a 0–1 fraction", () => {
    for (const type of ["hero", "banner_carousel"] as const) {
      const stored = publishSection(type, "overlayOpacity", 60);
      expect(stored.overlayOpacity).toBe(0.6);
      const parsed = parseBack(stored);
      expect(parsed.overlayOpacity).toBe(0.6);
      // And the control shows the seller the same percentage on reload.
      expect(specFor(type, "overlayOpacity").fromStore?.(0.6)).toBe(60);
    }
  });

  it("bannerInterval edits seconds but stores milliseconds", () => {
    const stored = publishSection("banner_carousel", "bannerInterval", 5);
    expect(stored.bannerInterval).toBe(5000);
    const parsed = parseBack(stored);
    expect(parsed.bannerInterval).toBe(5000);
    expect(specFor("banner_carousel", "bannerInterval").fromStore?.(5000)).toBe(
      5
    );
  });

  it("imageWidth chips store an allowlisted NUMBER, not a string", () => {
    for (const type of ["about", "image"] as const) {
      const stored = publishSection(type, "imageWidth", "50");
      expect(stored.imageWidth).toBe(50);
      const parsed = parseBack(stored);
      // The domain parser drops non-numeric widths — this is the regression
      // the converter exists to prevent.
      expect(parsed.imageWidth).toBe(50);
      expect(specFor(type, "imageWidth").fromStore?.(50)).toBe("50");
    }
  });

  it("every spec editing a converted field defines BOTH converters", () => {
    // A spec with only toStore would save correctly but misread existing
    // values (e.g. showing 0.6 in a 0–100 field); only fromStore would
    // strand web-set values. Require the pair on the known converted keys.
    const convertedKeys = ["overlayOpacity", "bannerInterval", "imageWidth"];
    for (const specs of Object.values(SECTION_FIELD_SPECS)) {
      for (const key of convertedKeys) {
        const spec = (specs ?? []).find(
          (s): s is ConvertibleSpec =>
            (s.kind === "number" || s.kind === "chips") && s.key === key
        );
        if (!spec) continue;
        expect(
          typeof spec.toStore === "function" &&
            typeof spec.fromStore === "function"
        ).toBe(true);
      }
    }
  });
});
