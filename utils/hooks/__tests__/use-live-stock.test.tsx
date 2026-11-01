import { act, renderHook, waitFor } from "@testing-library/react";
import {
  resetLiveStockCacheForTests,
  useLiveStock,
  useProductWithLiveStock,
} from "../use-live-stock";

const LISTED_AT = 1_700_000_000;
const fetchMock = jest.fn();

function stockResponse(stock: Record<string, unknown>) {
  return { ok: true, json: async () => ({ success: true, stock }) };
}

beforeEach(() => {
  jest.useFakeTimers();
  resetLiveStockCacheForTests();
  fetchMock.mockReset();
  (global as any).fetch = fetchMock;
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

async function flushBatch() {
  await act(async () => {
    jest.advanceTimersByTime(30);
  });
}

describe("useLiveStock", () => {
  it("returns null until the answer arrives", async () => {
    fetchMock.mockResolvedValue(
      stockResponse({
        a: { default_quantity: 0, variants: {}, default_updated_at: 1 },
      })
    );
    const { result } = renderHook(() => useLiveStock("a"));
    expect(result.current).toBeNull();

    await flushBatch();
    await waitFor(() => expect(result.current?.default_quantity).toBe(0));
  });

  it("sends one request for many cards mounted together", async () => {
    fetchMock.mockResolvedValue(stockResponse({}));
    renderHook(() => {
      useLiveStock("a");
      useLiveStock("b");
      useLiveStock("c");
    });
    await flushBatch();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(decodeURIComponent(fetchMock.mock.calls[0][0])).toBe(
      "/api/inventory?productIds=a,b,c"
    );
  });

  it("splits more than 100 products into several requests", async () => {
    fetchMock.mockResolvedValue(stockResponse({}));
    const ids = Array.from({ length: 101 }, (_, i) => `p${i}`);
    renderHook(() => {
      ids.forEach((id) => useLiveStock(id));
    });
    await flushBatch();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not ask again for a product it already knows", async () => {
    fetchMock.mockResolvedValue(stockResponse({}));
    const first = renderHook(() => useLiveStock("a"));
    await flushBatch();
    first.unmount();

    renderHook(() => useLiveStock("a"));
    await flushBatch();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("asks again once the cached answer is old", async () => {
    fetchMock.mockResolvedValue(stockResponse({}));
    const first = renderHook(() => useLiveStock("a"));
    await flushBatch();
    first.unmount();

    await act(async () => {
      jest.advanceTimersByTime(31_000);
    });
    renderHook(() => useLiveStock("a"));
    await flushBatch();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the previous answer when a refresh fails", async () => {
    fetchMock.mockResolvedValueOnce(
      stockResponse({ a: { default_quantity: 2, variants: {} } })
    );
    const first = renderHook(() => useLiveStock("a"));
    await flushBatch();
    await waitFor(() => expect(first.result.current?.default_quantity).toBe(2));
    first.unmount();

    await act(async () => {
      jest.advanceTimersByTime(31_000);
    });
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    const second = renderHook(() => useLiveStock("a"));
    await flushBatch();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(second.result.current?.default_quantity).toBe(2);
  });

  it("stays null for untracked products and failed requests", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({}) });
    const { result } = renderHook(() => useLiveStock("a"));
    await flushBatch();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(result.current).toBeNull();
  });

  it("does nothing without a product id", async () => {
    renderHook(() => useLiveStock(undefined));
    await flushBatch();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retries a request that never answered after the timeout", async () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    const first = renderHook(() => useLiveStock("a"));
    await flushBatch();
    first.unmount();

    await act(async () => {
      jest.advanceTimersByTime(16_000);
    });
    renderHook(() => useLiveStock("a"));
    await flushBatch();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("useProductWithLiveStock", () => {
  const product = {
    id: "a",
    createdAt: LISTED_AT,
    quantity: 10,
  };

  it("applies newer stock to the product", async () => {
    fetchMock.mockResolvedValue(
      stockResponse({
        a: {
          default_quantity: 1,
          variants: {},
          default_updated_at: LISTED_AT + 5,
        },
      })
    );
    const { result } = renderHook(() => useProductWithLiveStock(product));
    expect(result.current?.quantity).toBe(10);

    await flushBatch();
    await waitFor(() => expect(result.current?.quantity).toBe(1));
  });

  it("ignores stock older than the listing", async () => {
    fetchMock.mockResolvedValue(
      stockResponse({
        a: {
          default_quantity: 1,
          variants: {},
          default_updated_at: LISTED_AT - 5,
        },
      })
    );
    const { result } = renderHook(() => useProductWithLiveStock(product));
    await flushBatch();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(result.current).toBe(product);
  });

  it("passes a missing product straight through", () => {
    const { result } = renderHook(() => useProductWithLiveStock(undefined));
    expect(result.current).toBeUndefined();
  });
});
