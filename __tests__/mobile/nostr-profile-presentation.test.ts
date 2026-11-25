import { getNostrProfilePresentation } from "@/apps/mobile/lib/nostr-profile-presentation";

describe("getNostrProfilePresentation", () => {
  it("uses the Nostr display name and picture when set", () => {
    expect(
      getNostrProfilePresentation({
        display_name: "  Orchard Seller  ",
        name: "seller-handle",
        picture: "https://images.example/profile.jpg",
      })
    ).toEqual({
      displayName: "Orchard Seller",
      pictureUrl: "https://images.example/profile.jpg",
    });
  });

  it("falls back to the Nostr name when display_name is not set", () => {
    expect(
      getNostrProfilePresentation({
        name: "seller-handle",
        picture: "https://images.example/profile.jpg",
      })
    ).toEqual({
      displayName: "seller-handle",
      pictureUrl: "https://images.example/profile.jpg",
    });
  });

  it("omits missing or unsafe profile fields", () => {
    expect(
      getNostrProfilePresentation({
        display_name: "Seller",
        picture: "javascript:alert(1)",
      })
    ).toEqual({ displayName: "Seller", pictureUrl: "" });
    expect(getNostrProfilePresentation(null)).toEqual({
      displayName: "",
      pictureUrl: "",
    });
  });
});
