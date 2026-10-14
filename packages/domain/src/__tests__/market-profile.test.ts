import {
  derivePaymentPreference,
  isDirectLightningCandidate,
  migrateLegacyDonationKey,
  resolveDonationValue,
  stripLegacyDonationKeys,
} from "../index";

describe("isDirectLightningCandidate", () => {
  it("accepts a normal lightning address", () => {
    expect(isDirectLightningCandidate("seller@getalby.com")).toBe(true);
  });

  it("rejects blank or malformed addresses", () => {
    expect(isDirectLightningCandidate(undefined)).toBe(false);
    expect(isDirectLightningCandidate(null)).toBe(false);
    expect(isDirectLightningCandidate("")).toBe(false);
    expect(isDirectLightningCandidate("   ")).toBe(false);
    expect(isDirectLightningCandidate("not-an-address")).toBe(false);
  });

  it("excludes zeuspay hold-invoice addresses", () => {
    expect(isDirectLightningCandidate("seller@zeuspay.com")).toBe(false);
    expect(isDirectLightningCandidate("Seller@ZEUSPAY.com")).toBe(false);
  });
});

describe("derivePaymentPreference", () => {
  it("prefers lightning when a usable address exists", () => {
    expect(derivePaymentPreference("seller@getalby.com")).toBe("lightning");
  });

  it("falls back to ecash without a usable address", () => {
    expect(derivePaymentPreference(undefined)).toBe("ecash");
    expect(derivePaymentPreference("")).toBe("ecash");
    expect(derivePaymentPreference("seller@zeuspay.com")).toBe("ecash");
  });

  it("returns fiat when Bitcoin is disabled", () => {
    expect(derivePaymentPreference("seller@getalby.com", false)).toBe("fiat");
    expect(derivePaymentPreference(undefined, false)).toBe("fiat");
  });
});

describe("donation key migration", () => {
  it("reads the canonical key first, then legacy keys newest-to-oldest", () => {
    expect(resolveDonationValue({ ss_donation: 5, mm_donation: 9 })).toBe(5);
    expect(resolveDonationValue({ mm_donation: 3 })).toBe(3);
    expect(resolveDonationValue({ shopstr_donation: 7 })).toBe(7);
    expect(resolveDonationValue({ mm_donation: 3, shopstr_donation: 7 })).toBe(
      3
    );
    expect(resolveDonationValue({})).toBe(0);
    expect(resolveDonationValue(null)).toBe(0);
    expect(resolveDonationValue(undefined)).toBe(0);
  });

  it("maps a legacy key onto ss_donation when the canonical key is absent", () => {
    expect(migrateLegacyDonationKey({ mm_donation: 4, name: "farm" })).toEqual({
      ss_donation: 4,
      mm_donation: 4,
      name: "farm",
    });
    expect(migrateLegacyDonationKey({ shopstr_donation: 2 })).toEqual({
      ss_donation: 2,
      shopstr_donation: 2,
    });
  });

  it("prefers mm_donation over shopstr_donation when both are present", () => {
    expect(
      migrateLegacyDonationKey({ mm_donation: 4, shopstr_donation: 9 })
    ).toEqual({ ss_donation: 4, mm_donation: 4, shopstr_donation: 9 });
  });

  it("returns the same object when there is nothing to migrate", () => {
    const canonical = { ss_donation: 5, mm_donation: 9 };
    expect(migrateLegacyDonationKey(canonical)).toBe(canonical);
    const noDonation = { name: "farm" };
    expect(migrateLegacyDonationKey(noDonation)).toBe(noDonation);
    expect(migrateLegacyDonationKey(undefined)).toBeUndefined();
    expect(migrateLegacyDonationKey(null)).toBeNull();
  });

  it("strips both legacy keys in place and keeps the canonical one", () => {
    const content = { ss_donation: 1, mm_donation: 2, shopstr_donation: 3 };
    stripLegacyDonationKeys(content);
    expect(content).toEqual({ ss_donation: 1 });
  });
});
