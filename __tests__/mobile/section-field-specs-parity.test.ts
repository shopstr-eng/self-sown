/** @jest-environment node */

// Drift guard for the two storefront section editors. The per-type editable
// field contract lives in STOREFRONT_SECTION_EDITABLE_FIELDS
// (packages/domain/src/storefront.ts) — adding a field to StorefrontSection
// is a compile error there until it's listed for at least one section type.
// This suite then fails until BOTH editors handle the listed fields:
// 1. the mobile spec for each type must cover every listed key, and
// 2. the web editor source must touch every listed key.
// The web editor is hand-written JSX (no field list to import), so its check
// is a source scan — good enough to catch "field never wired into the web
// editor", which is the drift this contract exists to prevent.

import * as fs from "fs";
import * as path from "path";

import {
  SECTION_FIELD_SPECS,
  type FieldSpec,
} from "@/apps/mobile/lib/section-field-specs";
import {
  STOREFRONT_SECTION_EDITABLE_FIELDS,
  type StorefrontSectionEditableKey,
  type StorefrontSectionType,
} from "@self-sown/domain";

// Spec entries without a `key` are composite controls bound to one section
// field by the editor screen (design/section/[id].tsx).
const PSEUDO_KIND_KEYS: Record<string, StorefrontSectionEditableKey> = {
  elementOrder: "elementOrder",
  productIds: "productIds",
  heroProduct: "heroProductId",
};

function specKeys(specs: FieldSpec[]): string[] {
  return specs.map((spec) =>
    "key" in spec ? spec.key : (PSEUDO_KIND_KEYS[spec.kind] ?? spec.kind)
  );
}

const SECTION_TYPES = Object.keys(
  STOREFRONT_SECTION_EDITABLE_FIELDS
) as StorefrontSectionType[];

const ALL_LISTED_KEYS = new Set<string>(
  Object.values(STOREFRONT_SECTION_EDITABLE_FIELDS).flat()
);

describe("storefront section editor field parity", () => {
  it("declares an editable-field list for every section type", () => {
    // Record<StorefrontSectionType, ...> makes this exhaustive at compile
    // time; assert at runtime too so a type added via `any` still fails here.
    expect(SECTION_TYPES.length).toBeGreaterThan(0);
    for (const type of SECTION_TYPES) {
      expect(
        STOREFRONT_SECTION_EDITABLE_FIELDS[type].length
      ).toBeGreaterThanOrEqual(1);
    }
  });

  it("mobile has a field spec for every section type", () => {
    // Failure reads: mobile section-field-specs.ts has no spec for "<type>".
    const missing = SECTION_TYPES.filter(
      (type) => SECTION_FIELD_SPECS[type] === undefined
    );
    expect(missing).toEqual([]);
  });

  it.each(SECTION_TYPES)(
    `mobile spec for "%s" covers every web-editable field`,
    (type) => {
      // Failure reads: mobile editor cannot edit these on this section type —
      // add them to SECTION_FIELD_SPECS in apps/mobile/lib/section-field-specs.ts.
      const mobileKeys = new Set(specKeys(SECTION_FIELD_SPECS[type] ?? []));
      const missing = STOREFRONT_SECTION_EDITABLE_FIELDS[type].filter(
        (key) => !mobileKeys.has(key)
      );
      expect(missing).toEqual([]);
    }
  );

  it.each(SECTION_TYPES)(
    `mobile spec for "%s" has no unknown or duplicate keys`,
    (type) => {
      // Failure reads: key is not a known StorefrontSection editable field
      // (typo, or add it to STOREFRONT_SECTION_EDITABLE_FIELDS).
      const keys = specKeys(SECTION_FIELD_SPECS[type] ?? []);
      const unknown = keys.filter((key) => !ALL_LISTED_KEYS.has(key));
      expect(unknown).toEqual([]);
      expect(keys.length).toBe(new Set(keys).size);
    }
  );

  it("web section editor source touches every editable field", () => {
    // Failure reads: web editor (components/settings/storefront/
    // section-editor.tsx) never references these keys — wire them in.
    const webEditorSource = fs.readFileSync(
      path.join(
        __dirname,
        "../../components/settings/storefront/section-editor.tsx"
      ),
      "utf8"
    );
    const unreferenced = [...ALL_LISTED_KEYS].filter(
      (key) => !new RegExp(`\\b${key}\\b`).test(webEditorSource)
    );
    expect(unreferenced).toEqual([]);
  });
});
