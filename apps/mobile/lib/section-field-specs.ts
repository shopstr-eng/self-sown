import type {
  StorefrontSection,
  StorefrontSectionType,
} from "@self-sown/domain";

// Field-spec driven section editor: each section type declares the fields its
// editor renders, and design/section/[id].tsx walks the spec. This mirrors
// the web's components/settings/storefront/section-editor.tsx coverage — when
// adding a field to StorefrontSection, add it to the relevant spec group here
// or the mobile editor silently can't edit it (web editor has the same rule).

export type ItemFieldSpec = {
  key: string;
  label: string;
  kind: "text" | "textarea" | "url" | "number" | "chips";
  options?: { value: string; label: string }[];
  placeholder?: string;
  min?: number;
  max?: number;
};

export type FieldSpec =
  | {
      kind: "text" | "textarea" | "url" | "email";
      key: string;
      label: string;
      placeholder?: string;
      hint?: string;
    }
  | { kind: "color"; key: string; label: string }
  | {
      kind: "number";
      key: string;
      label: string;
      min?: number;
      max?: number;
      hint?: string;
    }
  | { kind: "toggle"; key: string; label: string; description?: string }
  | {
      kind: "chips";
      key: string;
      label: string;
      options: { value: string; label: string }[];
      allowUnset?: boolean;
    }
  | {
      kind: "records";
      key: string;
      label: string;
      addLabel: string;
      titleKey: string;
      fields: ItemFieldSpec[];
      makeNew: () => Record<string, unknown>;
    }
  | { kind: "strings"; key: string; label: string; hint?: string }
  | { kind: "elementOrder" }
  | { kind: "productIds" }
  | { kind: "heroProduct" };

// ---- shared groups -------------------------------------------------------

const HEADING_FIELDS: FieldSpec[] = [
  { kind: "text", key: "heading", label: "Heading" },
  { kind: "text", key: "subheading", label: "Subheading" },
];

const BODY_FIELD: FieldSpec = {
  kind: "textarea",
  key: "body",
  label: "Body text",
};

const IMAGE_FIELD: FieldSpec = {
  kind: "url",
  key: "image",
  label: "Image URL",
  placeholder: "https://…",
};

const BUTTONS_FIELD: FieldSpec = {
  kind: "records",
  key: "buttons",
  label: "Buttons",
  addLabel: "Add button",
  titleKey: "label",
  makeNew: () => ({ label: "Learn more", variant: "primary" }),
  fields: [
    { key: "label", label: "Label", kind: "text" },
    { key: "href", label: "Link (https:// or #section)", kind: "url" },
    {
      key: "variant",
      label: "Style",
      kind: "chips",
      options: [
        { value: "primary", label: "Primary" },
        { value: "secondary", label: "Secondary" },
        { value: "outline", label: "Outline" },
      ],
    },
    {
      key: "size",
      label: "Size",
      kind: "chips",
      options: [
        { value: "sm", label: "Small" },
        { value: "md", label: "Medium" },
        { value: "lg", label: "Large" },
      ],
    },
    {
      key: "align",
      label: "Alignment",
      kind: "chips",
      options: [
        { value: "left", label: "Left" },
        { value: "center", label: "Center" },
        { value: "right", label: "Right" },
      ],
    },
  ],
};

const LEGACY_CTA_FIELDS: FieldSpec[] = [
  { kind: "text", key: "ctaText", label: "Button text (legacy single CTA)" },
  {
    kind: "url",
    key: "ctaLink",
    label: "Button link (legacy single CTA)",
    hint: "Prefer the Buttons list above — it supports multiple buttons.",
  },
];

const OVERLAY_FIELDS: FieldSpec[] = [
  {
    kind: "number",
    key: "overlayOpacity",
    label: "Image overlay darkness (0–100)",
    min: 0,
    max: 100,
  },
  { kind: "color", key: "headingColor", label: "Heading color" },
  { kind: "color", key: "subheadingColor", label: "Subheading color" },
  { kind: "color", key: "textOutlineColor", label: "Text outline color" },
];

const STYLE_FIELDS: FieldSpec[] = [
  { kind: "color", key: "backgroundColor", label: "Section background" },
  { kind: "color", key: "textColor", label: "Section text color" },
  {
    kind: "chips",
    key: "textAlign",
    label: "Text alignment",
    options: [
      { value: "left", label: "Left" },
      { value: "center", label: "Center" },
      { value: "right", label: "Right" },
    ],
  },
  {
    kind: "chips",
    key: "contentWidth",
    label: "Content width",
    options: [
      { value: "narrow", label: "Narrow" },
      { value: "normal", label: "Normal" },
      { value: "full", label: "Full" },
    ],
  },
  {
    kind: "chips",
    key: "headingSize",
    label: "Heading size",
    options: [
      { value: "sm", label: "S" },
      { value: "md", label: "M" },
      { value: "lg", label: "L" },
      { value: "xl", label: "XL" },
    ],
  },
  {
    kind: "chips",
    key: "bodySize",
    label: "Body size",
    options: [
      { value: "sm", label: "S" },
      { value: "md", label: "M" },
      { value: "lg", label: "L" },
      { value: "xl", label: "XL" },
    ],
  },
];

const IMAGE_STYLE_FIELDS: FieldSpec[] = [
  {
    kind: "chips",
    key: "imagePlacement",
    label: "Image placement",
    options: [
      { value: "left", label: "Left" },
      { value: "right", label: "Right" },
      { value: "top", label: "Top" },
      { value: "bottom", label: "Bottom" },
      { value: "background", label: "Background" },
    ],
  },
  {
    kind: "chips",
    key: "imageHeight",
    label: "Image height",
    options: [
      { value: "auto", label: "Auto" },
      { value: "short", label: "Short" },
      { value: "medium", label: "Medium" },
      { value: "tall", label: "Tall" },
    ],
  },
  {
    kind: "chips",
    key: "imageFit",
    label: "Image fit",
    options: [
      { value: "cover", label: "Cover" },
      { value: "contain", label: "Contain" },
    ],
  },
  {
    kind: "chips",
    key: "imageWidth",
    label: "Image width (%)",
    options: [
      { value: "25", label: "25" },
      { value: "33", label: "33" },
      { value: "50", label: "50" },
      { value: "66", label: "66" },
      { value: "75", label: "75" },
      { value: "100", label: "100" },
    ],
  },
];

// ---- per-type specs ------------------------------------------------------

const HOME_AND_PAGE_SPECS: Partial<Record<StorefrontSectionType, FieldSpec[]>> =
  {
    hero: [
      ...HEADING_FIELDS,
      IMAGE_FIELD,
      ...OVERLAY_FIELDS,
      {
        kind: "toggle",
        key: "fullWidth",
        label: "Full-width hero",
        description: "Stretch the hero edge-to-edge (legacy layout toggle).",
      },
      BUTTONS_FIELD,
      ...LEGACY_CTA_FIELDS,
      { kind: "elementOrder" },
      ...STYLE_FIELDS,
    ],
    about: [
      { kind: "text", key: "heading", label: "Heading" },
      BODY_FIELD,
      IMAGE_FIELD,
      {
        kind: "chips",
        key: "imagePosition",
        label: "Image side (legacy)",
        options: [
          { value: "left", label: "Left" },
          { value: "right", label: "Right" },
        ],
      },
      BUTTONS_FIELD,
      { kind: "elementOrder" },
      ...STYLE_FIELDS,
      ...IMAGE_STYLE_FIELDS,
    ],
    story: [
      { kind: "text", key: "heading", label: "Heading" },
      BODY_FIELD,
      {
        kind: "records",
        key: "timelineItems",
        label: "Timeline entries",
        addLabel: "Add timeline entry",
        titleKey: "heading",
        makeNew: () => ({ year: "", heading: "Milestone", body: "" }),
        fields: [
          { key: "year", label: "Year / era", kind: "text" },
          { key: "heading", label: "Heading", kind: "text" },
          { key: "body", label: "Text", kind: "textarea" },
          { key: "image", label: "Image URL", kind: "url" },
        ],
      },
      BUTTONS_FIELD,
      { kind: "elementOrder" },
      ...STYLE_FIELDS,
    ],
    products: [
      ...HEADING_FIELDS,
      {
        kind: "chips",
        key: "productLayout",
        label: "Layout",
        options: [
          { value: "grid", label: "Grid" },
          { value: "list", label: "List" },
          { value: "featured", label: "Featured" },
        ],
      },
      {
        kind: "number",
        key: "productLimit",
        label: "Max products",
        min: 1,
        max: 48,
        hint: "Leave unset to show all (or the curated list below).",
      },
      { kind: "productIds" },
      BUTTONS_FIELD,
      { kind: "elementOrder" },
      ...STYLE_FIELDS,
    ],
    testimonials: [
      { kind: "text", key: "heading", label: "Heading" },
      {
        kind: "records",
        key: "testimonials",
        label: "Testimonials",
        addLabel: "Add testimonial",
        titleKey: "author",
        makeNew: () => ({ quote: "", author: "" }),
        fields: [
          { key: "quote", label: "Quote", kind: "textarea" },
          { key: "author", label: "Author", kind: "text" },
          { key: "image", label: "Author image URL", kind: "url" },
          {
            key: "rating",
            label: "Rating (1–5)",
            kind: "number",
            min: 1,
            max: 5,
          },
        ],
      },
      BUTTONS_FIELD,
      { kind: "elementOrder" },
      ...STYLE_FIELDS,
    ],
    faq: [
      { kind: "text", key: "heading", label: "Heading" },
      {
        kind: "records",
        key: "items",
        label: "Questions",
        addLabel: "Add question",
        titleKey: "question",
        makeNew: () => ({ question: "", answer: "" }),
        fields: [
          { key: "question", label: "Question", kind: "text" },
          { key: "answer", label: "Answer", kind: "textarea" },
        ],
      },
      BUTTONS_FIELD,
      { kind: "elementOrder" },
      ...STYLE_FIELDS,
    ],
    ingredients: [
      { kind: "text", key: "heading", label: "Heading" },
      BODY_FIELD,
      {
        kind: "records",
        key: "ingredientItems",
        label: "Ingredients",
        addLabel: "Add ingredient",
        titleKey: "name",
        makeNew: () => ({ name: "" }),
        fields: [
          { key: "name", label: "Name", kind: "text" },
          { key: "description", label: "Description", kind: "textarea" },
          { key: "image", label: "Image URL", kind: "url" },
          { key: "emoji", label: "Emoji", kind: "text" },
        ],
      },
      BUTTONS_FIELD,
      { kind: "elementOrder" },
      ...STYLE_FIELDS,
    ],
    comparison: [
      { kind: "text", key: "heading", label: "Heading" },
      {
        kind: "strings",
        key: "comparisonFeatures",
        label: "Feature rows",
        hint: "One row label per entry, e.g. “Organic certification”.",
      },
      {
        kind: "records",
        key: "comparisonColumns",
        label: "Comparison columns",
        addLabel: "Add column",
        titleKey: "heading",
        makeNew: () => ({ heading: "Us", values: [] }),
        fields: [
          { key: "heading", label: "Column heading", kind: "text" },
          {
            key: "values",
            label: "Values (one per feature row, newline-separated)",
            kind: "textarea",
          },
        ],
      },
      BUTTONS_FIELD,
      { kind: "elementOrder" },
      ...STYLE_FIELDS,
    ],
    text: [
      { kind: "text", key: "heading", label: "Heading" },
      BODY_FIELD,
      BUTTONS_FIELD,
      { kind: "elementOrder" },
      ...STYLE_FIELDS,
    ],
    image: [
      IMAGE_FIELD,
      { kind: "text", key: "caption", label: "Caption" },
      {
        kind: "toggle",
        key: "fullWidth",
        label: "Full-width image",
      },
      BUTTONS_FIELD,
      { kind: "elementOrder" },
      ...STYLE_FIELDS,
      ...IMAGE_STYLE_FIELDS,
    ],
    banner_carousel: [
      {
        kind: "records",
        key: "bannerSlides",
        label: "Slides",
        addLabel: "Add slide",
        titleKey: "heading",
        makeNew: () => ({ image: "", heading: "" }),
        fields: [
          { key: "image", label: "Image URL", kind: "url" },
          { key: "heading", label: "Heading", kind: "text" },
          { key: "subheading", label: "Subheading", kind: "text" },
          { key: "ctaText", label: "Button text", kind: "text" },
          { key: "ctaLink", label: "Button link", kind: "url" },
        ],
      },
      {
        kind: "toggle",
        key: "bannerAutoplay",
        label: "Auto-advance slides",
      },
      {
        kind: "number",
        key: "bannerInterval",
        label: "Seconds between slides",
        min: 2,
        max: 30,
      },
      {
        kind: "toggle",
        key: "fullWidth",
        label: "Full-width banners",
      },
      ...OVERLAY_FIELDS,
      ...STYLE_FIELDS,
      ...IMAGE_STYLE_FIELDS,
    ],
    marquee: [
      {
        kind: "text",
        key: "heading",
        label: "Marquee text",
        hint: "Leave empty to scroll your shop name.",
      },
      {
        kind: "url",
        key: "image",
        label: "Logo URL (inline with the text)",
        placeholder: "https://…",
      },
      { kind: "color", key: "headingColor", label: "Text color" },
      {
        kind: "color",
        key: "marqueeBackgroundColor",
        label: "Strip background",
      },
      {
        kind: "number",
        key: "marqueeSpeed",
        label: "Seconds per scroll loop",
        min: 2,
        max: 120,
      },
      {
        kind: "chips",
        key: "marqueeDirection",
        label: "Scroll direction",
        options: [
          { value: "left", label: "Left" },
          { value: "right", label: "Right" },
        ],
      },
    ],
    contact: [
      { kind: "text", key: "heading", label: "Heading" },
      BODY_FIELD,
      { kind: "email", key: "email", label: "Email" },
      { kind: "text", key: "phone", label: "Phone" },
      { kind: "textarea", key: "address", label: "Address" },
      BUTTONS_FIELD,
      { kind: "elementOrder" },
      ...STYLE_FIELDS,
    ],
    contact_form: [
      { kind: "text", key: "heading", label: "Heading" },
      BODY_FIELD,
      {
        kind: "chips",
        key: "contactFormMode",
        label: "Form purpose",
        allowUnset: false,
        options: [
          { value: "contact", label: "Messages the seller" },
          { value: "subscription", label: "Joins the email list" },
        ],
      },
      {
        kind: "toggle",
        key: "showNameField",
        label: "Show name field",
      },
      {
        kind: "toggle",
        key: "showPhoneField",
        label: "Show phone field",
      },
      {
        kind: "toggle",
        key: "showMessageField",
        label: "Show message field",
      },
      {
        kind: "textarea",
        key: "successMessage",
        label: "Success message",
      },
      BUTTONS_FIELD,
      { kind: "elementOrder" },
      ...STYLE_FIELDS,
    ],
    reviews: [
      { kind: "text", key: "heading", label: "Heading" },
      {
        kind: "strings",
        key: "reviewOrder",
        label: "Pinned review order",
        hint: "Review event IDs, one per line, most-important first. Other reviews follow.",
      },
      BUTTONS_FIELD,
      { kind: "elementOrder" },
      ...STYLE_FIELDS,
    ],
    social_posts: [
      ...HEADING_FIELDS,
      {
        kind: "records",
        key: "socialPosts",
        label: "Posts",
        addLabel: "Add post",
        titleKey: "caption",
        makeNew: () => ({ platform: "instagram", url: "" }),
        fields: [
          {
            key: "platform",
            label: "Platform",
            kind: "chips",
            options: [
              { value: "instagram", label: "Instagram" },
              { value: "x", label: "X" },
              { value: "facebook", label: "Facebook" },
              { value: "youtube", label: "YouTube" },
              { value: "tiktok", label: "TikTok" },
              { value: "telegram", label: "Telegram" },
              { value: "website", label: "Website" },
              { value: "other", label: "Other" },
            ],
          },
          { key: "url", label: "Post URL", kind: "url" },
          { key: "caption", label: "Caption", kind: "text" },
          { key: "image", label: "Preview image URL", kind: "url" },
          { key: "author", label: "Author handle", kind: "text" },
        ],
      },
      {
        kind: "chips",
        key: "socialPostsLayout",
        label: "Layout",
        options: [
          { value: "grid", label: "Grid" },
          { value: "carousel", label: "Carousel" },
        ],
      },
      {
        kind: "toggle",
        key: "socialPostsAutoplay",
        label: "Auto-advance carousel",
      },
      {
        kind: "number",
        key: "socialPostsSpeed",
        label: "Seconds between slides",
        min: 2,
        max: 30,
      },
      BUTTONS_FIELD,
      { kind: "elementOrder" },
      ...STYLE_FIELDS,
    ],
    blog: [
      ...HEADING_FIELDS,
      BODY_FIELD,
      {
        kind: "chips",
        key: "blogLayout",
        label: "Layout",
        options: [
          { value: "featured", label: "Featured" },
          { value: "grid", label: "Grid" },
          { value: "list", label: "List" },
        ],
      },
      {
        kind: "chips",
        key: "blogPostMode",
        label: "Which posts",
        options: [
          { value: "latest", label: "Latest posts" },
          { value: "selected", label: "Only the listed posts" },
        ],
      },
      {
        kind: "strings",
        key: "blogPostIds",
        label: "Curated post IDs",
        hint: "Blog post ‘d’ tags, one per line. Orders the list; with “Only the listed posts” it also filters.",
      },
      {
        kind: "number",
        key: "blogPostLimit",
        label: "Max posts",
        min: 1,
        max: 24,
      },
      BUTTONS_FIELD,
      { kind: "elementOrder" },
      ...STYLE_FIELDS,
    ],
  };

const PRODUCT_PAGE_SPECS: Partial<Record<StorefrontSectionType, FieldSpec[]>> =
  {
    product_description: [
      { kind: "text", key: "heading", label: "Heading" },
      BUTTONS_FIELD,
      { kind: "elementOrder" },
      ...STYLE_FIELDS,
    ],
    product_specifications: [
      { kind: "text", key: "heading", label: "Heading" },
      {
        kind: "toggle",
        key: "mergeAutoSpecs",
        label: "Merge auto-detected specs",
        description: "Combine these with the specs parsed from the listing.",
      },
      {
        kind: "records",
        key: "specifications",
        label: "Specifications",
        addLabel: "Add specification",
        titleKey: "label",
        makeNew: () => ({ label: "", value: "" }),
        fields: [
          { key: "label", label: "Label", kind: "text" },
          { key: "value", label: "Value", kind: "text" },
        ],
      },
      BUTTONS_FIELD,
      { kind: "elementOrder" },
      ...STYLE_FIELDS,
    ],
    product_shipping_returns: [
      { kind: "text", key: "heading", label: "Heading" },
      {
        kind: "textarea",
        key: "shippingInfo",
        label: "Shipping info",
        hint: "Overrides the computed shipping copy for this section.",
      },
      {
        kind: "textarea",
        key: "returnsInfo",
        label: "Returns info",
      },
      BUTTONS_FIELD,
      { kind: "elementOrder" },
      ...STYLE_FIELDS,
    ],
    product_gallery: [
      { kind: "text", key: "heading", label: "Heading" },
      {
        kind: "toggle",
        key: "useProductImages",
        label: "Include listing photos",
        description: "Prepend the product's own images to the gallery.",
      },
      {
        kind: "strings",
        key: "galleryImages",
        label: "Extra image URLs",
        hint: "One https:// image URL per line.",
      },
      BUTTONS_FIELD,
      { kind: "elementOrder" },
      ...STYLE_FIELDS,
      ...IMAGE_STYLE_FIELDS,
    ],
    related_products: [
      { kind: "text", key: "heading", label: "Heading" },
      {
        kind: "number",
        key: "productLimit",
        label: "Max products",
        min: 1,
        max: 12,
      },
      {
        kind: "toggle",
        key: "excludeCurrentProduct",
        label: "Hide the product being viewed",
      },
      BUTTONS_FIELD,
      { kind: "elementOrder" },
      ...STYLE_FIELDS,
    ],
  };

export const SECTION_FIELD_SPECS: Partial<
  Record<StorefrontSectionType, FieldSpec[]>
> = { ...HOME_AND_PAGE_SPECS, ...PRODUCT_PAGE_SPECS };

export const HOME_SECTION_TYPES: {
  type: StorefrontSectionType;
  label: string;
}[] = [
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
  { type: "banner_carousel", label: "Banner Carousel" },
  { type: "marquee", label: "Scrolling Marquee" },
  { type: "contact", label: "Contact" },
  { type: "contact_form", label: "Contact Form" },
  { type: "reviews", label: "Customer Reviews" },
  { type: "social_posts", label: "Social Posts" },
  { type: "blog", label: "Blog" },
];

export const PRODUCT_PAGE_SECTION_TYPES: {
  type: StorefrontSectionType;
  label: string;
}[] = [
  { type: "product_description", label: "Product Description" },
  { type: "product_specifications", label: "Specifications" },
  { type: "product_shipping_returns", label: "Shipping & Returns" },
  { type: "product_gallery", label: "Gallery" },
  { type: "related_products", label: "Related Products" },
];

export const SECTION_TYPE_LABELS: Record<string, string> = Object.fromEntries(
  [...HOME_SECTION_TYPES, ...PRODUCT_PAGE_SECTION_TYPES].map((entry) => [
    entry.type,
    entry.label,
  ])
);

let sectionCounter = 0;

export function createSectionOfType(
  type: StorefrontSectionType
): StorefrontSection {
  sectionCounter += 1;
  return {
    id: `m-${Date.now().toString(36)}-${sectionCounter}`,
    type,
    enabled: true,
  };
}
