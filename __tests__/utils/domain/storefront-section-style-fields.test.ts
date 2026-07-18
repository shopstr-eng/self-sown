import { parseSellerShopProfileEvent } from "@milk-market/domain";

const PUBKEY = "a".repeat(64);

const STYLE_FIELDS = {
  backgroundColor: "#112233",
  textColor: "#ffffff",
  textAlign: "center",
  contentWidth: "full",
  imageHeight: "tall",
  imageFit: "contain",
};

const INVALID_ENUMS = {
  textAlign: "justify",
  contentWidth: "huge",
  imageHeight: "gigantic",
  imageFit: "stretch",
};

function profileEvent(storefront: unknown) {
  return {
    id: "e".repeat(64),
    pubkey: PUBKEY,
    kind: 30019,
    created_at: 1_700_000_000,
    tags: [["d", "shop"]],
    sig: "f".repeat(128),
    content: JSON.stringify({
      name: "Green Valley Farm",
      about: "Raw milk.",
      storefront,
    }),
  };
}

describe("storefront section layout/style fields survive sanitization", () => {
  test("homepage sections round-trip all six style fields", () => {
    const parsed = parseSellerShopProfileEvent(
      profileEvent({
        enabled: true,
        sections: [
          { id: "s1", type: "text", heading: "Band", ...STYLE_FIELDS },
        ],
      })
    );
    const section = parsed!.content.storefront!.sections![0]!;
    expect(section).toMatchObject(STYLE_FIELDS);
  });

  test("custom builder pages round-trip all six style fields", () => {
    const parsed = parseSellerShopProfileEvent(
      profileEvent({
        enabled: true,
        pages: [
          {
            id: "p1",
            title: "Our Story",
            slug: "our-story",
            sections: [
              { id: "s1", type: "text", heading: "Band", ...STYLE_FIELDS },
            ],
          },
        ],
      })
    );
    const section = parsed!.content.storefront!.pages![0]!.sections[0]!;
    expect(section).toMatchObject(STYLE_FIELDS);
  });

  test("invalid enum values are dropped on both surfaces", () => {
    const parsed = parseSellerShopProfileEvent(
      profileEvent({
        enabled: true,
        sections: [{ id: "s1", type: "text", ...INVALID_ENUMS }],
        pages: [
          {
            id: "p1",
            title: "Our Story",
            slug: "our-story",
            sections: [{ id: "s1", type: "text", ...INVALID_ENUMS }],
          },
        ],
      })
    );
    for (const section of [
      parsed!.content.storefront!.sections![0]!,
      parsed!.content.storefront!.pages![0]!.sections[0]!,
    ]) {
      expect(section.textAlign).toBeUndefined();
      expect(section.contentWidth).toBeUndefined();
      expect(section.imageHeight).toBeUndefined();
      expect(section.imageFit).toBeUndefined();
    }
  });
});

const LAYOUT_FIELDS = {
  elementOrder: ["image", "heading", "body", "buttons"],
  imagePlacement: "background",
  headingSize: "xl",
  bodySize: "sm",
  imageWidth: 50,
  buttons: [
    {
      label: "Order Now",
      href: "https://example.com/order",
      variant: "primary",
      size: "lg",
      align: "center",
    },
  ],
};

describe("storefront section element-layout fields survive sanitization", () => {
  test("homepage + blogPage + custom-page sections round-trip layout fields", () => {
    const section = { id: "s1", type: "about", ...LAYOUT_FIELDS };
    const parsed = parseSellerShopProfileEvent(
      profileEvent({
        enabled: true,
        sections: [section],
        blogPage: { sections: [section] },
        pages: [
          {
            id: "p1",
            title: "Our Story",
            slug: "our-story",
            sections: [section],
          },
        ],
      })
    );
    const sf = parsed!.content.storefront!;
    for (const out of [
      sf.sections![0]!,
      sf.blogPage!.sections[0]!,
      sf.pages![0]!.sections[0]!,
    ]) {
      expect(out).toMatchObject(LAYOUT_FIELDS);
    }
  });

  test("invalid tokens/enums/widths are dropped, valid ones kept", () => {
    const parsed = parseSellerShopProfileEvent(
      profileEvent({
        enabled: true,
        sections: [
          {
            id: "s1",
            type: "about",
            elementOrder: ["heading", "sidebar", "heading", "image", 3],
            imagePlacement: "diagonal",
            headingSize: "huge",
            bodySize: "xs",
            imageWidth: 42,
            buttons: [
              {
                label: "Ok",
                href: "https://x.com",
                variant: "ghost",
                size: "xxl",
                align: "justify",
              },
              { href: "https://no-label.com" },
              "junk",
            ],
          },
        ],
      })
    );
    const out = parsed!.content.storefront!.sections![0]!;
    expect(out.elementOrder).toEqual(["heading", "image"]);
    expect(out.imagePlacement).toBeUndefined();
    expect(out.headingSize).toBeUndefined();
    expect(out.bodySize).toBeUndefined();
    expect(out.imageWidth).toBeUndefined();
    expect(out.buttons).toEqual([{ label: "Ok", href: "https://x.com" }]);
  });

  test("empty elementOrder/buttons arrays are omitted (byte-size hygiene)", () => {
    const parsed = parseSellerShopProfileEvent(
      profileEvent({
        enabled: true,
        sections: [{ id: "s1", type: "text", elementOrder: [], buttons: [] }],
      })
    );
    const out = parsed!.content.storefront!.sections![0]!;
    expect("elementOrder" in out).toBe(false);
    expect("buttons" in out).toBe(false);
  });
});
