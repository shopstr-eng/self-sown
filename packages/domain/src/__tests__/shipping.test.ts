import {
  isSafeShippingUrl,
  normalizeSellerShippingAddress,
  normalizeSellerParcel,
  parseSellerOrderAddress,
} from "../index";

describe("seller shipping helpers", () => {
  test("parses the six-part order address used by checkout", () => {
    expect(
      parseSellerOrderAddress(
        "Ada Lovelace, 12 Market St, Austin, TX, 78701, US"
      )
    ).toEqual({
      name: "Ada Lovelace",
      street1: "12 Market St",
      city: "Austin",
      state: "TX",
      postalCode: "78701",
      country: "US",
    });
  });

  test("parses an order address containing a second street line", () => {
    expect(
      parseSellerOrderAddress(
        "Ada Lovelace, 12 Market St, Apt 4, Austin, TX, 78701, USA"
      )
    ).toEqual({
      name: "Ada Lovelace",
      street1: "12 Market St",
      street2: "Apt 4",
      city: "Austin",
      state: "TX",
      postalCode: "78701",
      country: "US",
    });
  });

  test.each([
    "",
    "not, enough, address",
    "Ada, 12 Market St, Austin, TX, 78701, CA",
    "Ada, 12 Market St, Aus\ntin, TX, 78701, US",
  ])("rejects an unusable outbound address: %p", (value) => {
    expect(parseSellerOrderAddress(value)).toBeNull();
  });

  test("normalizes a direct shipping address", () => {
    expect(
      normalizeSellerShippingAddress({
        name: " Ada Lovelace ",
        street1: " 12 Market St ",
        street2: " ",
        city: " Austin ",
        state: " TX ",
        postalCode: " 78701 ",
        country: "usa",
      })
    ).toEqual({
      name: "Ada Lovelace",
      street1: "12 Market St",
      city: "Austin",
      state: "TX",
      postalCode: "78701",
      country: "US",
    });
  });

  test.each([
    {
      street1: "",
      city: "Austin",
      state: "TX",
      postalCode: "78701",
      country: "US",
    },
    {
      street1: "12 Market St",
      city: "Austin",
      state: "TX",
      postalCode: "78701",
      country: "CA",
    },
    {
      street1: "12\nMarket St",
      city: "Austin",
      state: "TX",
      postalCode: "78701",
      country: "US",
    },
    {
      street1: "x".repeat(257),
      city: "Austin",
      state: "TX",
      postalCode: "78701",
      country: "US",
    },
  ])("rejects an invalid direct shipping address: %p", (value) => {
    expect(normalizeSellerShippingAddress(value)).toBeNull();
  });

  test("normalizes a positive parcel and omits empty dimensions", () => {
    expect(
      normalizeSellerParcel({
        weightOz: " 16 ",
        lengthIn: "10",
        widthIn: "",
        heightIn: undefined,
      })
    ).toEqual({ weightOz: 16, lengthIn: 10 });
  });

  test.each([
    { weightOz: "" },
    { weightOz: "0" },
    { weightOz: "NaN" },
    { weightOz: "16", lengthIn: "-1" },
    { weightOz: "16", widthIn: Number.POSITIVE_INFINITY },
    { weightOz: "16", heightIn: 10_001 },
    { weightOz: 1_000_001 },
  ])("rejects an invalid parcel: %p", (value) => {
    expect(normalizeSellerParcel(value)).toBeNull();
  });

  test.each([
    "https://deliver.goshippo.com/label.pdf",
    "https://tools.usps.com/go/TrackConfirmAction?tLabels=123",
  ])("accepts an HTTPS provider URL: %p", (value) => {
    expect(isSafeShippingUrl(value)).toBe(true);
  });

  test.each([
    "http://deliver.goshippo.com/label.pdf",
    "javascript:alert(1)",
    "data:text/html,bad",
    "https://user:pass@example.com/label.pdf",
    "not a url",
  ])("rejects an unsafe provider URL: %p", (value) => {
    expect(isSafeShippingUrl(value)).toBe(false);
  });
});
