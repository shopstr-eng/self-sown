import {
  buildSellerListingTags,
  createEmptySellerListingDraft,
  createSellerListingDraftFromEvent,
  normalizeSellerListingDraft,
  validateSellerListingDraft,
  type SellerListingDraft,
} from "../index";

describe("seller listing draft helpers", () => {
  test("normalizes a Postgres bigint timestamp before editing a cached listing", () => {
    const cachedEvent = JSON.parse(
      JSON.stringify({
        id: "cached-listing",
        pubkey: "seller",
        kind: 30402,
        created_at: "1710000000",
        content: "",
        sig: "signature",
        tags: [
          ["d", "milk"],
          ["title", "Milk"],
        ],
      })
    );
    const draft = createSellerListingDraftFromEvent(cachedEvent);
    expect(draft?.sourceCreatedAt).toBe(1710000000);
    expect((draft?.sourceCreatedAt ?? 0) + 1).toBe(1710000001);
  });

  test("creates an empty seller listing draft", () => {
    expect(createEmptySellerListingDraft()).toEqual({
      title: "",
      description: "",
      images: [],
      price: "",
      currency: "USD",
      categories: [],
      location: "",
      shippingType: "Free",
      shippingCost: "",
      pickupLocations: [],
      shipFromPostalCode: "",
      shipFromCountry: "US",
      packageWeightOz: "",
      packageLengthIn: "",
      packageWidthIn: "",
      packageHeightIn: "",
      handlingTimeDays: "",
      quantity: "",
      status: "active",
    });
  });

  test("validates required fields and pickup requirements", () => {
    expect(
      validateSellerListingDraft({
        title: "",
        description: "",
        images: [],
        price: "0",
        currency: "",
        categories: [],
        location: "",
        shippingType: "Added Cost/Pickup",
        shippingCost: "-1",
        pickupLocations: [],
        shipFromPostalCode: "",
        shipFromCountry: "US",
        packageWeightOz: "",
        packageLengthIn: "",
        packageWidthIn: "",
        packageHeightIn: "",
        handlingTimeDays: "",
        quantity: "1.5",
        status: "active",
      })
    ).toEqual({
      title: "Listing title is required.",
      description: "Listing description is required.",
      images: "Add at least one listing image.",
      price: "Enter a valid listing price.",
      currency: "Enter a valid currency code.",
      categories: "Add at least one category tag.",
      location: "Location is required.",
      shippingCost: "Enter a valid shipping cost.",
      pickupLocations: "Add at least one pickup location.",
      quantity: "Quantity must be a whole number.",
    });
  });

  test("normalizes numbers, categories, and pickup values", () => {
    expect(
      normalizeSellerListingDraft({
        title: "  Fresh Milk  ",
        description: "  A2 milk  ",
        images: ["https://example.com/a.jpg", " ", "https://example.com/a.jpg"],
        price: "12.50",
        currency: " usd ",
        categories: ["Milk", " Local ", "Milk"],
        location: "  Jaipur ",
        shippingType: "Added Cost/Pickup",
        shippingCost: "40",
        pickupLocations: [" Farm gate ", "", "Farm gate"],
        shipFromPostalCode: " 78701 ",
        shipFromCountry: " us ",
        packageWeightOz: "16",
        packageLengthIn: "10",
        packageWidthIn: "8",
        packageHeightIn: "4",
        handlingTimeDays: "2",
        quantity: "5",
        status: "inactive",
      })
    ).toEqual({
      title: "Fresh Milk",
      description: "A2 milk",
      images: ["https://example.com/a.jpg"],
      price: 12.5,
      currency: "USD",
      categories: ["Milk", "Local"],
      location: "Jaipur",
      shippingType: "Added Cost/Pickup",
      shippingCost: 40,
      pickupLocations: ["Farm gate"],
      shipFromPostalCode: "78701",
      shipFromCountry: "US",
      parcel: { weightOz: 16, lengthIn: 10, widthIn: 8, heightIn: 4 },
      handlingTimeDays: 2,
      quantity: 5,
      status: "inactive",
    });
  });

  test("creates an editable draft from a cached product event", () => {
    expect(
      createSellerListingDraftFromEvent({
        id: "listing-event",
        pubkey: "seller-pubkey",
        created_at: 1710000000,
        kind: 30402,
        content: "",
        tags: [
          ["d", "listing-d-tag"],
          ["title", "Creamline Milk"],
          ["summary", "Daily raw milk."],
          ["image", "https://example.com/milk.jpg"],
          ["price", "14", "USD"],
          ["location", "Jaipur"],
          ["shipping", "Pickup", "0", "USD"],
          ["pickup_location", "Farm gate"],
          ["ship_from_zip", "78701", "US"],
          ["parcel", "16", "10", "8", "4"],
          ["handling_time", "2"],
          ["t", "Milk"],
          ["t", "FREEMILK"],
          ["quantity", "3"],
          ["status", "inactive"],
        ],
      })
    ).toEqual({
      eventId: "listing-event",
      dTag: "listing-d-tag",
      sourceCreatedAt: 1710000000,
      sourceTags: [
        ["d", "listing-d-tag"],
        ["title", "Creamline Milk"],
        ["summary", "Daily raw milk."],
        ["image", "https://example.com/milk.jpg"],
        ["price", "14", "USD"],
        ["location", "Jaipur"],
        ["shipping", "Pickup", "0", "USD"],
        ["pickup_location", "Farm gate"],
        ["ship_from_zip", "78701", "US"],
        ["parcel", "16", "10", "8", "4"],
        ["handling_time", "2"],
        ["t", "Milk"],
        ["t", "FREEMILK"],
        ["quantity", "3"],
        ["status", "inactive"],
      ],
      title: "Creamline Milk",
      description: "Daily raw milk.",
      images: ["https://example.com/milk.jpg"],
      price: "14",
      currency: "USD",
      categories: ["Milk"],
      location: "Jaipur",
      shippingType: "Pickup",
      shippingCost: "0",
      pickupLocations: ["Farm gate"],
      shipFromPostalCode: "78701",
      shipFromCountry: "US",
      packageWeightOz: "16",
      packageLengthIn: "10",
      packageWidthIn: "8",
      packageHeightIn: "4",
      handlingTimeDays: "2",
      quantity: "3",
      status: "inactive",
    });
  });

  test("builds parser-compatible listing tags from the mobile draft", () => {
    expect(
      buildSellerListingTags({
        pubkey: "seller-pubkey",
        dTag: "listing-d-tag",
        relayHint: "wss://relay.damus.io",
        draft: {
          title: "Fresh Beef",
          description: "Grass-fed cuts.",
          images: ["https://example.com/beef.jpg"],
          price: "25",
          currency: "usd",
          categories: ["Beef", "Bundle"],
          location: "Jaipur",
          shippingType: "Added Cost/Pickup",
          shippingCost: "80",
          pickupLocations: ["Farm gate"],
          shipFromPostalCode: "78701",
          shipFromCountry: "US",
          packageWeightOz: "16",
          packageLengthIn: "10",
          packageWidthIn: "8",
          packageHeightIn: "4",
          handlingTimeDays: "2",
          quantity: "4",
          status: "active",
        },
      })
    ).toEqual([
      ["d", "listing-d-tag"],
      ["alt", "Product listing: Fresh Beef"],
      [
        "client",
        "Self-sown",
        "31990:seller-pubkey:listing-d-tag",
        "wss://relay.damus.io",
      ],
      ["title", "Fresh Beef"],
      ["summary", "Grass-fed cuts."],
      ["price", "25", "USD"],
      ["location", "Jaipur"],
      ["shipping", "Added Cost/Pickup", "80", "USD"],
      ["status", "active"],
      ["ship_from_zip", "78701", "US"],
      ["parcel", "16", "10", "8", "4"],
      ["handling_time", "2"],
      ["image", "https://example.com/beef.jpg"],
      ["t", "Beef"],
      ["t", "Bundle"],
      ["t", "SelfSown"],
      ["t", "FREEMILK"],
      ["t", "SAVEBEEF"],
      ["quantity", "4"],
      ["pickup_location", "Farm gate"],
    ]);
  });

  test("preserves web-only tags while replacing mobile-editable tags", () => {
    const originalTags = [
      ["d", "stable-d-tag"],
      ["title", "Old title"],
      ["status", "active"],
      ["subscription", "true"],
      ["subscription_default", "false"],
      ["subscription_discount", "10"],
      ["subscription_frequency", "weekly", "monthly"],
      ["variant", "Small"],
      ["variant_price", "Small", "12"],
      ["bulk_price", "4", "40"],
      ["ship_from_zip", "78701", "US"],
      ["package_weight_oz", "16"],
      ["herdshare_agreement", "https://example.com/agreement"],
      ["lab_report", "https://example.com/report.pdf", "Lab report"],
      ["page_config", '{"layout":"story"}'],
    ];
    const draft = createSellerListingDraftFromEvent({
      id: "old-event",
      pubkey: "seller-pubkey",
      created_at: 1710000000,
      kind: 30402,
      content: "",
      tags: originalTags,
    });

    expect(draft).not.toBeNull();
    const tags = buildSellerListingTags({
      pubkey: "seller-pubkey",
      dTag: "stable-d-tag",
      draft: {
        ...draft!,
        title: "New title",
        description: "Updated from mobile.",
        images: ["https://example.com/new.jpg"],
        price: "15",
        currency: "USD",
        categories: ["Local"],
        location: "Austin",
        shippingType: "Free",
        shippingCost: "",
        pickupLocations: [],
        shipFromPostalCode: draft!.shipFromPostalCode,
        shipFromCountry: draft!.shipFromCountry,
        packageWeightOz: draft!.packageWeightOz,
        packageLengthIn: draft!.packageLengthIn,
        packageWidthIn: draft!.packageWidthIn,
        packageHeightIn: draft!.packageHeightIn,
        handlingTimeDays: draft!.handlingTimeDays,
        quantity: "2",
        status: "inactive",
      },
    });

    for (const tag of originalTags.slice(3)) {
      expect(tags).toContainEqual(tag);
    }
    expect(tags).toContainEqual(["title", "New title"]);
    expect(tags).toContainEqual(["status", "inactive"]);
    expect(tags).not.toContainEqual(["title", "Old title"]);
    expect(tags).not.toContainEqual(["status", "active"]);
  });

  test("rejects invalid shipping metadata without requiring it", () => {
    const base = createEmptySellerListingDraft();
    expect(
      validateSellerListingDraft({
        ...base,
        title: "Milk",
        description: "Fresh milk",
        images: ["https://example.com/milk.jpg"],
        price: "12",
        categories: ["Milk"],
        location: "Austin",
        packageWeightOz: "0",
        packageLengthIn: "10",
        handlingTimeDays: "1.5",
      })
    ).toMatchObject({
      packageWeightOz: "Package weight must be greater than zero.",
      handlingTimeDays: "Handling time must be a whole number of days.",
    });
  });

  test.each(["30406", "30405"])(
    "preserves web-managed shipping for %s references during mobile edits",
    (kind) => {
      const shippingTags = [
        ["shipping_option", `${kind}:${"a".repeat(64)}:standard`, "2"],
        ["shipping", "Added Cost/Pickup", "7.50", "EUR"],
        ["pickup_location", "Farm gate"],
        ["ships_to", "US"],
      ];
      const draft = createSellerListingDraftFromEvent({
        id: "web-listing",
        pubkey: "a".repeat(64),
        kind: 30402,
        created_at: 1710000000,
        content: "",
        tags: [["d", "milk"], ["title", "Milk"], ...shippingTags],
      })!;
      const tags = buildSellerListingTags({
        pubkey: "a".repeat(64),
        dTag: "milk",
        draft: {
          ...draft,
          title: "Updated milk",
          shippingType: "Free",
          shippingCost: "0",
          pickupLocations: [],
          packageWeightOz: "32",
        },
      });
      expect(
        tags.filter((tag) => shippingTags.some(([key]) => tag[0] === key))
      ).toEqual(shippingTags);
      expect(tags).toContainEqual(["title", "Updated milk"]);
      expect(tags).toContainEqual(["parcel", "32"]);
    }
  );

  test("allows unrelated edits when web-managed shipping has no legacy pickup location", () => {
    const draft: SellerListingDraft = {
      ...createEmptySellerListingDraft(),
      title: "Milk",
      description: "Fresh milk",
      images: ["https://example.com/milk.jpg"],
      price: "12",
      categories: ["Milk"],
      location: "Austin",
      shippingType: "Pickup" as const,
      sourceTags: [["shipping_option", `30406:${"a".repeat(64)}:pickup`]],
    };
    expect(validateSellerListingDraft(draft)).toEqual({});
    const tags = buildSellerListingTags({
      draft,
      pubkey: "a".repeat(64),
      dTag: "milk",
    });
    expect(
      tags.some(([key]) => key === "shipping" || key === "pickup_location")
    ).toBe(false);
  });
});
