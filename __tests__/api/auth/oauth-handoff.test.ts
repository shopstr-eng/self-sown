/** @jest-environment node */
const mockQuery = jest.fn();
jest.mock("@/utils/db/db-service", () => ({
  getDbPool: () => ({
    query: mockQuery,
    connect: async () => ({ query: mockQuery, release: jest.fn() }),
  }),
  withSchemaDdlLock: async (client: unknown, work: (db: unknown) => Promise<void>) => work(client),
}));

import { createOAuthHandoff, consumeOAuthHandoff } from "@/utils/auth/oauth-handoff";
import handler from "@/pages/api/auth/oauth-handoff";
import { createHash } from "crypto";
jest.mock("@/utils/rate-limit", () => ({ applyRateLimit: jest.fn(async () => true) }));

beforeEach(() => {
  mockQuery.mockReset().mockResolvedValue({ rows: [] });
  process.env.AUTH_ENCRYPTION_KEY = "dummy-handoff-server-key";
});
afterEach(() => { delete process.env.AUTH_ENCRYPTION_KEY; });

it("stores only a token hash and server-encrypted key, with bounded expiry", async () => {
  const token = await createOAuthHandoff({
    nsec: "dummy-nsec-secret", pubkey: "dummy-pubkey", provider: "google", isNewUser: false,
  });
  expect(token).toMatch(/^[a-f0-9]{64}$/);
  const [sql, params] = mockQuery.mock.calls.find(([sql]) => sql.includes("INSERT INTO"))!;
  expect(sql).toContain("INTERVAL '120 seconds'");
  expect(params[0]).toBe(createHash("sha256").update(token).digest("hex"));
  expect(params[1]).not.toContain("dummy-nsec-secret");
  const payload = JSON.parse(params[1]);
  mockQuery.mockResolvedValueOnce({ rows: [{ payload }] }).mockResolvedValueOnce({ rows: [] });
  await expect(consumeOAuthHandoff(token)).resolves.toMatchObject({ nsec: "dummy-nsec-secret" });
  await expect(consumeOAuthHandoff(token)).resolves.toBeNull();
  const consumeCalls = mockQuery.mock.calls.filter(([sql]) => sql.includes("RETURNING payload"));
  expect(consumeCalls).toHaveLength(2);
  for (const [query] of consumeCalls) {
    expect(query).toContain("DELETE FROM");
    expect(query).toContain("expires_at > NOW()");
  }
});

it("rejects malformed handoff tokens without accessing persistence", async () => {
  await expect(consumeOAuthHandoff("../secret")).resolves.toBeNull();
  expect(mockQuery).not.toHaveBeenCalled();
});

it.each([
  { "x-oauth-handoff": "1", "sec-fetch-site": "cross-site" },
  { host: "shop.example", origin: "https://attacker.example", "x-oauth-handoff": "1" },
  {},
])("rejects a cross-origin or simple browser request", async (headers) => {
  const res = { setHeader: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn() } as any;
  await handler({ method: "POST", headers, cookies: {} } as any, res);
  expect(res.status).toHaveBeenCalledWith(403);
  expect(mockQuery).not.toHaveBeenCalled();
});

it("expires a consumed or missing handoff without exposing credentials", async () => {
  const res = { setHeader: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn() } as any;
  await handler({
    method: "POST", headers: { "x-oauth-handoff": "1" },
    cookies: { "__Host-ss-oauth-handoff": "a".repeat(64) },
  } as any, res);
  expect(res.status).toHaveBeenCalledWith(401);
  expect(res.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store, private");
  expect(res.setHeader).toHaveBeenCalledWith("Set-Cookie", expect.stringContaining("Max-Age=0"));
});
