// Regression guard for executeEscrowPayout against the INSTALLED
// @cashu/cashu-ts — the complement to escrow-payout.test.ts, which fakes the
// wallet/mint interfaces entirely (fakeWallet returns hand-built previews).
//
// Here the REAL Wallet runs the payout: loadMint → checkProofsStates
// (NUT-07) → prepareSwapToReceive (P2PK-locked outputs) → OutputData.serialize
// → completeSwap (NUT-03). Only the transport is stubbed, via the module's
// own walletFactory/mintApiFactory injection seams pointed at a protocol-
// shaped stub mint. The stub mint cryptographically VERIFIES every swap
// input (verifyUnblindedSignature) and signs the P2PK-locked outputs for
// real (createBlindSignature + createDLEQProof), so an SDK upgrade that
// renames wallet methods, changes the swap request/response shape, or alters
// OutputData serialization fails here — not in a live escrow payout.
//
// The recovery path (all inputs SPENT → NUT-09 /v1/restore →
// OutputData.deserialize(p).toProof(signature, keyset)) is exercised by
// capturing the REAL prepared outputs from a successful payout and replaying
// them against a mint that reports the inputs spent.

import {
  Amount,
  Mint,
  OutputData,
  Wallet,
  blindMessage,
  createBlindSignature,
  createDLEQProof,
  createNewMintKeys,
  createP2PKsecret,
  pointFromHex,
  serializeMintKeys,
  signP2PKProof,
  unblindSignature,
  verifyUnblindedSignature,
  hashToCurve,
  type Proof,
  type SerializedOutputData,
} from "@cashu/cashu-ts";
import { generateSecretKey, getPublicKey } from "nostr-tools";
import { executeEscrowPayout } from "@/utils/cashu/escrow-payout";
import type { EscrowRegistration } from "@/utils/db/cashu-escrow-service";

const sellerSecret = generateSecretKey();
const buyerSecret = generateSecretKey();
const sellerPriv = Buffer.from(sellerSecret).toString("hex");
const sellerPub = getPublicKey(sellerSecret);
const buyerPub = getPublicKey(buyerSecret);

const LOCKTIME = Math.floor(Date.now() / 1000) + 86_400;
const MINT_URL = "https://mint.example";
const AMOUNT = 4096; // power of two: covered by the in-test mint keyset

// Locally generated mint keys (amounts 1..4096): the stub mint signs with the
// private half; the real wallet unblinds + DLEQ-verifies against the public
// half it fetches from /v1/keys.
const MINT_KEYS = createNewMintKeys(13);
const KEYSET_ID = MINT_KEYS.keysetId;
const PUB_KEYS = serializeMintKeys(MINT_KEYS.pubKeys);

const MINT_INFO = {
  name: "escrow-payout regression mint",
  pubkey: PUB_KEYS["1"],
  version: "escrow-payout-regression/1.0",
  description: "protocol-shaped mint stub",
  contact: [],
  motd: "",
  nuts: {
    "3": {},
    "7": { supported: true },
    "9": { supported: true },
    "12": { supported: true },
  },
};

function bytesToHex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

/** A REAL P2PK-locked escrow proof, minted in-test and seller-witnessed. */
function mintEscrowProof(amount: number): Proof {
  const secret = createP2PKsecret(sellerPub, [
    ["locktime", String(LOCKTIME)],
    ["refund", buyerPub],
  ]);
  const { B_, r } = blindMessage(new TextEncoder().encode(secret));
  const priv = MINT_KEYS.privKeys[String(amount)];
  const pub = PUB_KEYS[String(amount)];
  if (!priv || !pub) throw new Error(`no mint key for amount ${amount}`);
  const signed = createBlindSignature(B_, priv, KEYSET_ID);
  const C = unblindSignature(signed.C_, r, pointFromHex(pub));
  const proof = {
    id: KEYSET_ID,
    amount,
    secret,
    C: C.toHex(true),
  } as unknown as Proof;
  return signP2PKProof(proof, sellerPriv);
}

/** Verify a proof (C as hex) against the mint's private key. */
function proofVerifies(p: { amount: unknown; secret: string; C: string }) {
  const priv = MINT_KEYS.privKeys[String(Number(p.amount))];
  if (!priv) return false;
  return verifyUnblindedSignature(
    { secret: new TextEncoder().encode(p.secret), C: pointFromHex(p.C) } as any,
    priv
  );
}

/** Parse the P2PK lock out of an output proof's secret. */
function p2pkLock(secret: string): { data: string } {
  const [kind, payload] = JSON.parse(secret);
  if (kind !== "P2PK") throw new Error(`expected P2PK secret, got ${kind}`);
  return payload;
}

/** The SDK writes the lock pubkey compressed (02 + x-only); the payout
 * module's own comparison accepts both forms. Compare x-only. */
function lockDataXOnly(secret: string): string {
  const data = p2pkLock(secret).data;
  return data.length === 66 ? data.slice(2) : data;
}

function makeRegistration(): EscrowRegistration {
  return {
    escrowId: `${buyerPub}:order-1`,
    buyerPubkey: buyerPub,
    sellerPubkey: sellerPub,
    orderId: "order-1",
    amountSats: AMOUNT,
    mintUrl: MINT_URL,
    arbiterPubkey: null,
    expiresAt: new Date(LOCKTIME * 1000),
    status: "locked",
  };
}

type CheckMode = "UNSPENT" | "SPENT";

describe("executeEscrowPayout — real SDK swap + restore", () => {
  let checkMode: CheckMode;
  let swapRequestBody: any;
  let restoreRequestBody: any;
  let getKeysPaths: string[];
  let callSeq: number;
  let swapCallSeq: number;

  /**
   * The stub mint, served through the SDK customRequest seam (parsed JSON in
   * and out — same contract createGuardedMintRequest implements). Hard-THROWS
   * on any request-shape drift.
   */
  async function stubRequest({
    endpoint,
    requestBody,
  }: {
    endpoint: string;
    requestBody?: any;
  }): Promise<any> {
    callSeq++;
    const path = endpoint.slice(MINT_URL.length);
    if (path === "/v1/info") return MINT_INFO;
    if (path === "/v1/keysets") {
      return {
        keysets: [
          { id: KEYSET_ID, unit: "sat", active: true, input_fee_ppk: 0 },
        ],
      };
    }
    if (path === "/v1/keys" || path.startsWith("/v1/keys/")) {
      getKeysPaths.push(path);
      return { keysets: [{ id: KEYSET_ID, unit: "sat", keys: PUB_KEYS }] };
    }
    if (path === "/v1/checkstate") {
      const Ys = requestBody?.Ys;
      if (!Array.isArray(Ys) || Ys.length === 0) {
        throw new Error("checkstate request drift: missing Ys array");
      }
      return {
        states: Ys.map((Y: string) => ({ Y, state: checkMode, witness: null })),
      };
    }
    if (path === "/v1/swap") {
      swapCallSeq = callSeq;
      swapRequestBody = requestBody;
      const inputs = requestBody?.inputs;
      const outputs = requestBody?.outputs;
      if (!Array.isArray(inputs) || inputs.length === 0) {
        throw new Error("swap request drift: missing inputs");
      }
      if (!Array.isArray(outputs) || outputs.length === 0) {
        throw new Error("swap request drift: missing outputs");
      }
      for (const p of inputs) {
        if (
          typeof p?.id !== "string" ||
          typeof p?.secret !== "string" ||
          typeof p?.C !== "string"
        ) {
          throw new Error("swap request drift: input lost id/secret/C fields");
        }
        if (!proofVerifies(p)) {
          throw new Error(
            `mint stub rejected swap input (amount ${p.amount}): bad signature`
          );
        }
      }
      // Sign every requested output for real, one signature per output, in
      // request order (the SDK pairs them back by sorted index).
      const signatures = outputs.map((o: any) => {
        const amount = Number(o.amount);
        if (typeof o?.B_ !== "string" || o?.id !== KEYSET_ID) {
          throw new Error("swap request drift: output lost B_/id fields");
        }
        const priv = MINT_KEYS.privKeys[String(amount)];
        if (!priv) throw new Error(`no mint key for output amount ${amount}`);
        const B = pointFromHex(o.B_);
        const signed = createBlindSignature(B, priv, KEYSET_ID);
        const dleq = createDLEQProof(B, priv);
        return {
          id: KEYSET_ID,
          amount,
          C_: signed.C_.toHex(true),
          dleq: { e: bytesToHex(dleq.e), s: bytesToHex(dleq.s) },
        };
      });
      return { signatures };
    }
    if (path === "/v1/restore") {
      restoreRequestBody = requestBody;
      const outputs = requestBody?.outputs;
      if (!Array.isArray(outputs) || outputs.length === 0) {
        throw new Error("restore request drift: missing outputs");
      }
      const signatures = outputs.map((o: any) => {
        const amount = Number(o.amount);
        if (typeof o?.B_ !== "string" || o?.id !== KEYSET_ID) {
          throw new Error("restore request drift: output lost B_/id fields");
        }
        const priv = MINT_KEYS.privKeys[String(amount)];
        if (!priv) throw new Error(`no mint key for restore amount ${amount}`);
        const B = pointFromHex(o.B_);
        const signed = createBlindSignature(B, priv, KEYSET_ID);
        const dleq = createDLEQProof(B, priv);
        return {
          id: KEYSET_ID,
          amount,
          C_: signed.C_.toHex(true),
          dleq: { e: bytesToHex(dleq.e), s: bytesToHex(dleq.s) },
        };
      });
      // NUT-09: outputs echoed, signatures paired positionally.
      return { outputs, signatures };
    }
    throw new Error(`unexpected mint request in escrow SDK test: ${endpoint}`);
  }

  const realWalletFactory = (mintUrl: string) =>
    new Wallet(new Mint(mintUrl, { customRequest: stubRequest })) as any;
  const realMintApiFactory = (mintUrl: string) =>
    new Mint(mintUrl, { customRequest: stubRequest }) as any;

  beforeEach(() => {
    checkMode = "UNSPENT";
    swapRequestBody = undefined;
    restoreRequestBody = undefined;
    getKeysPaths = [];
    callSeq = 0;
    swapCallSeq = -1;
  });

  it("pays out through a real swap: verified inputs, payee-locked unblinded outputs, persistence before the mint call", async () => {
    const proofs = [mintEscrowProof(AMOUNT)];
    const persisted: SerializedOutputData[][] = [];
    let persistSeq = -1;
    const result = await executeEscrowPayout(
      makeRegistration(),
      "release",
      { proofs },
      {
        walletFactory: realWalletFactory,
        mintApiFactory: realMintApiFactory,
        persistPreparedOutputs: async (prepared) => {
          persistSeq = ++callSeq;
          persisted.push(prepared);
        },
      }
    );

    // Payee outputs are real proofs: unblinded + DLEQ-verified by the SDK,
    // locked to the seller (release pays the seller), summing to the escrow
    // amount.
    expect(result.outputs.length).toBeGreaterThan(0);
    let total = 0;
    for (const p of result.outputs) {
      const amt =
        p.amount instanceof Amount ? p.amount.toNumber() : Number(p.amount);
      total += amt;
      expect(p.id).toBe(KEYSET_ID);
      expect(lockDataXOnly(p.secret)).toBe(sellerPub);
      expect(p.dleq?.r).toMatch(/^[0-9a-f]{64}$/);
      expect(proofVerifies(p)).toBe(true);
    }
    expect(total).toBe(AMOUNT);

    // The swap request carried the seller's witness signature on the input.
    const input = swapRequestBody.inputs[0];
    const witness = JSON.parse(input.witness);
    expect(Array.isArray(witness.signatures)).toBe(true);
    expect(witness.signatures[0]).toMatch(/^[0-9a-f]{128}$/);

    // Prepared outputs were persisted BEFORE the swap hit the mint — the
    // crash-recovery invariant.
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.length).toBe(result.outputs.length);
    expect(persistSeq).toBeGreaterThan(-1);
    expect(swapCallSeq).toBeGreaterThan(persistSeq);

    // The persisted prepared outputs are the SDK's own serialization and
    // round-trip through it.
    for (const s of persisted[0]!) {
      const back = OutputData.deserialize(s);
      expect(back.blindedMessage.id).toBe(KEYSET_ID);
    }
  });

  it("recovers the exact payee outputs via NUT-09 restore when the mint reports the inputs SPENT", async () => {
    const proofs = [mintEscrowProof(AMOUNT)];

    // First attempt: real payout, capturing the prepared outputs the
    // durability hook received.
    let prepared: SerializedOutputData[] | undefined;
    const first = await executeEscrowPayout(
      makeRegistration(),
      "release",
      { proofs },
      {
        walletFactory: realWalletFactory,
        mintApiFactory: realMintApiFactory,
        persistPreparedOutputs: async (p) => {
          prepared = p;
        },
      }
    );
    expect(prepared).toBeDefined();

    // Second attempt (the crash-recovery replay): mint reports every input
    // SPENT, so the payout must NOT swap again — it reconstructs the payee's
    // proofs from the persisted prepared outputs via /v1/restore.
    checkMode = "SPENT";
    const recovered = await executeEscrowPayout(
      makeRegistration(),
      "release",
      { proofs },
      {
        walletFactory: realWalletFactory,
        mintApiFactory: realMintApiFactory,
        preparedOutputs: prepared,
      }
    );

    // No second swap happened.
    expect(swapRequestBody.inputs).toHaveLength(1); // only attempt #1's swap
    expect(getKeysPaths.some((p) => p === `/v1/keys/${KEYSET_ID}`)).toBe(true);
    expect(restoreRequestBody.outputs).toHaveLength(prepared!.length);

    // The recovered proofs are EXACTLY the proofs the first attempt produced
    // (same secrets + blinding factors → same unblinded signatures).
    const key = (p: Proof) => `${Number(p.amount)}:${p.secret}:${p.C}`;
    expect(recovered.outputs.map(key).sort()).toEqual(
      first.outputs.map(key).sort()
    );
    for (const p of recovered.outputs) {
      expect(lockDataXOnly(p.secret)).toBe(sellerPub);
      expect(proofVerifies(p)).toBe(true);
    }
  });

  it("real Wallet/Mint expose the exact surface executeEscrowPayout calls", async () => {
    const wallet = realWalletFactory(MINT_URL);
    const mintApi = realMintApiFactory(MINT_URL);
    expect(typeof wallet.loadMint).toBe("function");
    expect(typeof wallet.checkProofsStates).toBe("function");
    expect(typeof wallet.prepareSwapToReceive).toBe("function");
    expect(typeof wallet.completeSwap).toBe("function");
    expect(typeof mintApi.getKeys).toBe("function");
    expect(typeof mintApi.restore).toBe("function");

    // The NUT-07 response consumption: states come back in INPUT ORDER with
    // the Y the wallet computed via hash_to_curve(secret).
    await wallet.loadMint();
    const proof = mintEscrowProof(AMOUNT);
    const expectedY = hashToCurve(new TextEncoder().encode(proof.secret)).toHex(
      true
    );
    const states = await wallet.checkProofsStates([proof]);
    expect(states).toHaveLength(1);
    expect(states[0].Y).toBe(expectedY);
    expect(states[0].state).toBe("UNSPENT");
  });
});
