import {
  buildSellerListingTags,
  createEmptySellerListingDraft,
  createSellerListingDraftFromEvent,
  normalizeSellerListingDraft,
  validateSellerListingDraft,
} from "../index";

describe("seller listing draft helpers", () => {
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
          ["t", "Milk"],
          ["t", "FREEMILK"],
          ["quantity", "3"],
          ["status", "inactive"],
        ],
      })
    ).toEqual({
      eventId: "listing-event",
      dTag: "listing-d-tag",
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
          quantity: "4",
          status: "active",
        },
      })
    ).toEqual([
      ["d", "listing-d-tag"],
      ["alt", "Product listing: Fresh Beef"],
      [
        "client",
        "Milk Market",
        "31990:seller-pubkey:listing-d-tag",
        "wss://relay.damus.io",
      ],
      ["title", "Fresh Beef"],
      ["summary", "Grass-fed cuts."],
      ["price", "25", "USD"],
      ["location", "Jaipur"],
      ["shipping", "Added Cost/Pickup", "80", "USD"],
      ["status", "active"],
      ["image", "https://example.com/beef.jpg"],
      ["t", "Beef"],
      ["t", "Bundle"],
      ["t", "MilkMarket"],
      ["t", "FREEMILK"],
      ["t", "SAVEBEEF"],
      ["quantity", "4"],
      ["pickup_location", "Farm gate"],
    ]);
  });
});
