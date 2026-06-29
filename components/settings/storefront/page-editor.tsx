import { Input } from "@heroui/react";
import {
  StorefrontPage,
  StorefrontSection,
  StorefrontSectionType,
  StorefrontNavLink,
} from "@/utils/types/types";
import SectionEditor from "./section-editor";
import { useState } from "react";
import type { ProductData } from "@/utils/parsers/product-parser-functions";

interface PageEditorProps {
  pages: StorefrontPage[];
  onChange: (pages: StorefrontPage[]) => void;
  navLinks: StorefrontNavLink[];
  onNavLinksChange: (links: StorefrontNavLink[]) => void;
  sellerProducts?: ProductData[];
  shopPubkey?: string;
  hasSellerEmail?: boolean;
  showBlogPage?: boolean;
  blogPageSections?: StorefrontSection[];
  onBlogPageSectionsChange?: (sections: StorefrontSection[]) => void;
}

const SECTION_TYPES: { type: StorefrontSectionType; label: string }[] = [
  { type: "hero", label: "Hero" },
  { type: "about", label: "About" },
  { type: "story", label: "Our Story" },
  { type: "products", label: "Products" },
  { type: "testimonials", label: "Testimonials" },
  { type: "faq", label: "FAQ" },
  { type: "ingredients", label: "Ingredients / Sourcing" },
  { type: "comparison", label: "Comparison" },
  { type: "text", label: "Text Block" },
  { type: "image", label: "Image" },
  { type: "contact", label: "Contact" },
  { type: "contact_form", label: "Contact Form" },
  { type: "reviews", label: "Customer Reviews" },
  { type: "social_posts", label: "Social Posts" },
  { type: "blog", label: "Blog" },
];

// Slugs reserved for built-in storefront routes — custom pages can't use them.
const RESERVED_PAGE_SLUGS = new Set([
  "blog",
  "shop",
  "orders",
  "wallet",
  "community",
  "my-listings",
  "order-confirmation",
]);

// Sentinel key for expanding the built-in Blog page card.
const BLOG_PAGE_KEY = "__blog_page__";

const inputWrapperClass =
  "border-2 border-gray-300 rounded-lg bg-white shadow-none hover:bg-white data-[hover=true]:bg-white group-data-[focus=true]:border-black";

export default function PageEditor({
  pages,
  onChange,
  navLinks,
  onNavLinksChange,
  sellerProducts = [],
  shopPubkey,
  hasSellerEmail = false,
  showBlogPage = false,
  blogPageSections = [],
  onBlogPageSectionsChange,
}: PageEditorProps) {
  const [expandedPage, setExpandedPage] = useState<string | null>(null);
  const [slugErrors, setSlugErrors] = useState<Record<string, string>>({});

  const externalLinks = navLinks.filter((l) => !l.isPage);

  const addPage = () => {
    const id = `page-${Date.now()}`;
    const slug = "new-page";
    const title = "New Page";
    onChange([...pages, { id, title, slug, sections: [] }]);
    onNavLinksChange([...navLinks, { label: title, href: slug, isPage: true }]);
    setExpandedPage(id);
  };

  const removePage = (id: string) => {
    const page = pages.find((p) => p.id === id);
    onChange(pages.filter((p) => p.id !== id));
    if (page) {
      onNavLinksChange(
        navLinks.filter((l) => !(l.isPage && l.href === page.slug))
      );
    }
  };

  const updatePage = (id: string, fields: Partial<StorefrontPage>) => {
    const page = pages.find((p) => p.id === id);
    if (!page) return;
    const applied: Partial<StorefrontPage> = { ...fields };
    if (typeof fields.slug === "string") {
      const candidate = fields.slug;
      const isReserved = RESERVED_PAGE_SLUGS.has(candidate);
      const isDuplicate = pages.some(
        (p) => p.id !== id && p.slug === candidate
      );
      if (candidate && (isReserved || isDuplicate)) {
        setSlugErrors((prev) => ({
          ...prev,
          [id]: isReserved
            ? `"/${candidate}" is a reserved address and can't be used.`
            : `"/${candidate}" is already used by another page.`,
        }));
        delete applied.slug;
      } else {
        setSlugErrors((prev) => {
          const next = { ...prev };
          delete next[id];
          return next;
        });
      }
    }
    if (Object.keys(applied).length === 0) return;
    onChange(pages.map((p) => (p.id === id ? { ...p, ...applied } : p)));
    if (applied.title || applied.slug) {
      const oldSlug = page.slug;
      const newSlug = applied.slug || oldSlug;
      const newTitle = applied.title || page.title;
      onNavLinksChange(
        navLinks.map((l) =>
          l.isPage && l.href === oldSlug
            ? { ...l, label: newTitle, href: newSlug }
            : l
        )
      );
    }
  };

  const updatePageSections = (
    pageId: string,
    sections: StorefrontSection[]
  ) => {
    onChange(pages.map((p) => (p.id === pageId ? { ...p, sections } : p)));
  };

  const renderSectionList = (
    sectionList: StorefrontSection[],
    onSectionsChange: (sections: StorefrontSection[]) => void
  ) => (
    <>
      <div className="space-y-2">
        {sectionList.map((section, idx) => (
          <SectionEditor
            key={section.id}
            section={section}
            onChange={(updated) => {
              const next = [...sectionList];
              next[idx] = updated;
              onSectionsChange(next);
            }}
            onRemove={() =>
              onSectionsChange(sectionList.filter((_, i) => i !== idx))
            }
            onMoveUp={() => {
              if (idx === 0) return;
              const next = [...sectionList];
              [next[idx - 1], next[idx]] = [next[idx]!, next[idx - 1]!];
              onSectionsChange(next);
            }}
            onMoveDown={() => {
              if (idx === sectionList.length - 1) return;
              const next = [...sectionList];
              [next[idx], next[idx + 1]] = [next[idx + 1]!, next[idx]!];
              onSectionsChange(next);
            }}
            isFirst={idx === 0}
            isLast={idx === sectionList.length - 1}
            sellerProducts={sellerProducts}
            shopPubkey={shopPubkey}
          />
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        {SECTION_TYPES.filter(
          (st) => st.type !== "contact_form" || hasSellerEmail
        ).map((st) => (
          <button
            key={st.type}
            type="button"
            onClick={() =>
              onSectionsChange([
                ...sectionList,
                {
                  id: `section-${Date.now()}`,
                  type: st.type,
                  enabled: true,
                },
              ])
            }
            className="rounded border border-gray-300 px-2 py-1 text-xs font-medium text-gray-600 hover:border-black hover:text-black"
          >
            + {st.label}
          </button>
        ))}
      </div>
    </>
  );

  const addExternalLink = () => {
    onNavLinksChange([...navLinks, { label: "", href: "" }]);
  };

  const updateExternalLink = (
    oldIdx: number,
    fields: Partial<StorefrontNavLink>
  ) => {
    let extCount = 0;
    onNavLinksChange(
      navLinks.map((l) => {
        if (!l.isPage) {
          if (extCount === oldIdx) {
            extCount++;
            return { ...l, ...fields };
          }
          extCount++;
        }
        return l;
      })
    );
  };

  const removeExternalLink = (extIdx: number) => {
    let extCount = 0;
    onNavLinksChange(
      navLinks.filter((l) => {
        if (!l.isPage) {
          if (extCount === extIdx) {
            extCount++;
            return false;
          }
          extCount++;
        }
        return true;
      })
    );
  };

  return (
    <div className="space-y-4">
      <label className="block text-base font-bold text-black">Pages</label>
      <p className="text-sm text-gray-500">
        Create pages for your storefront. Each page gets its own URL, sections,
        and a link in the navigation bar.
      </p>

      {showBlogPage && onBlogPageSectionsChange && (
        <div className="rounded-lg border-2 border-gray-200 bg-gray-50">
          <div className="flex items-center justify-between px-4 py-3">
            <button
              type="button"
              onClick={() =>
                setExpandedPage(
                  expandedPage === BLOG_PAGE_KEY ? null : BLOG_PAGE_KEY
                )
              }
              className="flex items-center gap-2 text-sm font-bold text-black"
            >
              <span className="text-xs">
                {expandedPage === BLOG_PAGE_KEY ? "▾" : "▸"}
              </span>
              Blog
              <span className="font-normal text-gray-400">/blog</span>
            </button>
            <span className="text-xs font-medium text-gray-400">Built-in</span>
          </div>

          {expandedPage === BLOG_PAGE_KEY && (
            <div className="space-y-4 border-t border-gray-200 px-4 py-4">
              <p className="text-sm text-gray-500">
                Customize your blog index page. Add a Blog section to list your
                posts, plus any other sections you like.
              </p>
              {renderSectionList(blogPageSections, onBlogPageSectionsChange)}
            </div>
          )}
        </div>
      )}

      {pages.map((page) => (
        <div
          key={page.id}
          className="rounded-lg border-2 border-gray-200 bg-gray-50"
        >
          <div className="flex items-center justify-between px-4 py-3">
            <button
              type="button"
              onClick={() =>
                setExpandedPage(expandedPage === page.id ? null : page.id)
              }
              className="flex items-center gap-2 text-sm font-bold text-black"
            >
              <span className="text-xs">
                {expandedPage === page.id ? "▾" : "▸"}
              </span>
              {page.title}
              <span className="font-normal text-gray-400">/{page.slug}</span>
            </button>
            <button
              type="button"
              onClick={() => removePage(page.id)}
              className="text-xs text-red-500 hover:text-red-700"
            >
              Remove
            </button>
          </div>

          {expandedPage === page.id && (
            <div className="space-y-4 border-t border-gray-200 px-4 py-4">
              <div className="flex gap-3">
                <Input
                  label="Page Title"
                  classNames={{ inputWrapper: inputWrapperClass }}
                  variant="bordered"
                  value={page.title}
                  onChange={(e) =>
                    updatePage(page.id, { title: e.target.value })
                  }
                  className="flex-1"
                />
                <Input
                  label="URL Slug"
                  classNames={{ inputWrapper: inputWrapperClass }}
                  variant="bordered"
                  value={page.slug}
                  onChange={(e) =>
                    updatePage(page.id, {
                      slug: e.target.value
                        .toLowerCase()
                        .replace(/[^a-z0-9-]/g, "-"),
                    })
                  }
                  className="flex-1"
                />
              </div>
              {slugErrors[page.id] && (
                <p className="text-xs font-medium text-red-500">
                  {slugErrors[page.id]}
                </p>
              )}

              {renderSectionList(page.sections, (sections) =>
                updatePageSections(page.id, sections)
              )}
            </div>
          )}
        </div>
      ))}

      <button
        type="button"
        onClick={addPage}
        className="text-sm font-bold text-blue-600 hover:underline"
      >
        + Add Page
      </button>

      {externalLinks.length > 0 && (
        <div className="mt-4 space-y-2">
          <label className="block text-sm font-bold text-gray-600">
            External Links
          </label>
          {externalLinks.map((link, extIdx) => (
            <div key={extIdx} className="flex items-center gap-2">
              <Input
                classNames={{
                  inputWrapper:
                    "border-2 border-gray-300 rounded-lg bg-white shadow-none",
                  input: "!text-black",
                }}
                variant="bordered"
                value={link.label}
                onChange={(e) =>
                  updateExternalLink(extIdx, { label: e.target.value })
                }
                placeholder="Label"
                className="w-32"
              />
              <Input
                classNames={{
                  inputWrapper:
                    "border-2 border-gray-300 rounded-lg bg-white shadow-none",
                  input: "!text-black",
                }}
                variant="bordered"
                value={link.href}
                onChange={(e) =>
                  updateExternalLink(extIdx, { href: e.target.value })
                }
                placeholder="URL (e.g. https://...)"
                className="flex-1"
              />
              <button
                type="button"
                onClick={() => removeExternalLink(extIdx)}
                className="text-xs text-red-500"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      <button
        type="button"
        onClick={addExternalLink}
        className="text-sm text-gray-500 hover:text-black hover:underline"
      >
        + Add External Link
      </button>
    </div>
  );
}
