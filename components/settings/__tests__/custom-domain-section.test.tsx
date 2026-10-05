import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

import CustomDomainSection from "../custom-domain-section";
import { ProfileMapContext } from "@/utils/context/context";
import {
  SignerContext,
  NostrContext,
} from "@/components/utility-components/nostr-context-provider";

const PUBKEY = "a".repeat(64);

const VERIFIED_DOMAIN = {
  domain: "creamerydairy.com",
  verified: true,
  domainType: "apex",
  verificationToken: null,
  tlsStatus: "active",
  attachedAt: "2026-01-01T00:00:00Z",
  createdAt: "2026-01-01T00:00:00Z",
  instructions: null,
};

// URL-keyed fetch mock. Individual tests swap in their own nostr-json payload.
let nostrJsonPayload: unknown = { names: {} };
let domainPayload: unknown = null;

const mockFetch = jest.fn((input: any) => {
  const url = String(input);
  const payload = url.includes("/api/storefront/nostr-json")
    ? nostrJsonPayload
    : domainPayload;
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(payload),
  });
});
(global as any).fetch = mockFetch;

// profileContext.isLoading stays true so the NIP-05 auto-sync effect (which
// would need a signer) returns early; these tests cover only address display.
const renderSection = () =>
  render(
    <SignerContext.Provider value={{ signer: null, pubkey: PUBKEY } as any}>
      <NostrContext.Provider value={{ nostr: null } as any}>
        <ProfileMapContext.Provider
          value={
            {
              profileData: new Map(),
              isLoading: true,
              updateProfileData: jest.fn(),
            } as any
          }
        >
          <CustomDomainSection />
        </ProfileMapContext.Provider>
      </NostrContext.Provider>
    </SignerContext.Provider>
  );

beforeEach(() => {
  mockFetch.mockClear();
  nostrJsonPayload = { names: {} };
  domainPayload = null;
});

describe("CustomDomainSection Nostr address display", () => {
  it("shows the address exactly as the live nostr-json endpoint serves it (custom domain)", async () => {
    domainPayload = VERIFIED_DOMAIN;
    // The endpoint inserts the exact username first, then its lowercased alias.
    nostrJsonPayload = {
      names: { FarmShop: PUBKEY, farmshop: PUBKEY },
    };

    renderSection();

    await waitFor(() =>
      expect(screen.getByText("FarmShop@creamerydairy.com")).toBeInTheDocument()
    );

    // The address must come from the endpoint for THIS domain, not be
    // reconstructed client-side from the profile.
    const nip05Call = mockFetch.mock.calls.find(([url]) =>
      String(url).includes("/api/storefront/nostr-json")
    );
    expect(nip05Call).toBeDefined();
    expect(String(nip05Call![0])).toContain("domain=creamerydairy.com");
  });

  it("shows the self-host tenant address on this instance's own host", async () => {
    // Self-host: no custom_domains row, and the bare endpoint resolves the
    // tenant from server config.
    domainPayload = null;
    nostrJsonPayload = { names: { farmer: PUBKEY } };

    renderSection();

    // jsdom's hostname is localhost — the point is the client uses the
    // instance's own host rather than a platform domain.
    await waitFor(() =>
      expect(screen.getByText("farmer@localhost")).toBeInTheDocument()
    );
  });

  it("shows nothing when the endpoint resolves no name (unverified/no domain)", async () => {
    domainPayload = null;
    nostrJsonPayload = { names: {} };

    renderSection();

    // Wait for the domain fetch to settle (connect form appears when there's
    // no stored domain), then confirm no address card rendered.
    await screen.findByText(/Connect Domain/i);
    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/storefront/nostr-json")
      )
    );
    expect(screen.queryByText(/Your Nostr address/i)).not.toBeInTheDocument();
  });
});
