/**
 * Signer-integration check for the scoped session tokens (task: one signing
 * prompt per window for extension/bunker users).
 *
 * The unit/route suites mock one side of the wire: the page tests stub fetch,
 * and scoped-session-routes tests stub verifyNip98Request. This suite closes
 * the loop with an extension-mocked signer — a NIP-07-shaped signer backed by
 * a REAL keypair whose sign() count stands in for "extension prompts" — wired
 * through the real client helpers (session-client, nip98-auth) into the REAL
 * route handlers (/api/assistant/session, /api/mcp/api-keys,
 * /api/assistant/setup) via a fetch dispatcher. Only the DB/Pro/rate-limit
 * boundaries are mocked.
 *
 * Proves:
 *  - listing, creating, and revoking MCP keys on settings/api-keys costs
 *    exactly ONE signer interaction (the session mint) per window,
 *  - the assistant settings status check + enabling writes costs ONE,
 *  - a chat-scoped token is rejected (401) by both management endpoints.
 */
import type { ReactElement } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { generateSecretKey, getPublicKey, finalizeEvent } from "nostr-tools";
import { SignerContext } from "@/components/utility-components/nostr-context-provider";
import ApiKeysPage from "@/pages/settings/api-keys";
import AssistantSettingsPage from "@/pages/settings/assistant";

// --- DB / entitlement / abuse boundaries (not under test here) --------------

const mockApiKeysStore: Array<{
  id: number;
  seller_pubkey: string;
  name: string;
  permissions: string;
  key_prefix: string;
  created_at: string;
  last_used_at: string | null;
  is_active: boolean;
}> = [];
const mockApiKeyIdSeq = { value: 0 };
let mockWritesEnabled = false;

jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: jest.fn(async () => true),
  getRequestIp: () => "127.0.0.1",
}));

jest.mock("@/utils/pro/require-pro", () => ({
  requireProEntitlement: jest.fn(async () => true),
}));

jest.mock("@/utils/assistant/assistant-key", () => ({
  ensureAssistantTables: jest.fn(async () => {}),
  getOrCreateAssistantKey: jest.fn(async () => ({ id: 1 })),
  getAssistantSigningState: jest.fn(async () => mockWritesEnabled),
  provisionAssistantSigning: jest.fn(async () => {
    mockWritesEnabled = true;
    return { ok: true };
  }),
}));

jest.mock("@/utils/mcp/auth", () => ({
  initializeApiKeysTable: jest.fn(async () => {}),
  createApiKey: jest.fn(
    async (name: string, pubkey: string, permissions: string) => {
      const record = {
        id: ++mockApiKeyIdSeq.value,
        seller_pubkey: pubkey,
        name,
        permissions,
        key_prefix: "ss_test",
        created_at: new Date().toISOString(),
        last_used_at: null,
        is_active: true,
      };
      mockApiKeysStore.push(record);
      return { key: `ss_secret_${record.id}`, record };
    }
  ),
  listApiKeys: jest.fn(async (pubkey: string) =>
    mockApiKeysStore
      .filter((k) => k.seller_pubkey === pubkey)
      .map(({ seller_pubkey: _ignored, ...rest }) => rest)
  ),
  revokeApiKey: jest.fn(async (id: number, pubkey: string) => {
    const key = mockApiKeysStore.find(
      (k) => k.id === id && k.seller_pubkey === pubkey && k.is_active
    );
    if (!key) return false;
    key.is_active = false;
    return true;
  }),
}));

jest.mock("@/utils/db/db-service", () => ({
  // db-service mocks must provide getDbPool: other utils/db modules call it
  // at module scope and a bare mock breaks the whole suite at import time.
  getDbPool: jest.fn(),
}));

// --- UI boundaries ------------------------------------------------------------

let mockIsPro = true;

jest.mock("@/components/utility-components/pro-membership-context", () => ({
  useProMembership: () => ({ membership: { isPro: mockIsPro }, loading: false }),
}));

jest.mock("next/router", () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
}));

jest.mock("@/components/settings/settings-bread-crumbs", () => ({
  SettingsBreadCrumbs: () => <div data-testid="breadcrumbs" />,
}));

jest.mock("@/components/assistant/assistant-chat", () => ({
  __esModule: true,
  default: () => <div data-testid="assistant-chat" />,
}));

jest.mock("@heroui/react", () => ({
  useDisclosure: () => ({
    isOpen: false,
    onOpen: jest.fn(),
    onClose: jest.fn(),
  }),
  Button: ({ children, onClick, onPress, isDisabled, type }: any) => (
    <button
      disabled={isDisabled}
      onClick={onClick ?? onPress}
      type={type || "button"}
    >
      {children}
    </button>
  ),
  Input: ({ value, onValueChange, label, ...rest }: any) => (
    <label>
      {label}
      <input
        aria-label={label ?? rest["aria-label"]}
        placeholder={rest.placeholder}
        type={rest.type}
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

// --- Real server handlers (NIP-98 verification, replay guard, and session
// --- token mint/verify all run for real) --------------------------------------

import sessionHandler from "@/pages/api/assistant/session";
import apiKeysHandler from "@/pages/api/mcp/api-keys";
import setupHandler from "@/pages/api/assistant/setup";
import { mintAssistantSessionToken } from "@/utils/assistant/session-token";
import type { NextApiRequest, NextApiResponse } from "next";

process.env.SESSION_SECRET = "test-session-secret-with-plenty-of-chars";

const HANDLERS: Record<string, (req: any, res: any) => Promise<unknown>> = {
  "/api/assistant/session": sessionHandler,
  "/api/mcp/api-keys": apiKeysHandler,
  "/api/assistant/setup": setupHandler,
};

type RecordedRequest = {
  method: string;
  path: string;
  authorization?: string;
};

const requests: RecordedRequest[] = [];

function createMockRes() {
  const res: any = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res as NextApiResponse & { statusCode: number; body: any };
}

// Stands in for the browser's fetch + the Next.js server: routes the page's
// real fetch calls to the real route handlers.
async function dispatch(input: any, init: any = {}) {
  const url = new URL(
    typeof input === "string" ? input : input.url,
    "http://localhost"
  );
  const method = (init.method || "GET").toUpperCase();
  const headers: Record<string, string> = { host: url.host };
  for (const [key, value] of Object.entries(init.headers || {})) {
    headers[key.toLowerCase()] = String(value);
  }
  const handler = HANDLERS[url.pathname];
  if (!handler) throw new Error(`Unexpected fetch to ${url.pathname}`);

  requests.push({
    method,
    path: url.pathname,
    authorization: headers.authorization,
  });

  const query: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    query[key] = value;
  });

  const req = {
    method,
    url: url.pathname + url.search,
    query,
    body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    headers,
  } as unknown as NextApiRequest;

  const res = createMockRes();
  await handler(req, res);
  return {
    ok: res.statusCode >= 200 && res.statusCode < 300,
    status: res.statusCode,
    json: async () => res.body,
  } as any;
}

// --- Extension-mocked signer: a NIP-07-shaped signer backed by a real key.
// --- Every sign() call is one extension/bunker prompt to the user. -----------

function makeExtensionSigner() {
  const secretKey = generateSecretKey();
  const pubkey = getPublicKey(secretKey);
  const sign = jest.fn(async (template: any) =>
    finalizeEvent(template, secretKey)
  );
  const signer = { sign } as any;
  return { signer, pubkey, sign };
}

function renderWithSigner(signer: any, pubkey: string, page: ReactElement) {
  return render(
    <SignerContext.Provider
      value={{ pubkey, isLoggedIn: true, signer } as any}
    >
      {page}
    </SignerContext.Provider>
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIsPro = true;
  mockWritesEnabled = false;
  mockApiKeysStore.length = 0;
  mockApiKeyIdSeq.value = 0;
  requests.length = 0;
  (global as any).fetch = jest.fn(dispatch);
  Object.assign(navigator, { clipboard: { writeText: jest.fn() } });
});

describe("settings/api-keys with an extension signer", () => {
  it("lists, creates, and revokes keys with exactly one signing prompt", async () => {
    const { signer, pubkey, sign } = makeExtensionSigner();
    renderWithSigner(signer, pubkey, <ApiKeysPage />);

    // Initial load: one NIP-98 signature mints the mcp-keys session token,
    // then the key list loads with the bearer token.
    await waitFor(() =>
      expect(screen.getByText(/No API keys created yet/i)).toBeTruthy()
    );
    expect(sign).toHaveBeenCalledTimes(1);

    // Create a key — no further prompt.
    fireEvent.change(screen.getByLabelText("Key Name"), {
      target: { value: "My Agent" },
    });
    fireEvent.click(screen.getByRole("button", { name: /generate api key/i }));
    await waitFor(() =>
      expect(screen.getByText(/API key created!/i)).toBeTruthy()
    );
    await waitFor(() => expect(screen.getByText("My Agent")).toBeTruthy());

    // Revoke it — still no further prompt.
    fireEvent.click(screen.getByRole("button", { name: /revoke/i }));
    await waitFor(() =>
      expect(screen.getByText(/API key revoked./i)).toBeTruthy()
    );

    // ONE signer interaction for the whole session (list + create + revoke
    // + refetches), i.e. one extension prompt per ~15-minute window.
    expect(sign).toHaveBeenCalledTimes(1);

    // Exactly one mint happened, scoped to mcp-keys...
    const mints = requests.filter((r) => r.path === "/api/assistant/session");
    expect(mints).toHaveLength(1);
    expect(mints[0]!.authorization).toMatch(/^Nostr /);

    // ...and every management call rode the bearer token, not a signature.
    const management = requests.filter((r) => r.path !== "/api/assistant/session");
    expect(management.map((r) => `${r.method} ${r.path}`)).toEqual([
      `GET /api/mcp/api-keys`,
      `POST /api/mcp/api-keys`,
      `GET /api/mcp/api-keys`,
      `DELETE /api/mcp/api-keys`,
      `GET /api/mcp/api-keys`,
    ]);
    for (const r of management) {
      expect(r.authorization).toMatch(/^Bearer /);
    }
    // All bearer calls used the same minted token.
    expect(new Set(management.map((r) => r.authorization)).size).toBe(1);
  });
});

describe("settings/assistant with an extension signer", () => {
  it("checks status and enables write actions with exactly one signing prompt", async () => {
    const { signer, pubkey, sign } = makeExtensionSigner();
    renderWithSigner(signer, pubkey, <AssistantSettingsPage />);

    // On mount the page mints an assistant-setup token and checks status.
    await waitFor(() =>
      expect(screen.getByText(/Enable write actions/i)).toBeTruthy()
    );
    expect(sign).toHaveBeenCalledTimes(1);

    // Enable writes — the POST reuses the bearer token, no second prompt.
    fireEvent.change(screen.getByLabelText("Nostr secret key"), {
      target: { value: "nsec1agentkey" },
    });
    fireEvent.click(screen.getByRole("button", { name: /enable writes/i }));
    await waitFor(() =>
      expect(screen.getByText(/Write actions are enabled/i)).toBeTruthy()
    );

    expect(sign).toHaveBeenCalledTimes(1);

    const mints = requests.filter((r) => r.path === "/api/assistant/session");
    expect(mints).toHaveLength(1);

    const setup = requests.filter((r) => r.path === "/api/assistant/setup");
    expect(setup.map((r) => r.method)).toEqual(["GET", "POST"]);
    for (const r of setup) {
      expect(r.authorization).toMatch(/^Bearer /);
    }
    expect(new Set(setup.map((r) => r.authorization)).size).toBe(1);
  });
});

describe("scope isolation against the live handlers", () => {
  it("rejects a chat-scoped token on the MCP-key and assistant-setup endpoints", async () => {
    const { pubkey } = makeExtensionSigner();
    const { token: chatToken } = mintAssistantSessionToken(pubkey, "chat");
    const bearer = { Authorization: `Bearer ${chatToken}` };

    const listRes = await dispatch(
      `http://localhost/api/mcp/api-keys?pubkey=${pubkey}`,
      { headers: bearer }
    );
    expect(listRes.status).toBe(401);

    const setupGet = await dispatch("http://localhost/api/assistant/setup", {
      headers: bearer,
    });
    expect(setupGet.status).toBe(401);

    const setupPost = await dispatch("http://localhost/api/assistant/setup", {
      method: "POST",
      headers: { ...bearer, "Content-Type": "application/json" },
      body: JSON.stringify({ nsec: "nsec1agentkey" }),
    });
    expect(setupPost.status).toBe(401);
  });
});
