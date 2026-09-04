import { trackEvent } from "@/utils/analytics";

describe("trackEvent", () => {
  afterEach(() => {
    delete (window as any).umami;
  });

  it("is a safe no-op when the tracker is absent (dev / pre-publish)", () => {
    expect(() =>
      trackEvent("order_completed", { method: "stripe" })
    ).not.toThrow();
  });

  it("forwards the event name and data to the injected tracker", () => {
    const track = jest.fn();
    (window as any).umami = { track };
    trackEvent("checkout_started", { method: "cashu", surface: "cart" });
    expect(track).toHaveBeenCalledWith("checkout_started", {
      method: "cashu",
      surface: "cart",
    });
  });

  it("swallows tracker errors so analytics can never break the app", () => {
    (window as any).umami = {
      track: () => {
        throw new Error("tracker blew up");
      },
    };
    expect(() => trackEvent("product_view", { product: "abc" })).not.toThrow();
  });
});
