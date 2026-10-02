// Regression guard for the wallet restore/sweep path against the INSTALLED
// @cashu/cashu-ts — the complement to wallet-mint-sync-restore.test.ts, which
// never reaches a mint (escrow-only input) and so cannot see SDK drift.
//
// filterUnspentProofs builds a REAL Wallet (unguarded transport — this is
// client-side code fetching the user's own configured mints, so the safeFetch
// SSRF guard does not apply) and consumes checkProofsStates through casts tsc
// cannot check:
//   states[i].state === "SPENT"   (index-aligned with the input proofs)
//   (s as { Y: string }).Y
// restoreTokensFromProofEvents then restores only the verified-UNSPENT
// survivors into localStorage. A cashu-ts upgrade that renames
// checkProofsStates, changes the /v1/checkstate request or response shape
// ({Ys} → {states:[{Y,state}]}), or stops returning states in input order
// would silently turn every restore into a fail-closed skip (checked:false)
// or — worse — prune the wrong proofs. Here the default transport's global
// fetch is stubbed with protocol-shaped NUT-02/NUT-06/NUT-07 responses, so
// any such drift fails loudly.

import { deriveKeysetId, hashToCurve } from "@cashu/cashu-ts";
import {
  filterUnspentProofs,
  restoreTokensFromProofEvents,
} from "@/utils/cashu/wallet-mint-sync";

// NOTE: @cashu/cashu-ts is deliberately NOT mocked — that is the point.

// Minimal in-memory localStorage (same stub as the sibling restore suite).
const store = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
  },
});

const MINT = "https://mint.example";

// A real keyset id the SDK's KeyChain accepts, derived at runtime via the
// SDK's own deriveKeysetId so the plumbing tracks the installed SDK (an
// id-derivation change is out of scope — the contract under test is the
// checkstate request/response shape).
const KEYS: Record<string, string> = {
  "1": "0220c486d6f07a296e3a5a341b3253b8a14666489f5ad040160472a6241e420e79",
  "2": "02ed0be084e6f6d6da3d286d34be66a2b17a44afd2efe284b2905658061a497744",
  "4": "03ff5c14bb7c7dc29e1cebe93a2773af3f02d0c1e4e20d6c8941f26b6c5f53cc99",
  "8": "03d20d27f4447cdf3df68089510faed6dd41069e47daaefe23982ef27f97637b30",
};
const KEYSET_ID = deriveKeysetId(KEYS);

const MINT_INFO = {
  name: "wallet-sync regression mint",
  pubkey: KEYS["1"],
  version: "wallet-sync-regression/1.0",
  description: "protocol-shaped mint stub",
  contact: [],
  motd: "",
  nuts: { "7": { supported: true } },
};

/** A plain proof; checkstate only needs id + secret (Y derives from secret). */
function proof(amount: number, secret: string, id = KEYSET_ID): any {
  return { id, amount, secret, C: "02" + "cd".repeat(32) };
}

/** The Y the wallet will compute for a proof (SDK's own hash_to_curve). */
function yOf(secret: string): string {
  return hashToCurve(new TextEncoder().encode(secret)).toHex(true);
}

function fakeResponse(status: number, body: string): any {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

describe("wallet-mint-sync — real-SDK checkstate consumption", () => {
  let checkstateRequestBody: string | undefined;
  /** Ys the stub mint reports SPENT; everything else comes back UNSPENT. */
  let spentYs: Set<string>;
  /** When true the mint is unreachable (network error). */
  let mintDown: boolean;
  const realFetch = (globalThis as any).fetch;

  beforeEach(() => {
    store.clear();
    checkstateRequestBody = undefined;
    spentYs = new Set();
    mintDown = false;

    // jsdom ships no global fetch; assign a plain stub rather than spyOn.
    (globalThis as any).fetch = async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input.url;
      if (mintDown) throw new Error("network down");
      if (typeof url === "string" && url.startsWith(MINT)) {
        const path = url.slice(MINT.length);
        if (path === "/v1/info") {
          return fakeResponse(200, JSON.stringify(MINT_INFO));
        }
        if (path === "/v1/keysets") {
          return fakeResponse(
            200,
            JSON.stringify({
              keysets: [
                { id: KEYSET_ID, unit: "sat", active: true, input_fee_ppk: 0 },
              ],
            })
          );
        }
        if (path === "/v1/keys" || path.startsWith("/v1/keys/")) {
          return fakeResponse(
            200,
            JSON.stringify({
              keysets: [{ id: KEYSET_ID, unit: "sat", keys: KEYS }],
            })
          );
        }
        if (path === "/v1/checkstate") {
          checkstateRequestBody = init?.body;
          const parsed = JSON.parse(init?.body as string);
          // NUT-07: request is {Ys}, response is {states:[{Y,state,...}]}
          // with an entry for EVERY requested Y.
          if (!Array.isArray(parsed?.Ys) || parsed.Ys.length === 0) {
            throw new Error("checkstate request drift: missing Ys array");
          }
          return fakeResponse(
            200,
            JSON.stringify({
              states: parsed.Ys.map((Y: string) => ({
                Y,
                state: spentYs.has(Y) ? "SPENT" : "UNSPENT",
                witness: null,
              })),
            })
          );
        }
      }
      throw new Error(`unexpected fetch in wallet-sync SDK test: ${url}`);
    };
  });

  afterEach(() => {
    (globalThis as any).fetch = realFetch;
  });

  it("filterUnspentProofs drops exactly the mint-reported SPENT proof and keeps foreign-keyset proofs", async () => {
    const keep1 = proof(2, "secret-keep-1");
    const spent = proof(4, "secret-spent");
    const keep2 = proof(8, "secret-keep-2");
    const foreign = proof(1, "secret-foreign", "00ad268c5d80c561"); // not this mint's keyset
    spentYs.add(yOf(spent.secret));

    const result = await filterUnspentProofs(MINT, [
      keep1,
      spent,
      keep2,
      foreign,
    ]);

    // checked:true is the load-bearing bit: an SDK drift throws inside
    // filterUnspentProofs' try/catch and comes back checked:false — the
    // silent-skip failure mode this suite exists to catch.
    expect(result.checked).toBe(true);
    expect(result.spentCount).toBe(1);
    expect(result.unspent.map((p: any) => p.secret).sort()).toEqual(
      ["secret-keep-1", "secret-keep-2", "secret-foreign"].sort()
    );

    // The mint saw a protocol-shaped request carrying exactly the Ys of OUR
    // proofs (foreign proof excluded), computed via the real hash_to_curve.
    const sent = JSON.parse(checkstateRequestBody as string);
    expect(sent.Ys.sort()).toEqual(
      [yOf(keep1.secret), yOf(spent.secret), yOf(keep2.secret)].sort()
    );
  });

  it("restoreTokensFromProofEvents restores only verified-UNSPENT proofs and reports the sats arithmetic", async () => {
    const keep = proof(2, "restore-keep");
    const spent = proof(4, "restore-spent");
    spentYs.add(yOf(spent.secret));

    const result = await restoreTokensFromProofEvents([
      {
        mint: MINT,
        proofs: [keep, spent],
        created_at: 1_800_000_000,
      },
    ]);

    expect(result.restoredCount).toBe(1);
    expect(result.restoredSats).toBe(2);
    expect(result.mints).toContain(MINT);
    expect(result.skippedCount).toBe(0);

    const stored = JSON.parse(store.get("tokens") as string);
    expect(stored).toHaveLength(1);
    expect(stored[0].secret).toBe("restore-keep");
  });

  it("fails closed (skip, no restore) when the mint is unreachable", async () => {
    mintDown = true;
    const result = await restoreTokensFromProofEvents([
      { mint: MINT, proofs: [proof(2, "unverifiable")], created_at: 1 },
    ]);
    expect(result.restoredCount).toBe(0);
    expect(result.skippedCount).toBe(1);
    expect(result.skippedMints).toEqual([MINT]);
    expect(store.has("tokens")).toBe(false);
  });

  it("real Wallet exposes loadMint/keyChain.getKeysets/checkProofsStates and returns Y-tagged states in input order", async () => {
    // The same construction wallet-mint-sync performs, asserted directly so
    // an SDK rename fails here with a precise message rather than surfacing
    // as a fail-closed skip.
    const { Mint: CashuMint, Wallet: CashuWallet } =
      await import("@cashu/cashu-ts");
    const wallet = new CashuWallet(new CashuMint(MINT));
    expect(typeof wallet.loadMint).toBe("function");
    expect(typeof wallet.checkProofsStates).toBe("function");

    await wallet.loadMint();
    expect(typeof wallet.keyChain.getKeysets).toBe("function");
    const keysets = await wallet.keyChain.getKeysets();
    expect(keysets.map((k: any) => k.id)).toContain(KEYSET_ID);

    const a = proof(2, "order-a");
    const b = proof(4, "order-b");
    spentYs.add(yOf(b.secret));
    const states = await wallet.checkProofsStates([a, b]);

    // Input-order correspondence is the contract filterUnspentProofs' index
    // mapping relies on; each state must carry the Y it answers for.
    expect(states).toHaveLength(2);
    expect(states[0]!.Y).toBe(yOf(a.secret));
    expect(states[0]!.state).toBe("UNSPENT");
    expect(states[1]!.Y).toBe(yOf(b.secret));
    expect(states[1]!.state).toBe("SPENT");
  });
});
