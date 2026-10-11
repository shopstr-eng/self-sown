/** @jest-environment node */

// Drift guard for the two storefront section editors. The per-type editable
// field contract lives in STOREFRONT_SECTION_EDITABLE_FIELDS
// (packages/domain/src/storefront.ts) — adding a field to StorefrontSection
// is a compile error there until it's listed for at least one section type.
// This suite then fails until BOTH editors handle the listed fields:
// 1. the mobile spec for each type must offer EXACTLY the listed keys — no
//    missing field (mobile can't edit it) and no extra field (web can't show
//    or change a value mobile set), and
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
  STOREFRONT_SECTION_ITEM_FIELDS,
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

// Every `records` spec entry across every section type (buttons, FAQ items,
// testimonials, slides, ...). Nested item editors drift separately from the
// top-level fields, so they get their own parity checks below.
type RecordsSpec = Extract<FieldSpec, { kind: "records" }>;

function allRecordsSpecs(): { type: StorefrontSectionType; spec: RecordsSpec }[] {
  return SECTION_TYPES.flatMap((type) =>
    (SECTION_FIELD_SPECS[type] ?? [])
      .filter((spec): spec is RecordsSpec => spec.kind === "records")
      .map((spec) => ({ type, spec }))
  );
}

const WEB_EDITOR_SOURCE = fs.readFileSync(
  path.join(
    __dirname,
    "../../components/settings/storefront/section-editor.tsx"
  ),
  "utf8"
);

// The web item editor (a top-level function in section-editor.tsx) that must
// handle each records key's item fields. Keyed like
// STOREFRONT_SECTION_ITEM_FIELDS so the two maps can be checked against each
// other — a new records kind needs both entries.
const RECORDS_WEB_EDITORS: Record<string, string> = {
  buttons: "SectionButtonsEditor",
  testimonials: "TestimonialEditor",
  items: "FaqEditor",
  ingredientItems: "IngredientEditor",
  timelineItems: "TimelineEditor",
  comparisonColumns: "ComparisonEditor",
  bannerSlides: "BannerSlidesEditor",
  socialPosts: "SocialPostsEditor",
  specifications: "SpecificationEditor",
};

// Slice out one top-level editor function's source so a field check is
// scoped to the editor that must handle it — a whole-file scan passes when
// some OTHER editor happens to reference the same key name (e.g. "image").
function webEditorFunctionSource(fnName: string): string {
  const start = WEB_EDITOR_SOURCE.indexOf(`function ${fnName}(`);
  if (start === -1) return "";
  const rest = WEB_EDITOR_SOURCE.slice(start);
  const next = rest.slice(1).search(/\nfunction \w+\(/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

const UNIQUE_RECORDS_KEYS = [
  ...new Set(allRecordsSpecs().map(({ spec }) => spec.key)),
];

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
    `mobile spec for "%s" matches the editable-field contract exactly`,
    (type) => {
      // Failure reads, per direction:
      // - missing: mobile editor cannot edit these on this section type — add
      //   them to SECTION_FIELD_SPECS in apps/mobile/lib/section-field-specs.ts.
      // - extra: mobile offers a field the web editor doesn't — either wire it
      //   into components/settings/storefront/section-editor.tsx (and add it to
      //   STOREFRONT_SECTION_EDITABLE_FIELDS) or drop it from the mobile spec.
      const mobileKeys = specKeys(SECTION_FIELD_SPECS[type] ?? []);
      const expected = STOREFRONT_SECTION_EDITABLE_FIELDS[type];
      const missing = expected.filter((key) => !mobileKeys.includes(key));
      const extra = mobileKeys.filter(
        (key) => !(expected as readonly string[]).includes(key)
      );
      expect({ missing, extra }).toEqual({ missing: [], extra: [] });
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
    const unreferenced = [...ALL_LISTED_KEYS].filter(
      (key) => !new RegExp(`\\b${key}\\b`).test(WEB_EDITOR_SOURCE)
    );
    expect(unreferenced).toEqual([]);
  });

  it("every mobile records spec has a domain item field contract", () => {
    // Failure reads: a mobile `records` editor edits items with no
    // compiler-checked field list — add the item interface's field list to
    // STOREFRONT_SECTION_ITEM_FIELDS in packages/domain/src/storefront.ts.
    // BUTTONS_FIELD is shared by many section types, so keys repeat — the
    // contract is on the unique key set.
    const recordsKeys = [
      ...new Set(allRecordsSpecs().map(({ spec }) => spec.key)),
    ];
    expect(recordsKeys.length).toBeGreaterThan(0);
    expect(recordsKeys.sort()).toEqual(
      Object.keys(STOREFRONT_SECTION_ITEM_FIELDS).sort()
    );
  });

  it.each(allRecordsSpecs())(
    `mobile records spec "$spec.key" (section "$type") covers every item field`,
    ({ spec }) => {
      // Failure reads: mobile item editor cannot edit these item fields — add
      // them to this records spec's `fields` in
      // apps/mobile/lib/section-field-specs.ts.
      const itemKeys = new Set(spec.fields.map((field) => field.key));
      const expected = STOREFRONT_SECTION_ITEM_FIELDS[spec.key] ?? [];
      expect(expected.length).toBeGreaterThan(0);
      const missing = expected.filter((key) => !itemKeys.has(key));
      expect(missing).toEqual([]);
      // Reverse direction: a spec field that isn't in the item interface is a
      // typo or drift from the domain contract.
      const unknown = [...itemKeys].filter((key) => !expected.includes(key));
      expect(unknown).toEqual([]);
    }
  );

  it("every records kind maps to a web item editor", () => {
    // Failure reads: RECORDS_WEB_EDITORS in this file is out of sync with the
    // records specs / STOREFRONT_SECTION_ITEM_FIELDS — add the mapping.
    expect([...UNIQUE_RECORDS_KEYS].sort()).toEqual(
      Object.keys(RECORDS_WEB_EDITORS).sort()
    );
  });

  it.each(UNIQUE_RECORDS_KEYS)(
    `web item editor for "%s" touches every item field`,
    (recordsKey) => {
      // Failure reads: the named web item editor (in components/settings/
      // storefront/section-editor.tsx) never references these item fields —
      // wire them into that editor. The check is scoped to the editor
      // function so a field used only by a DIFFERENT editor still fails here.
      const editorName = RECORDS_WEB_EDITORS[recordsKey]!;
      const source = webEditorFunctionSource(editorName);
      expect(source).not.toBe("");
      const expected = STOREFRONT_SECTION_ITEM_FIELDS[recordsKey] ?? [];
      const missing = expected.filter(
        (key) => !new RegExp(`\\b${key}\\b`).test(source)
      );
      expect(missing).toEqual([]);
    }
  );
});
