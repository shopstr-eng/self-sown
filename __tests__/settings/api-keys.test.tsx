import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import ApiKeysPage from "@/pages/settings/api-keys";
import { SignerContext } from "@/components/utility-components/nostr-context-provider";
import {
  buildApiKeysListProof,
  buildMcpRequestProofTemplate,
  MCP_SIGNED_EVENT_HEADER,
} from "@/utils/mcp/request-proof";

let mockIsPro = true;

jest.mock("@/components/utility-components/pro-membership-context", () => ({
  useProMembership: () => ({ membership: { isPro: mockIsPro } }),
}));

jest.mock("next/router", () => ({
  useRouter: () => ({
    replace: jest.fn(),
    push: jest.fn(),
  }),
}));

jest.mock("@/components/settings/settings-bread-crumbs", () => ({
  SettingsBreadCrumbs: () => <div data-testid="breadcrumbs" />,
}));

jest.mock("@heroui/react", () => ({
  useDisclosure: () => ({
    isOpen: false,
    onOpen: jest.fn(),
    onClose: jest.fn(),
  }),
  Button: ({ children, onClick, isDisabled, type }: any) => (
    <button disabled={isDisabled} onClick={onClick} type={type || "button"}>
      {children}
    </button>
  ),
  Input: ({ value, onValueChange, label }: any) => (
    <label>
      {label}
      <input
        aria-label={label}
        value={value}
        onChange={(event) => onValueChange?.(event.target.value)}
      />
    </label>
  ),
  Select: ({ children, label, selectedKeys, onChange }: any) => {
    const selectedValue = String(Array.from(selectedKeys || [])[0] || "read");
    return (
      <label>
        {label}
        <select aria-label={label} value={selectedValue} onChange={onChange}>
          {children}
        </select>
      </label>
    );
  },
  SelectItem: ({ children, value }: any) => (
    <option value={value}>{children}</option>
  ),
  Spinner: () => <div>Loading...</div>,
}));

describe("ApiKeysPage", () => {
  const sign = jest.fn();
  const fetchMock = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsPro = true;
    (global as any).fetch = fetchMock;
    Object.assign(navigator, {
      clipboard: {
        writeText: jest.fn(),
      },
    });

    sign.mockResolvedValue({
      id: "signed-proof-id",
      pubkey: "f".repeat(64),
      kind: 27235,
      created_at: 1710000000,
      tags: [],
      content: "",
      sig: "signature",
    });
  });

  function renderPage() {
    return render(
      <SignerContext.Provider
        value={{
          pubkey: "f".repeat(64),
          isLoggedIn: true,
          signer: { sign } as any,
        }}
      >
        <ApiKeysPage />
      </SignerContext.Provider>
    );
  }

  it("mints a session token once and manages keys with the bearer token", async () => {
    fetchMock
      // 1: session mint — one NIP-98 signature for the whole window.
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          token: "tok_scoped",
          expiresAt: Date.now() + 15 * 60 * 1000,
        }),
      })
      // 2: initial list (bearer)
      .mockResolvedValueOnce({
        json: async () => ({ keys: [] }),
      })
      // 3: create (bearer)
      .mockResolvedValueOnce({
        json: async () => ({
          success: true,
          key: "sk_created",
        }),
      })
      // 4: list refetch after create (bearer, cached token — no re-sign)
      .mockResolvedValueOnce({
        json: async () => ({ keys: [] }),
      });

    renderPage();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    // The mint request targets the session route with the mcp-keys scope.
    const [mintUrl, mintOptions] = fetchMock.mock.calls[0]!;
    expect(mintUrl).toContain("/api/assistant/session");
    expect(JSON.parse(mintOptions.body)).toEqual({ scope: "mcp-keys" });
    expect(mintOptions.headers.Authorization).toMatch(/^Nostr /);

    // The list request carries the bearer token and no signed proof.
    const [listUrl, listOptions] = fetchMock.mock.calls[1]!;
    expect(listUrl).toContain("/api/mcp/api-keys?pubkey=");
    expect(listOptions.headers.Authorization).toBe("Bearer tok_scoped");
    expect(listOptions.headers[MCP_SIGNED_EVENT_HEADER]).toBeUndefined();

    fireEvent.change(screen.getByLabelText("Key Name"), {
      target: { value: "My Agent" },
    });
    fireEvent.click(screen.getByRole("button", { name: /generate api key/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));

    const createCall = fetchMock.mock.calls[2]!;
    expect(createCall[1].headers.Authorization).toBe("Bearer tok_scoped");
    const requestBody = JSON.parse(createCall[1].body);
    expect(requestBody).toEqual(
      expect.objectContaining({
        name: "My Agent",
        permissions: "read",
        pubkey: "f".repeat(64),
      })
    );
    expect(requestBody.signedEvent).toBeUndefined();

    // One signature total (the mint) — list, create, and the refetch all
    // reused the bearer token without another signing prompt.
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it("falls back to signed proofs when the session mint fails", async () => {
    fetchMock
      // 1: session mint responds without a token (older server / failure)
      .mockResolvedValueOnce({
        json: async () => ({}),
      })
      // 2: list falls back to the single-use signed proof
      .mockResolvedValueOnce({
        json: async () => ({ keys: [] }),
      });

    renderPage();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const [url, options] = fetchMock.mock.calls[1]!;
    expect(url).toContain("/api/mcp/api-keys?pubkey=");
    expect(options.headers.Authorization).toBeUndefined();
    expect(options.headers[MCP_SIGNED_EVENT_HEADER]).toBe(
      JSON.stringify(await sign.mock.results[1]!.value)
    );

    const proofTemplate = sign.mock.calls[1]![0];
    expect(proofTemplate.tags).toEqual(
      buildMcpRequestProofTemplate(buildApiKeysListProof("f".repeat(64))).tags
    );
  });
});
