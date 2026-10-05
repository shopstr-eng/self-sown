/**
 * @jest-environment jsdom
 *
 * Buyer-visible Nostr address (NIP-05) in the storefront footer. The address
 * must be resolved from this host's own /.well-known/nostr.json — the same
 * file Nostr clients verify against — and only rendered when that file names
 * the shop's pubkey (i.e. a verified custom domain / self-host instance).
 * Opt-in via the footer's showNip05 setting; any failure renders nothing.
 */
import "@testing-library/jest-dom";
import { render, screen, waitFor } from "@testing-library/react";
import StorefrontFooterComponent from "@/components/storefront/storefront-footer";
import { StorefrontColorScheme } from "@/utils/types/types";

const SELLER_PUBKEY =
  "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2";

const colors: StorefrontColorScheme = {
  primary: "#005cf8",
  secondary: "#94c8ff",
  accent: "#005cf8",
  background: "#ffffff",
  text: "#2f2f2f",
};

function renderFooter(overrides: Record<string, unknown> = {}) {
  return render(
    <StorefrontFooterComponent
      footer={{ showNip05: true, ...overrides }}
      colors={colors}
      shopName="Goat Co"
      shopSlug="goat-co"
      shopPubkey={SELLER_PUBKEY}
    />
  );
}

function mockNostrJson(body: unknown, ok = true) {
  (global.fetch as jest.Mock).mockResolvedValue({
    ok,
    json: async () => body,
  });
}

describe("StorefrontFooter Nostr address (NIP-05)", () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("shows name@host when the well-known file names the seller", async () => {
    mockNostrJson({ names: { goatco: SELLER_PUBKEY } });
    renderFooter();
    // jsdom hostname is localhost — the address is name@<current host>.
    await waitFor(() =>
      expect(screen.getByText("⚡ goatco@localhost")).toBeInTheDocument()
    );
    expect(global.fetch).toHaveBeenCalledWith("/.well-known/nostr.json");
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
  });

  it("links the address to a Nostr profile viewer for one-click open/zap", async () => {
    mockNostrJson({ names: { goatco: SELLER_PUBKEY } });
    renderFooter();
    const link = await screen.findByRole("link", {
      name: "⚡ goatco@localhost",
    });
    expect(link).toHaveAttribute(
      "href",
      "https://njump.me/goatco%40localhost"
    );
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
    // Copy-to-clipboard still works alongside the link.
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
  });

  it("renders the address as plain text (no link) when it fails URL validation", async () => {
    // A poisoned well-known response whose key matches the seller but can't
    // form a safe viewer href must degrade to the plain-text + copy render.
    mockNostrJson({ names: { 'goatco"onclick="x': SELLER_PUBKEY } });
    renderFooter();
    await waitFor(() =>
      expect(
        screen.getByText('⚡ goatco"onclick="x@localhost')
      ).toBeInTheDocument()
    );
    expect(screen.queryByRole("link", { name: /goatco/ })).toBeNull();
    expect(
      document.querySelector('a[href*="njump.me"]')
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
  });

  it("prefers the exact-case username over its lower-cased alias", async () => {
    mockNostrJson({
      names: { GoatCo: SELLER_PUBKEY, goatco: SELLER_PUBKEY },
    });
    renderFooter();
    await waitFor(() =>
      expect(screen.getByText("⚡ GoatCo@localhost")).toBeInTheDocument()
    );
  });

  it("matches the seller's pubkey case-insensitively", async () => {
    mockNostrJson({ names: { goatco: SELLER_PUBKEY.toUpperCase() } });
    renderFooter();
    await waitFor(() =>
      expect(screen.getByText("⚡ goatco@localhost")).toBeInTheDocument()
    );
  });

  it("renders nothing when the well-known file names a different pubkey (platform host)", async () => {
    mockNostrJson({
      names: {
        selfsown:
          "76fcec0e0638351f1d0e0dc4ebaf6dd3d67404126d664547674070f3175273d9",
      },
    });
    const { container } = renderFooter();
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(container.textContent).not.toContain("@");
  });

  it("renders nothing and never fetches when the setting is off (opt-in)", () => {
    renderFooter({ showNip05: false });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
  });

  it("renders nothing when the well-known fetch fails", async () => {
    (global.fetch as jest.Mock).mockRejectedValue(new Error("network down"));
    const { container } = renderFooter();
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect(container.querySelector("button")).toBeNull();
  });
});
