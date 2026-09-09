import { render, screen, fireEvent, waitFor } from "@testing-library/react";
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

  it("ignores fetch failures quietly", async () => {
    (global.fetch as jest.Mock).mockRejectedValue(new Error("offline"));
    render(<UpdateToast />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(
      screen.queryByText(/new version of Milk Market/i)
    ).not.toBeInTheDocument();
  });
});
