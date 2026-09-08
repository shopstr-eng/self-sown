/** @jest-environment node */
import {
  buyReturnLabel,
  isDefinitiveShippoPurchaseFailure,
} from "@/utils/shipping/shippo";
const originalFetch = global.fetch;
const args = {
  from: {
    street1: "Buyer St",
    city: "Austin",
    state: "TX",
    zip: "78701",
    country: "US",
  },
  to: {
    street1: "Seller St",
    city: "Austin",
    state: "TX",
    zip: "78702",
    country: "US",
  },
  parcel: { weightOz: 16 },
};
afterEach(() => {
  global.fetch = originalFetch;
});
test("failure creating a return shipment is safe to retry because no purchase was sent", async () => {
  global.fetch = jest.fn().mockRejectedValue(new Error("network timeout"));
  const error = await buyReturnLabel("oauth.test", args).catch(
    (error) => error
  );
  expect(isDefinitiveShippoPurchaseFailure(error)).toBe(true);
  expect(global.fetch).toHaveBeenCalledTimes(1);
});
test("no available rates is a definitive failure", async () => {
  global.fetch = jest
    .fn()
    .mockResolvedValue(
      new Response(JSON.stringify({ object_id: "ship1", rates: [] }))
    );
  const error = await buyReturnLabel("oauth.test", args).catch(
    (error) => error
  );
  expect(isDefinitiveShippoPurchaseFailure(error)).toBe(true);
});
test("a timeout after requesting a transaction stays uncertain", async () => {
  global.fetch = jest
    .fn()
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          object_id: "ship1",
          rates: [{ object_id: "rate1", amount: "5", provider: "USPS" }],
        })
      )
    )
    .mockRejectedValueOnce(new Error("network timeout"));
  const error = await buyReturnLabel("oauth.test", args).catch(
    (error) => error
  );
  expect(isDefinitiveShippoPurchaseFailure(error)).toBe(false);
  expect(global.fetch).toHaveBeenCalledTimes(2);
});
