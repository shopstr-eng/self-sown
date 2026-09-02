/**
 * @jest-environment node
 */

// Real-mint contract test for fetchCashuWallet's boot-time spent-proof cleanup.
//
// WHY THIS EXISTS
// fetchCashuWallet permanently asks the signer to delete kind:7375 proof events
// the mint reports as fully spent. Every other test of this logic mocks
// checkProofsStates, so a cashu-ts API drift (e.g. a changed proof-state
// response shape) would be invisible until a real boot deleted recovery
// material it shouldn't. This file exercises the REAL @cashu/cashu-ts against
// the staging fake mint (Staging Cashu Mint workflow, port 3338) and asserts
// the boot cleanup passes ONLY the fully-spent event ids to deleteEvent.
//
// GATED: skipped (with a loud warning) when the staging mint is unreachable.
// Point STAGING_CASHU_MINT_URL at another mint to run elsewhere.

import {
  Mint as CashuMint,
  Wallet as CashuWallet,
  Proof,
} from "@cashu/cashu-ts";

jest.setTimeout(120000);

const STAGING_MINT_URL =
  process.env.STAGING_CASHU_MINT_URL ?? "http://127.0.0.1:3338";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const probeMint = async (): Promise<boolean> => {
  try {
    const res = await fetch(`${STAGING_MINT_URL}/v1/info`, {
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
};

// Mints `amount` sats from the staging FakeWallet mint. FakeWallet settles
// mint quotes immediately; poll briefly to absorb any latency.
const mintProofs = async (
  wallet: CashuWallet,
  amount: number
): Promise<Proof[]> => {
  const quote = await wallet.createMintQuoteBolt11(amount);
  let state: string | undefined;
  for (let i = 0; i < 40; i++) {
    const checked = await wallet.checkMintQuoteBolt11(quote.quote);
    state = typeof checked === "string" ? checked : checked?.state;
    if (state === "PAID" || state === "ISSUED") break;
    await sleep(250);
  }
  if (state !== "PAID" && state !== "ISSUED") {
    throw new Error(`Staging mint quote never settled (state=${state})`);
  }
  return wallet.mintProofsBolt11(amount, quote.quote);
};

// Events carry plain JSON proofs (nostr event content is JSON-serialized), so
// strip any cashu-ts class instances down to the wire shape.
const toWireProof = (p: Proof) => ({
  id: p.id,
  amount: Number(p.amount),
  secret: p.secret,
  C: p.C,
});

describe("fetchCashuWallet spent-proof cleanup against the staging mint", () => {
  let mintAvailable = false;
  let spentProofs: Proof[] = [];
  let unspentProofs: Proof[] = [];

  beforeAll(async () => {
    mintAvailable = await probeMint();
    if (!mintAvailable) {
      console.warn(
        `[fetch-service-real-mint] staging mint unreachable at ${STAGING_MINT_URL}; ` +
          "skipping real-mint tests (start the Staging Cashu Mint workflow to run them)"
      );
      return;
    }
    const wallet = new CashuWallet(new CashuMint(STAGING_MINT_URL));
    await wallet.loadMint();

    // Batch A: minted and then spent in full via a swap, so the mint reports
    // every proof in it SPENT. NOTE: cashu-ts v4 send() short-circuits when
    // the amount exactly matches the inputs (no swap, proofs stay UNSPENT),
    // so send a partial amount to force a real swap that spends the inputs.
    spentProofs = await mintProofs(wallet, 4);
    const spentTotal = spentProofs.reduce(
      (sum, p) => sum + Number(p.amount),
      0
    );
    await wallet.send(spentTotal - 1, spentProofs);

    // Batch B: minted and left untouched — the mint must report UNSPENT.
    unspentProofs = await mintProofs(wallet, 3);

    // Fixture sanity check through the real library: if the mint's state
    // response doesn't line up with what we did, the boot assertions below
    // would be meaningless.
    const perProofSpent = await wallet.checkProofsStates(spentProofs);
    const perProofUnspent = await wallet.checkProofsStates(unspentProofs);
    expect(perProofSpent.every((s) => s.state === "SPENT")).toBe(true);
    expect(perProofUnspent.every((s) => s.state === "UNSPENT")).toBe(true);
  });

  const bootWallet = async (events: {
    eventById: Record<string, { content: string; decrypted: string }>;
  }) => {
    jest.resetModules();

    const mockDeleteEvent = jest.fn().mockResolvedValue(undefined);
    jest.doMock("@/utils/nostr/nostr-helper-functions", () => ({
      getLocalStorageData: jest.fn(() => ({ tokens: [] })),
      deleteEvent: mockDeleteEvent,
      verifyNip05Identifier: jest.fn(),
    }));
    jest.doMock("@/utils/db/db-client", () => ({
      cacheEventsToDatabase: jest.fn().mockResolvedValue(undefined),
    }));

    const { fetchCashuWallet } = await import("../fetch-service");

    const buyerPk = "f".repeat(64);
    const nostrEvents = Object.entries(events.eventById).map(
      ([id, { content }]) => ({
        id,
        pubkey: buyerPk,
        created_at: 1,
        kind: 7375,
        tags: [],
        content,
        sig: "sig",
      })
    );
    const signer = {
      getPubKey: async () => buyerPk,
      decrypt: async (_pk: string, content: string) => {
        const entry = Object.values(events.eventById).find(
          (e) => e.content === content
        );
        return entry?.decrypted ?? "";
      },
    };

    // Only the DB wallet fetch is stubbed; every other URL (the staging mint)
    // goes through the REAL fetch so cashu-ts talks to the real mint.
    const realFetch = global.fetch;
    global.fetch = jest.fn(async (input: any, init?: any) => {
      const url = String(input);
      if (url.startsWith("/api/")) {
        return { ok: true, json: async () => [] } as any;
      }
      return realFetch(input, init);
    }) as unknown as typeof global.fetch;

    const nostr = {
      fetch: jest.fn(async (filters: { kinds?: number[] }[]) =>
        filters[0]?.kinds?.includes(7375) ? nostrEvents : []
      ),
    } as any;
    const editCashuWalletContext = jest.fn();

    try {
      const result = await fetchCashuWallet(
        nostr,
        signer as any,
        ["wss://relay.example"],
        editCashuWalletContext
      );
      return { result, mockDeleteEvent, editCashuWalletContext };
    } finally {
      global.fetch = realFetch;
    }
  };

  const makeWalletEventContent = (proofs: Proof[]) => ({
    content: `cipher-${proofs.map((p) => p.secret).join("|")}`,
    decrypted: JSON.stringify({
      mint: STAGING_MINT_URL,
      unit: "sat",
      proofs: proofs.map(toWireProof),
    }),
  });

  it("passes only fully-spent event ids to deleteEvent", async () => {
    if (!mintAvailable) return;

    const spentEvent = makeWalletEventContent(spentProofs);
    const unspentEvent = makeWalletEventContent(unspentProofs);
    const mixedEvent = makeWalletEventContent([
      spentProofs[0]!,
      unspentProofs[0]!,
    ]);

    const { result, mockDeleteEvent } = await bootWallet({
      eventById: {
        "real-mint-spent-event": spentEvent,
        "real-mint-unspent-event": unspentEvent,
        "real-mint-mixed-event": mixedEvent,
      },
    });

    // Exactly one deletion call, for the fully-spent event only. The mixed
    // event still holds an unspent proof, and the unspent event must never be
    // touched — a cashu-ts response-shape drift that flipped either would
    // show up here before a real boot deleted recovery material.
    expect(mockDeleteEvent).toHaveBeenCalledTimes(1);
    expect(mockDeleteEvent).toHaveBeenCalledWith(expect.anything(), expect.anything(), [
      "real-mint-spent-event",
    ]);

    // The booted wallet balance is exactly the unspent proofs.
    expect(result.cashuProofs.map((p: Proof) => p.secret).sort()).toEqual(
      unspentProofs.map((p) => p.secret).sort()
    );
  });

  it("queues no deletions when the mint reports every proof unspent", async () => {
    if (!mintAvailable) return;

    const unspentEvent = makeWalletEventContent(unspentProofs);

    const { result, mockDeleteEvent } = await bootWallet({
      eventById: { "real-mint-all-unspent-event": unspentEvent },
    });

    expect(mockDeleteEvent).not.toHaveBeenCalled();
    expect(result.cashuProofs.map((p: Proof) => p.secret).sort()).toEqual(
      unspentProofs.map((p) => p.secret).sort()
    );
  });
});
