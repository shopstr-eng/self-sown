jest.mock("../../apps/mobile/node_modules/react", () =>
  jest.requireActual("react")
);
import { act, renderHook, waitFor } from "@testing-library/react";
import type { SellerOrder, SellerSession } from "@self-sown/domain";
import { useReturnLabels } from "../../apps/mobile/hooks/use-return-labels";
import { useOrderShipping } from "../../apps/mobile/hooks/use-order-shipping";
import {
  loadSellerShipping,
  buySellerReturnLabel,
  listSellerOrderLabels,
} from "../../apps/mobile/lib/shipping-runtime";
jest.mock("../../apps/mobile/lib/shipping-runtime", () => ({
  loadSellerShipping: jest.fn(),
  buySellerReturnLabel: jest.fn(),
  listSellerOrderLabels: jest.fn(),
}));
const session = { pubkey: "a".repeat(64) } as SellerSession;
const order = {
  orderId: "order-1",
  status: "shipped",
  productAddress: "",
  address: "Buyer, 10 Buyer St, Austin, TX, 78701, US",
} as SellerOrder;
const label = {
  id: 1,
  shipmentId: "return-1",
  orderId: order.orderId,
  isReturn: true,
  carrier: "USPS",
  trackingCode: "RETURN",
};
const defaults = {
  fromStreet1: "1 Farm Rd",
  fromCity: "Austin",
  fromState: "TX",
  fromZip: "78702",
  fromCountry: "US",
  preferredCarriers: ["USPS"],
};
const options = {
  session,
  order,
  from: {
    street1: "10 Buyer St",
    city: "Austin",
    state: "TX",
    postalCode: "78701",
    country: "US",
  },
  parcel: { weightOz: 16 },
};
beforeEach(() => {
  jest.resetAllMocks();
  jest.mocked(loadSellerShipping).mockResolvedValue({
    connection: { configured: true, connected: true, accountId: "seller" },
    defaults,
    labels: [],
  } as any);
  jest.mocked(buySellerReturnLabel).mockResolvedValue(label as any);
  jest.mocked(listSellerOrderLabels).mockResolvedValue([]);
});
test("double submit buys once and preserves the result if history refresh fails", async () => {
  let finish!: (value: any) => void;
  jest.mocked(buySellerReturnLabel).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  const { result } = renderHook(() => useReturnLabels(options));
  await waitFor(() => expect(result.current.ready).toBe(true));
  let purchase!: Promise<void>;
  act(() => {
    purchase = result.current.purchase();
    void result.current.purchase();
  });
  expect(buySellerReturnLabel).toHaveBeenCalledTimes(1);
  jest.mocked(loadSellerShipping).mockRejectedValueOnce(new Error("offline"));
  await act(async () => {
    finish(label);
    await purchase;
  });
  expect(result.current.labels).toEqual([label]);
});
test("missing defaults blocks purchase until settings are refreshed", async () => {
  jest.mocked(loadSellerShipping).mockResolvedValueOnce({
    connection: { configured: true, connected: true },
    defaults: null,
    labels: [],
  } as any);
  const { result } = renderHook(() => useReturnLabels(options));
  await waitFor(() => expect(result.current.issue).toMatch(/address/i));
  await act(() => result.current.purchase());
  expect(buySellerReturnLabel).not.toHaveBeenCalled();
  await act(() => result.current.refresh());
  expect(result.current.ready).toBe(true);
});
test("a rejected purchase displays the error and permits a deliberate retry", async () => {
  jest
    .mocked(buySellerReturnLabel)
    .mockRejectedValueOnce(new Error("No carrier rates available"));
  const { result } = renderHook(() => useReturnLabels(options));
  await waitFor(() => expect(result.current.ready).toBe(true));
  await act(() => result.current.purchase());
  expect(result.current.error).toMatch(/No carrier rates/);
  await act(() => result.current.purchase());
  expect(buySellerReturnLabel).toHaveBeenCalledTimes(2);
});
test("outbound tracking ignores newer return labels", async () => {
  const onTrackingDetails = jest.fn();
  jest
    .mocked(listSellerOrderLabels)
    .mockResolvedValue([
      label,
      { ...label, id: 2, isReturn: false, trackingCode: "OUTBOUND" },
    ] as any);
  renderHook(() => useOrderShipping({ session, order, onTrackingDetails }));
  await waitFor(() =>
    expect(onTrackingDetails).toHaveBeenCalledWith({
      carrier: "USPS",
      tracking: "OUTBOUND",
      purchased: false,
    })
  );
});
test("an unmounted purchase cannot refill private label state", async () => {
  let finish!: (value: any) => void;
  jest.mocked(buySellerReturnLabel).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  const { result, unmount } = renderHook(() => useReturnLabels(options));
  await waitFor(() => expect(result.current.ready).toBe(true));
  let purchase!: Promise<void>;
  act(() => {
    purchase = result.current.purchase();
  });
  unmount();
  await act(async () => {
    finish(label);
    await purchase;
  });
  expect(loadSellerShipping).toHaveBeenCalledTimes(1);
});
