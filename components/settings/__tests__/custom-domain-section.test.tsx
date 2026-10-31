import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
let verifyPayload: unknown = null;

const mockFetch = jest.fn((input: any) => {
  const url = String(input);
  const payload = url.includes("/api/storefront/nostr-json")
    ? nostrJsonPayload
    : url.includes("/api/storefront/verify-domain")
      ? verifyPayload
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
  verifyPayload = null;
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

describe("CustomDomainSection www variant health", () => {
  const WWW_FAIL_RESULT = {
    domain: "creamerydairy.com",
    verified: true,
    tlsStatus: "active",
    observed: { cname: ["self-sown.com"], a: null, txt: null },
    expected: { cnameAnyOf: ["self-sown.com"], txt: null },
    www: {
      applicable: true,
      state: "dns_mismatch",
      resolves: false,
      tlsOk: null,
      tlsReason: null,
      observed: { cname: null, a: null },
    },
    message: "Domain verified!",
  };

  it("warns loudly when an active domain's www variant doesn't point at the platform", async () => {
    domainPayload = VERIFIED_DOMAIN;
    verifyPayload = WWW_FAIL_RESULT;

    renderSection();

    // Live domains keep a check button precisely so this state is visible.
    const checkBtn = await screen.findByRole("button", {
      name: /Check DNS & www/i,
    });
    fireEvent.click(checkBtn);

    await waitFor(() =>
      expect(
        screen.getByText(/www\.creamerydairy\.com does not point to Self-sown/i)
      ).toBeInTheDocument()
    );
  });

  it("confirms when the www variant resolves and its certificate serves", async () => {
    domainPayload = VERIFIED_DOMAIN;
    verifyPayload = {
      ...WWW_FAIL_RESULT,
      www: {
        applicable: true,
        state: "ok",
        resolves: true,
        tlsOk: true,
        tlsReason: null,
        observed: { cname: ["self-sown.com"], a: null },
      },
    };

    renderSection();

    fireEvent.click(
      await screen.findByRole("button", { name: /Check DNS & www/i })
    );

    await waitFor(() =>
      expect(
        screen.getByText(/www\.creamerydairy\.com is live/i)
      ).toBeInTheDocument()
    );
    expect(
      screen.queryByText(/does not point to Self-sown/i)
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/certificate isn.?t attached yet/i)
    ).not.toBeInTheDocument();
  });

  it("distinguishes www DNS-correct-but-certificate-not-attached from missing DNS", async () => {
    domainPayload = VERIFIED_DOMAIN;
    verifyPayload = {
      ...WWW_FAIL_RESULT,
      www: {
        applicable: true,
        state: "certificate",
        resolves: true,
        tlsOk: false,
        tlsReason: "certificate",
        observed: { cname: ["self-sown.com"], a: null },
      },
    };

    renderSection();

    fireEvent.click(
      await screen.findByRole("button", { name: /Check DNS & www/i })
    );

    // The seller must NOT be told to fix DNS — their record is correct; the
    // missing step is the admin attaching the www variant.
    await waitFor(() =>
      expect(
        screen.getByText(/certificate isn.?t attached yet/i)
      ).toBeInTheDocument()
    );
    expect(
      screen.queryByText(/does not point to Self-sown/i)
    ).not.toBeInTheDocument();
  });

  it("treats an unreachable www probe as inconclusive, never as a missing certificate", async () => {
    domainPayload = VERIFIED_DOMAIN;
    verifyPayload = {
      ...WWW_FAIL_RESULT,
      www: {
        applicable: true,
        state: "unreachable",
        resolves: true,
        tlsOk: false,
        tlsReason: "unreachable",
        observed: { cname: ["self-sown.com"], a: null },
      },
    };

    renderSection();

    fireEvent.click(
      await screen.findByRole("button", { name: /Check DNS & www/i })
    );

    await waitFor(() =>
      expect(
        screen.getByText(/Couldn't confirm the www\.creamerydairy\.com certificate just yet/i)
      ).toBeInTheDocument()
    );
    // A timeout/refused probe must NOT send the seller chasing an admin
    // attachment that may already exist.
    expect(
      screen.queryByText(/certificate isn.?t attached yet/i)
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/does not point to Self-sown/i)
    ).not.toBeInTheDocument();
  });

  it("shows no www verdict when the check doesn't apply (subdomain)", async () => {
    domainPayload = { ...VERIFIED_DOMAIN, domain: "shop.creamerydairy.com" };
    verifyPayload = { ...WWW_FAIL_RESULT, domain: "shop.creamerydairy.com", www: null };

    renderSection();

    fireEvent.click(
      await screen.findByRole("button", { name: /Check DNS & www/i })
    );

    // Let the verify fetch settle, then assert neither banner rendered.
    await waitFor(() =>
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/storefront/verify-domain"),
        expect.anything()
      )
    );
    expect(screen.queryByText(/points to Self-sown/i)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/does not point to Self-sown/i)
    ).not.toBeInTheDocument();
  });
});
