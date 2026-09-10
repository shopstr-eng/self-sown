import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
import { renderToString } from "react-dom/server";
import "@testing-library/jest-dom";
import UpdateToast from "../update-toast";

const mockReload = jest.fn();
jest.mock("next/router", () => ({
  useRouter: () => ({ reload: mockReload }),
}));

const setTabBuild = (buildId?: string) => {
  (window as any).__NEXT_DATA__ = buildId ? { buildId } : undefined;
};

const mockVersion = (buildId: string) => {
  (global.fetch as jest.Mock).mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ buildId }),
  });
};

beforeEach(() => {
  global.fetch = jest.fn();
  mockReload.mockClear();
  setTabBuild("build-old");
});

afterEach(() => {
  setTabBuild(undefined);
  Object.defineProperty(document, "visibilityState", {
    value: "visible",
    configurable: true,
  });
});

describe("UpdateToast", () => {
  it("stays hidden when the server is on the same build as the tab", async () => {
    mockVersion("build-old");
    render(<UpdateToast />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(
      screen.queryByText(/new version of Milk Market/i)
    ).not.toBeInTheDocument();
  });

  it("prompts a refresh when a newer build is live", async () => {
    mockVersion("build-new");
    render(<UpdateToast />);
    const prompt = await screen.findByText(/new version of Milk Market/i);
    expect(prompt).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(mockReload).toHaveBeenCalledTimes(1);
  });

  it("dismisses for that build but re-shows if another build ships", async () => {
    mockVersion("build-new");
    render(<UpdateToast />);
    await screen.findByText(/new version of Milk Market/i);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(
      screen.queryByText(/new version of Milk Market/i)
    ).not.toBeInTheDocument();

    // A later check reporting the SAME build stays dismissed…
    fireEvent.focus(window);
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(2));
    expect(
      screen.queryByText(/new version of Milk Market/i)
    ).not.toBeInTheDocument();

    // …but a further update re-prompts.
    mockVersion("build-newer");
    fireEvent.focus(window);
    expect(
      await screen.findByText(/new version of Milk Market/i)
    ).toBeInTheDocument();
  });

  it("never prompts when the server reports a dev build", async () => {
    mockVersion("dev");
    render(<UpdateToast />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(
      screen.queryByText(/new version of Milk Market/i)
    ).not.toBeInTheDocument();
  });

  it("retracts the prompt if the origin switches to a dev server", async () => {
    mockVersion("build-new");
    render(<UpdateToast />);
    await screen.findByText(/new version of Milk Market/i);
    mockVersion("dev");
    fireEvent.focus(window);
    await waitFor(() =>
      expect(
        screen.queryByText(/new version of Milk Market/i)
      ).not.toBeInTheDocument()
    );
  });

  it("renders nothing on the server or the first client render", async () => {
    // SSR output must be empty — the toast can only appear after the client
    // has compared builds, or hydration mismatches.
    const ssrHtml = renderToString(<UpdateToast />);
    expect(ssrHtml).toBe("");

    // First client paint matches the server output even when an update is
    // waiting — the fetch hasn't resolved yet, so nothing can be shown.
    mockVersion("build-new");
    const { container } = render(<UpdateToast />);
    expect(container.innerHTML).toBe(ssrHtml);

    // (Then the async check lands and the prompt appears.)
    expect(
      await screen.findByText(/new version of Milk Market/i)
    ).toBeInTheDocument();
  });

  it("polls on the 60s cadence and removes all listeners on unmount", async () => {
    jest.useFakeTimers();
    try {
      mockVersion("build-old");
      const { unmount } = render(<UpdateToast />);
      await act(async () => {});
      expect(global.fetch).toHaveBeenCalledTimes(1); // initial check

      await act(async () => {
        jest.advanceTimersByTime(59_999);
      });
      expect(global.fetch).toHaveBeenCalledTimes(1);
      await act(async () => {
        jest.advanceTimersByTime(1);
      });
      expect(global.fetch).toHaveBeenCalledTimes(2); // first poll tick

      await act(async () => {
        jest.advanceTimersByTime(60_000);
      });
      expect(global.fetch).toHaveBeenCalledTimes(3);

      unmount();
      await act(async () => {
        jest.advanceTimersByTime(180_000);
      });
      expect(global.fetch).toHaveBeenCalledTimes(3); // interval cleared

      fireEvent.focus(window);
      fireEvent(document, new Event("visibilitychange"));
      expect(global.fetch).toHaveBeenCalledTimes(3); // listeners removed
    } finally {
      jest.useRealTimers();
    }
  });

  it("re-checks on visibilitychange only when the tab becomes visible", async () => {
    mockVersion("build-old");
    render(<UpdateToast />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));

    Object.defineProperty(document, "visibilityState", {
      value: "hidden",
      configurable: true,
    });
    fireEvent(document, new Event("visibilitychange"));
    // Give any (unwanted) check a chance to fire before asserting.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(global.fetch).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, "visibilityState", {
      value: "visible",
      configurable: true,
    });
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(2));
  });

  it("ignores fetch failures quietly", async () => {
    (global.fetch as jest.Mock).mockRejectedValue(new Error("offline"));
    render(<UpdateToast />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(
      screen.queryByText(/new version of Milk Market/i)
    ).not.toBeInTheDocument();
  });
});
