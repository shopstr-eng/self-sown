import type { StorefrontConfig, StorefrontSection } from "@self-sown/domain";

// A design "scope" names which sections[] array in the storefront config a
// list/editor screen operates on: the homepage, the blog index page, the
// product-page defaults, or one custom page. Passed as a route param.
export type SectionScope =
  | "home"
  | "blog"
  | "productDefaults"
  | `page:${string}`;

export function parseSectionScope(raw: string | undefined): SectionScope {
  if (raw === "blog" || raw === "productDefaults") return raw;
  if (raw && raw.startsWith("page:")) return raw as SectionScope;
  return "home";
}

export function getScopedSections(
  draft: StorefrontConfig,
  scope: SectionScope
): StorefrontSection[] {
  if (scope === "home") return draft.sections ?? [];
  if (scope === "blog") return draft.blogPage?.sections ?? [];
  if (scope === "productDefaults") return draft.productPageDefaults ?? [];
  const pageId = scope.slice(5);
  return draft.pages?.find((page) => page.id === pageId)?.sections ?? [];
}

export function setScopedSections(
  draft: StorefrontConfig,
  scope: SectionScope,
  sections: StorefrontSection[]
): StorefrontConfig {
  if (scope === "home") return { ...draft, sections };
  if (scope === "blog") return { ...draft, blogPage: { sections } };
  if (scope === "productDefaults")
    return { ...draft, productPageDefaults: sections };
  const pageId = scope.slice(5);
  return {
    ...draft,
    pages: (draft.pages ?? []).map((page) =>
      page.id === pageId ? { ...page, sections } : page
    ),
  };
}

export function updateScopedSection(
  draft: StorefrontConfig,
  scope: SectionScope,
  sectionId: string,
  recipe: (section: StorefrontSection) => StorefrontSection
): StorefrontConfig {
  const sections = getScopedSections(draft, scope).map((section) =>
    section.id === sectionId ? recipe(section) : section
  );
  return setScopedSections(draft, scope, sections);
}

export function moveItem<T>(items: T[], index: number, delta: -1 | 1): T[] {
  const target = index + delta;
  if (index < 0 || target < 0 || target >= items.length) return items;
  const next = [...items];
  next.splice(target, 0, ...next.splice(index, 1));
  return next;
}
