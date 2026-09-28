// Unit tests for the per-seller session revocation stamp. The kill switch's
// safety guarantee depends on the stamp advancing in ONE atomic, monotonic
// upsert: a read-modify-write would let an older in-flight revoke overwrite
// a newer stamp and silently re-validate tokens the newer revoke had killed.

const queryMock = jest.fn();
const releaseMock = jest.fn();

jest.mock("@/utils/db/db-service", () => ({
  // db-service mocks must provide getDbPool: other utils/db modules call it
  // at module scope and a bare mock breaks the whole suite at import time.
  getDbPool: () => ({
    connect: async () => ({ query: queryMock, release: releaseMock }),
  }),
}));

import {
  getAssistantSessionRevokedBefore,
  revokeAssistantSessions,
} from "@/utils/assistant/session-revocation";

const PUBKEY = "e".repeat(64);
const STAMP_KEY = `assistant_session_revoked_before:${PUBKEY}`;

beforeEach(() => {
  jest.clearAllMocks();
});

describe("revokeAssistantSessions", () => {
  it("advances the stamp in a single atomic monotonic upsert", async () => {
    queryMock.mockResolvedValue({ rows: [{ value: "2000" }] });
    const stamped = await revokeAssistantSessions(PUBKEY, 2000);

    // Exactly ONE statement: any read-then-write split reopens the
    // concurrent-revoke race (older request writing last regresses the stamp).
    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain("ON CONFLICT (key) DO UPDATE");
    expect(sql).toContain("GREATEST");
    expect(params).toEqual([STAMP_KEY, "2000"]);
    expect(stamped).toBe(2000);
    expect(releaseMock).toHaveBeenCalledTimes(1);
  });

  it("never moves the stamp backwards under out-of-order completion", async () => {
    // Fake the table as a shared map and honor the GREATEST semantics. The
    // older revoke (t=1000) is held back and lands LAST, after the newer one
    // (t=2000) already completed — the exact interleaving a read-modify-write
    // would lose to. The persisted stamp must stay 2000.
    const table = new Map<string, string>();
    let releaseOlder: (() => void) | null = null;
    queryMock.mockImplementation(async (_sql: string, params: string[]) => {
      const key = params[0]!;
      const stamped = params[1]!;
      if (stamped === "1000") {
        await new Promise<void>((resolve) => {
          releaseOlder = resolve;
        });
      }
      const incoming = BigInt(stamped);
      const existing = table.get(key);
      const current =
        existing && /^[0-9]+$/.test(existing) ? BigInt(existing) : BigInt(0);
      const next = (incoming > current ? incoming : current).toString();
      table.set(key, next);
      return { rows: [{ value: next }] };
    });

    const older = revokeAssistantSessions(PUBKEY, 1000);
    const newer = revokeAssistantSessions(PUBKEY, 2000);
    expect(await newer).toBe(2000);
    // The newer revoke has reported success; only now does the older write
    // land. Monotonicity must hold regardless of completion order.
    releaseOlder!();
    expect(await older).toBe(2000);
    expect(table.get(STAMP_KEY)).toBe("2000");
  });

  it("rejects a non-hex pubkey before touching the database", async () => {
    await expect(revokeAssistantSessions("nope")).rejects.toThrow();
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe("getAssistantSessionRevokedBefore", () => {
  it("returns null when no stamp exists", async () => {
    queryMock.mockResolvedValue({ rows: [] });
    await expect(getAssistantSessionRevokedBefore(PUBKEY)).resolves.toBeNull();
  });

  it("parses a stored stamp", async () => {
    queryMock.mockResolvedValue({ rows: [{ value: "12345" }] });
    await expect(getAssistantSessionRevokedBefore(PUBKEY)).resolves.toBe(12345);
  });

  it("treats a corrupt stamp as absent (never wedges the kill switch)", async () => {
    queryMock.mockResolvedValue({ rows: [{ value: "not-a-number" }] });
    await expect(getAssistantSessionRevokedBefore(PUBKEY)).resolves.toBeNull();
  });

  it("throws on DB error — never swallows an outage as 'not revoked'", async () => {
    queryMock.mockRejectedValue(new Error("db down"));
    await expect(getAssistantSessionRevokedBefore(PUBKEY)).rejects.toThrow(
      "db down"
    );
  });
});
