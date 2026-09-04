// Tests for the escrow payout executor. Proof construction, signing, and
// signature verification all use the REAL @cashu/cashu-ts library (per the
// API-drift guardrail: mocked library tests stay green when the library
// changes semantics). Only the mint network calls are faked.

import {
  createP2PKsecret,
  signP2PKProof,
  schnorrSignMessage,
  OutputData,
  type Proof,
  type SerializedOutputData,
} from "@cashu/cashu-ts";
import { generateSecretKey, getPublicKey } from "nostr-tools";
import {
  executeEscrowPayout,
  validateEscrowPayoutProofs,
  type EscrowPayoutMintApi,
  type EscrowPayoutMintWallet,
} from "@/utils/cashu/escrow-payout";
import type { EscrowRegistration } from "@/utils/db/cashu-escrow-service";

const sellerSecret = generateSecretKey();
const buyerSecret = generateSecretKey();
const sellerPriv = Buffer.from(sellerSecret).toString("hex");
const buyerPriv = Buffer.from(buyerSecret).toString("hex");
const sellerPub = getPublicKey(sellerSecret);
const buyerPub = getPublicKey(buyerSecret);
const outsiderSecret = generateSecretKey();
const outsiderPriv = Buffer.from(outsiderSecret).toString("hex");

const LOCKTIME = Math.floor(Date.now() / 1000) + 86_400;
const KEYSET_ID = "009a1f293253e41e";

/** A syntactically valid secp256k1 point (used for fake keysets/signatures). */
function validPointHex(): string {
  return "02" + getPublicKey(generateSecretKey());
}

function makeRegistration(
  overrides: Partial<EscrowRegistration> = {}
): EscrowRegistration {
  return {
    escrowId: `${buyerPub}:order-1`,
    buyerPubkey: buyerPub,
    sellerPubkey: sellerPub,
    orderId: "order-1",
    amountSats: 5_000,
    mintUrl: "https://mint.example",
    arbiterPubkey: null,
    expiresAt: new Date(LOCKTIME * 1000),
    status: "locked",
    ...overrides,
  };
}

/** A real P2PK-locked proof for the escrow, signed by the given key. */
function makeSignedProof(
  signerPriv: string,
  overrides: {
    amount?: number;
    locktime?: number;
    refundTo?: string;
    lockTo?: string;
    extraTags?: string[][];
  } = {}
): Proof {
  const tags: string[][] = [
    ["locktime", String(overrides.locktime ?? LOCKTIME)],
    ["refund", overrides.refundTo ?? buyerPub],
    ...(overrides.extraTags ?? []),
  ];
  const proof: Proof = {
    amount: overrides.amount ?? 5_000,
    id: KEYSET_ID,
    secret: createP2PKsecret(overrides.lockTo ?? sellerPub, tags),
    C: validPointHex(),
  } as unknown as Proof;
  // signP2PKProof only signs when the key is in the lock's expected-witness
  // set, which excludes refund keys before locktime. The refund path is
  // still a plain Schnorr signature over the secret, so attach it manually —
  // the mint verifies it the same way after the lock expires.
  if (signerPriv === sellerPriv && !overrides.lockTo) {
    return signP2PKProof(proof, signerPriv);
  }
  return {
    ...proof,
    witness: JSON.stringify({
      signatures: [schnorrSignMessage(proof.secret, signerPriv)],
    }),
  };
}

/** Attach a witness signature from a key the lock does NOT expect. */
function signWithWrongKey(proof: Proof, wrongPriv: string): Proof {
  return {
    ...proof,
    witness: JSON.stringify({
      signatures: [schnorrSignMessage(proof.secret, wrongPriv)],
    }),
  };
}

function makeUnsignedProof(overrides: { lockTo?: string } = {}): Proof {
  return {
    amount: 5_000,
    id: KEYSET_ID,
    secret: createP2PKsecret(overrides.lockTo ?? sellerPub, [
      ["locktime", String(LOCKTIME)],
      ["refund", buyerPub],
    ]),
    C: validPointHex(),
  } as unknown as Proof;
}

function fakeWallet(
  states: Array<{ state: string }>,
  outputs: Proof[] = [{ amount: 4_999 } as unknown as Proof]
) {
  // Real prepared output data so OutputData.serialize sees valid shapes.
  const preview = {
    amount: 4_999,
    fees: 1,
    keysetId: KEYSET_ID,
    inputs: [],
    keepOutputs: [
      OutputData.createSingleP2PKData({ pubkey: sellerPub }, 4_999, KEYSET_ID),
    ],
  };
  const wallet: EscrowPayoutMintWallet = {
    checkProofsStates: jest.fn(async () => states as any),
    prepareSwapToReceive: jest.fn(async () => preview as any),
    completeSwap: jest.fn(async () => ({ keep: outputs, send: [] }) as any),
    loadMint: jest.fn(async () => {}) as any,
  };
  return wallet;
}

function persistMock() {
  return jest.fn(async (_prepared: SerializedOutputData[]) => {});
}

describe("validateEscrowPayoutProofs", () => {
  const registration = makeRegistration();

  it("accepts a seller-signed release payload", () => {
    const proofs = [makeSignedProof(sellerPriv)];
    expect(() =>
      validateEscrowPayoutProofs(registration, "release", proofs, LOCKTIME - 10)
    ).not.toThrow();
  });

  it("accepts a buyer-signed refund payload after expiry", () => {
    const proofs = [makeSignedProof(buyerPriv)];
    expect(() =>
      validateEscrowPayoutProofs(registration, "refund", proofs, LOCKTIME + 10)
    ).not.toThrow();
  });

  it("skips the witness check only when requireWitness is false", () => {
    // release-approve's structural pre-check: the buyer hands over RAW
    // proofs; only the seller's key can witness them (the next step).
    const proofs = [makeUnsignedProof()];
    expect(() =>
      validateEscrowPayoutProofs(
        registration,
        "release",
        proofs,
        LOCKTIME - 10,
        { requireWitness: false }
      )
    ).not.toThrow();
    expect(() =>
      validateEscrowPayoutProofs(registration, "release", proofs, LOCKTIME - 10)
    ).toThrow(/not signed by the seller/);
  });

  it("rejects a release once the lock has expired", () => {
    const proofs = [makeSignedProof(sellerPriv)];
    expect(() =>
      validateEscrowPayoutProofs(registration, "release", proofs, LOCKTIME)
    ).toThrow(/lock has expired/);
  });

  it("rejects a refund before the lock expires", () => {
    const proofs = [makeSignedProof(buyerPriv)];
    expect(() =>
      validateEscrowPayoutProofs(registration, "refund", proofs, LOCKTIME - 10)
    ).toThrow(/not expired/);
  });

  it("rejects a release not signed by the seller", () => {
    const proofs = [signWithWrongKey(makeUnsignedProof(), outsiderPriv)];
    expect(() =>
      validateEscrowPayoutProofs(registration, "release", proofs, LOCKTIME - 10)
    ).toThrow(/not signed by the seller/);
  });

  it("rejects a refund not signed by the buyer", () => {
    const proofs = [makeSignedProof(sellerPriv)];
    expect(() =>
      validateEscrowPayoutProofs(registration, "refund", proofs, LOCKTIME + 10)
    ).toThrow(/not signed by the buyer/);
  });

  it("rejects proofs not locked to the committed seller", () => {
    const proofs = [
      signWithWrongKey(makeUnsignedProof({ lockTo: buyerPub }), sellerPriv),
    ];
    expect(() =>
      validateEscrowPayoutProofs(registration, "release", proofs, LOCKTIME - 10)
    ).toThrow(/not locked to the committed seller/);
  });

  it("rejects a locktime that disagrees with the commitment", () => {
    const proofs = [
      makeSignedProof(sellerPriv, { locktime: LOCKTIME + 3_600 }),
    ];
    expect(() =>
      validateEscrowPayoutProofs(registration, "release", proofs, LOCKTIME - 10)
    ).toThrow(/locktime does not match/);
  });

  it("rejects a refund key that is not the committed buyer", () => {
    const proofs = [
      makeSignedProof(sellerPriv, { refundTo: getPublicKey(outsiderSecret) }),
    ];
    expect(() =>
      validateEscrowPayoutProofs(registration, "release", proofs, LOCKTIME - 10)
    ).toThrow(/refund key does not match/);
  });

  it("rejects SIG_ALL locks the keyless server cannot spend", () => {
    const proofs = [
      makeSignedProof(sellerPriv, { extraTags: [["sigflag", "SIG_ALL"]] }),
    ];
    expect(() =>
      validateEscrowPayoutProofs(registration, "release", proofs, LOCKTIME - 10)
    ).toThrow(/SIG_ALL/);
  });

  it("rejects multisig constructions", () => {
    const proofs = [
      makeSignedProof(sellerPriv, { extraTags: [["n_sigs", "2"]] }),
    ];
    expect(() =>
      validateEscrowPayoutProofs(registration, "release", proofs, LOCKTIME - 10)
    ).toThrow(/multisig/);
  });

  it("rejects a `pubkeys` tag that would widen the lock to 1-of-2", () => {
    const proofs = [
      makeSignedProof(sellerPriv, {
        extraTags: [["pubkeys", getPublicKey(outsiderSecret)]],
      }),
    ];
    expect(() =>
      validateEscrowPayoutProofs(registration, "release", proofs, LOCKTIME - 10)
    ).toThrow(/commitment never named/);
  });

  it("rejects unknown tags — NUT-11 tags carry mint semantics", () => {
    const proofs = [
      makeSignedProof(sellerPriv, { extraTags: [["httl", "9999999999"]] }),
    ];
    expect(() =>
      validateEscrowPayoutProofs(registration, "release", proofs, LOCKTIME - 10)
    ).toThrow(/unsupported P2PK tag/);
  });

  it("rejects non-P2PK secrets", () => {
    const proofs = [
      { amount: 5_000, id: KEYSET_ID, secret: "plain", C: validPointHex() },
    ] as unknown as Proof[];
    expect(() =>
      validateEscrowPayoutProofs(registration, "release", proofs, LOCKTIME - 10)
    ).toThrow(/not a P2PK-locked proof/);
  });

  it("rejects proofs that do not cover the committed amount", () => {
    const proofs = [makeSignedProof(sellerPriv, { amount: 4_999 })];
    expect(() =>
      validateEscrowPayoutProofs(registration, "release", proofs, LOCKTIME - 10)
    ).toThrow(/do not cover the committed amount/);
  });
});

describe("executeEscrowPayout", () => {
  const registration = makeRegistration();
  const nowSeconds = LOCKTIME - 10;

  it("checks state, persists prepared outputs BEFORE the swap, then finalizes", async () => {
    const proofs = [makeSignedProof(sellerPriv)];
    const wallet = fakeWallet([{ state: "UNSPENT" }]);
    const persist = persistMock();

    const result = await executeEscrowPayout(
      registration,
      "release",
      { proofs },
      {
        walletFactory: () => wallet,
        persistPreparedOutputs: persist,
        nowSeconds,
      }
    );

    expect(wallet.checkProofsStates).toHaveBeenCalledWith(proofs);
    expect(wallet.prepareSwapToReceive).toHaveBeenCalledWith(
      proofs,
      undefined,
      { type: "p2pk", options: { pubkey: sellerPub } }
    );
    expect(persist).toHaveBeenCalledTimes(1);
    const persisted = persist.mock.calls[0]![0]!;
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.blindedMessage.B_).toMatch(/^[0-9a-f]{66}$/);

    // Order: state check → prepare → PERSIST → swap. Persistence before the
    // mint call is the crash-recovery invariant.
    const order = (fn: jest.Mock) => fn.mock.invocationCallOrder[0]!;
    expect(order(wallet.checkProofsStates as jest.Mock)).toBeLessThan(
      order(wallet.prepareSwapToReceive as jest.Mock)
    );
    expect(order(wallet.prepareSwapToReceive as jest.Mock)).toBeLessThan(
      order(persist)
    );
    expect(order(persist)).toBeLessThan(
      order(wallet.completeSwap as jest.Mock)
    );
    expect(result.outputs).toHaveLength(1);
  });

  it("refunds pay the buyer", async () => {
    const proofs = [makeSignedProof(buyerPriv)];
    const wallet = fakeWallet([{ state: "UNSPENT" }]);

    await executeEscrowPayout(
      registration,
      "refund",
      { proofs },
      {
        walletFactory: () => wallet,
        persistPreparedOutputs: persistMock(),
        nowSeconds: LOCKTIME + 10,
      }
    );

    expect(wallet.prepareSwapToReceive).toHaveBeenCalledWith(
      proofs,
      undefined,
      { type: "p2pk", options: { pubkey: buyerPub } }
    );
  });

  it("NEVER re-pays when inputs are SPENT and no prepared outputs exist", async () => {
    const proofs = [makeSignedProof(sellerPriv)];
    const wallet = fakeWallet([{ state: "SPENT" }]);

    await expect(
      executeEscrowPayout(
        registration,
        "release",
        { proofs },
        {
          walletFactory: () => wallet,
          persistPreparedOutputs: persistMock(),
          nowSeconds,
        }
      )
    ).rejects.toThrow(/already SPENT/);
    expect(wallet.prepareSwapToReceive).not.toHaveBeenCalled();
    expect(wallet.completeSwap).not.toHaveBeenCalled();
  });

  it("recovers the payee's proofs via NUT-09 restore when SPENT with prepared outputs", async () => {
    const proofs = [makeSignedProof(sellerPriv)];
    const wallet = fakeWallet([{ state: "SPENT" }]);
    // The persisted prepared outputs from the crashed attempt.
    const preparedOutput = OutputData.createSingleP2PKData(
      { pubkey: sellerPub },
      4,
      KEYSET_ID
    );
    const prepared: SerializedOutputData[] = [
      OutputData.serialize(preparedOutput),
    ];
    const keysetKeys = { "4": validPointHex() };
    const mintApi: EscrowPayoutMintApi = {
      getKeys: jest.fn(async () => ({
        keysets: [{ id: KEYSET_ID, unit: "sat", keys: keysetKeys }],
      })) as any,
      restore: jest.fn(async ({ outputs }: any) => ({
        outputs,
        signatures: outputs.map((o: any) => ({
          id: o.id,
          amount: o.amount,
          C_: validPointHex(),
        })),
      })) as any,
    };

    const result = await executeEscrowPayout(
      registration,
      "release",
      { proofs },
      {
        walletFactory: () => wallet,
        mintApiFactory: () => mintApi,
        persistPreparedOutputs: persistMock(),
        preparedOutputs: prepared,
        nowSeconds,
      }
    );

    expect(wallet.completeSwap).not.toHaveBeenCalled();
    expect(mintApi.restore).toHaveBeenCalledWith({
      outputs: [
        {
          amount: 4,
          id: KEYSET_ID,
          B_: prepared[0]!.blindedMessage.B_,
        },
      ],
    });
    expect(result.outputs).toHaveLength(1);
    expect(Number(result.outputs[0]!.amount)).toBe(4);
    // The reconstructed proof carries the SAME payee-locked secret.
    expect(result.outputs[0]!.secret).toBe(
      Buffer.from(preparedOutput.secret).toString("utf-8")
    );
  });

  it.each([
    ["UNSPENT", [{ state: "SPENT" }, { state: "UNSPENT" }]],
    ["PENDING", [{ state: "SPENT" }, { state: "PENDING" }]],
    ["an unknown state", [{ state: "SPENT" }, { state: "WAT" }]],
  ])(
    "refuses to pay AND refuses to restore on a mixed SPENT+%s state set",
    async (_label, states) => {
      const proofs = [makeSignedProof(sellerPriv), makeSignedProof(sellerPriv)];
      const wallet = fakeWallet(states);
      const mintApi: EscrowPayoutMintApi = {
        getKeys: jest.fn() as any,
        restore: jest.fn() as any,
      };
      const prepared: SerializedOutputData[] = [
        OutputData.serialize(
          OutputData.createSingleP2PKData({ pubkey: sellerPub }, 4, KEYSET_ID)
        ),
      ];

      await expect(
        executeEscrowPayout(
          registration,
          "release",
          { proofs },
          {
            walletFactory: () => wallet,
            mintApiFactory: () => mintApi,
            persistPreparedOutputs: persistMock(),
            preparedOutputs: prepared,
            nowSeconds,
          }
        )
      ).rejects.toThrow(/inconsistent input state/);
      expect(wallet.prepareSwapToReceive).not.toHaveBeenCalled();
      expect(wallet.completeSwap).not.toHaveBeenCalled();
      expect(mintApi.restore).not.toHaveBeenCalled();
    }
  );

  it("defers when inputs are PENDING in an in-flight swap", async () => {
    const proofs = [makeSignedProof(sellerPriv)];
    const wallet = fakeWallet([{ state: "PENDING" }]);

    await expect(
      executeEscrowPayout(
        registration,
        "release",
        { proofs },
        {
          walletFactory: () => wallet,
          persistPreparedOutputs: persistMock(),
          nowSeconds,
        }
      )
    ).rejects.toThrow(/PENDING/);
    expect(wallet.prepareSwapToReceive).not.toHaveBeenCalled();
  });

  it("fails closed on an incomplete proof-state response", async () => {
    const proofs = [makeSignedProof(sellerPriv), makeSignedProof(sellerPriv)];
    const wallet = fakeWallet([{ state: "UNSPENT" }]); // one state for two proofs

    await expect(
      executeEscrowPayout(
        registration,
        "release",
        { proofs },
        {
          walletFactory: () => wallet,
          persistPreparedOutputs: persistMock(),
          nowSeconds,
        }
      )
    ).rejects.toThrow(/incomplete proof-state/);
    expect(wallet.prepareSwapToReceive).not.toHaveBeenCalled();
  });

  it("fails closed on an unrecognized proof state", async () => {
    const proofs = [makeSignedProof(sellerPriv)];
    const wallet = fakeWallet([{ state: "WAT" }]);

    await expect(
      executeEscrowPayout(
        registration,
        "release",
        { proofs },
        {
          walletFactory: () => wallet,
          persistPreparedOutputs: persistMock(),
          nowSeconds,
        }
      )
    ).rejects.toThrow(/unrecognized proof state/);
    expect(wallet.prepareSwapToReceive).not.toHaveBeenCalled();
  });

  it("refuses to pay without a durable prepared-output persistence hook", async () => {
    const proofs = [makeSignedProof(sellerPriv)];
    const wallet = fakeWallet([{ state: "UNSPENT" }]);

    await expect(
      executeEscrowPayout(
        registration,
        "release",
        { proofs },
        { walletFactory: () => wallet, nowSeconds }
      )
    ).rejects.toThrow(/durable prepared-output persistence/);
    expect(wallet.completeSwap).not.toHaveBeenCalled();
  });

  it("aborts the swap when prepared outputs cannot be persisted", async () => {
    const proofs = [makeSignedProof(sellerPriv)];
    const wallet = fakeWallet([{ state: "UNSPENT" }]);
    const persist = jest.fn(async () => {
      throw new Error("claim lost");
    });

    await expect(
      executeEscrowPayout(
        registration,
        "release",
        { proofs },
        {
          walletFactory: () => wallet,
          persistPreparedOutputs: persist,
          nowSeconds,
        }
      )
    ).rejects.toThrow(/claim lost/);
    expect(wallet.completeSwap).not.toHaveBeenCalled();
  });

  it("throws when no signed payout proofs are attached", async () => {
    const wallet = fakeWallet([]);
    await expect(
      executeEscrowPayout(registration, "release", null, {
        walletFactory: () => wallet,
        persistPreparedOutputs: persistMock(),
        nowSeconds,
      })
    ).rejects.toThrow(/no signed payout proofs/);
    expect(wallet.checkProofsStates).not.toHaveBeenCalled();
  });

  it("validates before ever touching the mint", async () => {
    const proofs = [makeSignedProof(buyerPriv)]; // wrong signer for a release
    const wallet = fakeWallet([{ state: "UNSPENT" }]);
    await expect(
      executeEscrowPayout(
        registration,
        "release",
        { proofs },
        {
          walletFactory: () => wallet,
          persistPreparedOutputs: persistMock(),
          nowSeconds,
        }
      )
    ).rejects.toThrow(/not signed by the seller/);
    expect(wallet.checkProofsStates).not.toHaveBeenCalled();
  });
});

// ── Committed-arbiter 2-of-3 construction ────────────────────────────────────
//
// When the registration names an arbiter, the lock MUST be 2-of-3 over
// {seller, buyer, arbiter} (data = seller, pubkeys = {buyer, arbiter},
// n_sigs = 2) — never weaker, never with substituted spenders — and the
// witness rules depend on who is directing the payout.

const arbiterSecret = generateSecretKey();
const arbiterPriv = Buffer.from(arbiterSecret).toString("hex");
const arbiterPub = getPublicKey(arbiterSecret);

/** A real P2PK-locked proof for a 2-of-3 arbiter escrow, signed by N keys. */
function makeMultisigProof(
  signerPrivs: string[],
  overrides: {
    amount?: number;
    locktime?: number;
    refundTo?: string;
    lockTo?: string;
    pubkeys?: string[];
    nSigs?: string;
    nSigsRefund?: string;
    omitPubkeys?: boolean;
    extraTags?: string[][];
  } = {}
): Proof {
  const tags: string[][] = [
    ["locktime", String(overrides.locktime ?? LOCKTIME)],
    ["refund", overrides.refundTo ?? buyerPub],
  ];
  if (!overrides.omitPubkeys) {
    tags.push(["pubkeys", ...(overrides.pubkeys ?? [buyerPub, arbiterPub])]);
  }
  tags.push(["n_sigs", overrides.nSigs ?? "2"]);
  if (overrides.nSigsRefund) tags.push(["n_sigs_refund", overrides.nSigsRefund]);
  tags.push(...(overrides.extraTags ?? []));
  const proof: Proof = {
    amount: overrides.amount ?? 5_000,
    id: KEYSET_ID,
    secret: createP2PKsecret(overrides.lockTo ?? sellerPub, tags),
    C: validPointHex(),
  } as unknown as Proof;
  if (signerPrivs.length === 0) return proof;
  // Manual witnesses: full control over exactly which keys signed.
  return {
    ...proof,
    witness: JSON.stringify({
      signatures: signerPrivs.map((sk) => schnorrSignMessage(proof.secret, sk)),
    }),
  };
}

const arbiterRegistration = () => makeRegistration({ arbiterPubkey: arbiterPub });

describe("validateEscrowPayoutProofs — committed-arbiter 2-of-3", () => {
  it("accepts a party release witnessed by seller + buyer", () => {
    expect(() =>
      validateEscrowPayoutProofs(arbiterRegistration(), "release", [
        makeMultisigProof([sellerPriv, buyerPriv]),
      ])
    ).not.toThrow();
  });

  it("accepts a party release witnessed by seller + arbiter", () => {
    expect(() =>
      validateEscrowPayoutProofs(arbiterRegistration(), "release", [
        makeMultisigProof([sellerPriv, arbiterPriv]),
      ])
    ).not.toThrow();
  });

  it("rejects a party release witnessed by the seller alone", () => {
    expect(() =>
      validateEscrowPayoutProofs(arbiterRegistration(), "release", [
        makeMultisigProof([sellerPriv]),
      ])
    ).toThrow(/seller and one other party/);
  });

  it("accepts an arbiter-directed release witnessed by arbiter + buyer", () => {
    expect(() =>
      validateEscrowPayoutProofs(
        arbiterRegistration(),
        "release",
        [makeMultisigProof([arbiterPriv, buyerPriv])],
        undefined,
        { directedByArbiter: true }
      )
    ).not.toThrow();
  });

  it("accepts an arbiter-directed release witnessed by arbiter + seller", () => {
    expect(() =>
      validateEscrowPayoutProofs(
        arbiterRegistration(),
        "release",
        [makeMultisigProof([arbiterPriv, sellerPriv])],
        undefined,
        { directedByArbiter: true }
      )
    ).not.toThrow();
  });

  it("rejects an arbiter-directed release witnessed by the arbiter alone", () => {
    expect(() =>
      validateEscrowPayoutProofs(
        arbiterRegistration(),
        "release",
        [makeMultisigProof([arbiterPriv])],
        undefined,
        { directedByArbiter: true }
      )
    ).toThrow(/arbiter and one party/);
  });

  it("rejects an arbiter-directed release without the arbiter's witness", () => {
    expect(() =>
      validateEscrowPayoutProofs(
        arbiterRegistration(),
        "release",
        [makeMultisigProof([buyerPriv, sellerPriv])],
        undefined,
        { directedByArbiter: true }
      )
    ).toThrow(/arbiter and one party/);
  });

  it("accepts an arbiter-directed refund BEFORE expiry (arbiter + buyer)", () => {
    // The dispute case: seller unresponsive pre-expiry — the 2-of-3 witness
    // replaces the timelock as the authorization.
    expect(() =>
      validateEscrowPayoutProofs(
        arbiterRegistration(),
        "refund",
        [makeMultisigProof([arbiterPriv, buyerPriv])],
        undefined,
        { directedByArbiter: true }
      )
    ).not.toThrow();
  });

  it("rejects an arbiter-directed refund without the buyer's witness", () => {
    expect(() =>
      validateEscrowPayoutProofs(
        arbiterRegistration(),
        "refund",
        [makeMultisigProof([arbiterPriv, sellerPriv])],
        undefined,
        { directedByArbiter: true }
      )
    ).toThrow(/arbiter and the buyer/);
  });

  it("still rejects a party refund before expiry on a multisig lock", () => {
    expect(() =>
      validateEscrowPayoutProofs(arbiterRegistration(), "refund", [
        makeMultisigProof([buyerPriv]),
      ])
    ).toThrow(/not expired/);
  });

  it("rejects an arbiter-directed release after expiry", () => {
    expect(() =>
      validateEscrowPayoutProofs(
        arbiterRegistration(),
        "release",
        [makeMultisigProof([arbiterPriv, buyerPriv])],
        LOCKTIME + 1,
        { directedByArbiter: true }
      )
    ).toThrow(/lock has expired/);
  });

  it("rejects a pubkeys tag when the commitment named NO arbiter", () => {
    expect(() =>
      validateEscrowPayoutProofs(makeRegistration(), "release", [
        makeMultisigProof([sellerPriv, buyerPriv]),
      ])
    ).toThrow(/commitment never named/);
  });

  it("rejects a 1-of-1 lock when the commitment DID name an arbiter", () => {
    expect(() =>
      validateEscrowPayoutProofs(arbiterRegistration(), "release", [
        makeMultisigProof([sellerPriv], { omitPubkeys: true, nSigs: "1" }),
      ])
    ).toThrow(/2-of-3 arbiter lock/);
  });

  it("rejects a substituted second spender in the pubkeys tag", () => {
    const outsiderPub = getPublicKey(outsiderSecret);
    expect(() =>
      validateEscrowPayoutProofs(arbiterRegistration(), "release", [
        makeMultisigProof([sellerPriv, buyerPriv], {
          pubkeys: [buyerPub, outsiderPub],
        }),
      ])
    ).toThrow(/2-of-3 arbiter lock/);
  });

  it("rejects n_sigs=1 on the committed-arbiter construction", () => {
    expect(() =>
      validateEscrowPayoutProofs(arbiterRegistration(), "release", [
        makeMultisigProof([sellerPriv, buyerPriv], { nSigs: "1" }),
      ])
    ).toThrow(/exactly 2 signatures/);
  });

  it("rejects a weakened refund path (n_sigs_refund > 1)", () => {
    expect(() =>
      validateEscrowPayoutProofs(arbiterRegistration(), "release", [
        makeMultisigProof([sellerPriv, buyerPriv], { nSigsRefund: "2" }),
      ])
    ).toThrow(/refund path/);
  });

  it("rejects a duplicate n_sigs tag", () => {
    // createP2PKsecret itself refuses duplicate tags, but a hostile client
    // can hand-craft the secret JSON — the validator must still reject it.
    const secret = JSON.stringify([
      "P2PK",
      {
        nonce: Buffer.from(generateSecretKey()).toString("hex"),
        data: sellerPub,
        tags: [
          ["locktime", String(LOCKTIME)],
          ["refund", buyerPub],
          ["pubkeys", buyerPub, arbiterPub],
          ["n_sigs", "2"],
          ["n_sigs", "2"],
        ],
      },
    ]);
    const proof = {
      amount: 5_000,
      id: KEYSET_ID,
      secret,
      C: validPointHex(),
      witness: JSON.stringify({
        signatures: [sellerPriv, buyerPriv].map((sk) =>
          schnorrSignMessage(secret, sk)
        ),
      }),
    } as unknown as Proof;
    expect(() =>
      validateEscrowPayoutProofs(arbiterRegistration(), "release", [proof])
    ).toThrow(/duplicate multisig tag/);
  });
});

// The endpoint→worker handoff: the resolve endpoint validates with
// directedByArbiter and persists that direction INSIDE the outbox payload
// (server-attested). The worker revalidates every payload before paying, so
// the executor must honor the flag or directed resolutions could never
// execute — and must IGNORE it when the registration names no arbiter.
describe("executeEscrowPayout — arbiter-directed payloads", () => {
  it("executes a pre-expiry directed refund witnessed by arbiter + buyer", async () => {
    const proofs = [makeMultisigProof([arbiterPriv, buyerPriv])];
    const wallet = fakeWallet([{ state: "UNSPENT" }]);
    const result = await executeEscrowPayout(
      arbiterRegistration(),
      "refund",
      { proofs, directedByArbiter: true },
      {
        walletFactory: () => wallet,
        persistPreparedOutputs: persistMock(),
        nowSeconds: LOCKTIME - 10, // BEFORE expiry — a party refund would throw
      }
    );
    expect(wallet.checkProofsStates).toHaveBeenCalledWith(proofs);
    expect(wallet.prepareSwapToReceive).toHaveBeenCalledWith(
      proofs,
      undefined,
      { type: "p2pk", options: { pubkey: buyerPub } }
    );
    expect(result.outputs).toHaveLength(1);
  });

  it("executes a directed release witnessed by arbiter + buyer (no seller sig)", async () => {
    const proofs = [makeMultisigProof([arbiterPriv, buyerPriv])];
    const wallet = fakeWallet([{ state: "UNSPENT" }]);
    await executeEscrowPayout(
      arbiterRegistration(),
      "release",
      { proofs, directedByArbiter: true },
      {
        walletFactory: () => wallet,
        persistPreparedOutputs: persistMock(),
        nowSeconds: LOCKTIME - 10,
      }
    );
    expect(wallet.prepareSwapToReceive).toHaveBeenCalledWith(
      proofs,
      undefined,
      { type: "p2pk", options: { pubkey: sellerPub } }
    );
  });

  it("rejects the same directed proofs when the payload lacks the server flag", async () => {
    const proofs = [makeMultisigProof([arbiterPriv, buyerPriv])];
    const wallet = fakeWallet([{ state: "UNSPENT" }]);
    await expect(
      executeEscrowPayout(
        arbiterRegistration(),
        "refund",
        { proofs }, // no directedByArbiter — re-judged under party rules
        {
          walletFactory: () => wallet,
          persistPreparedOutputs: persistMock(),
          nowSeconds: LOCKTIME - 10,
        }
      )
    ).rejects.toThrow(/not expired/);
    expect(wallet.checkProofsStates).not.toHaveBeenCalled();
  });

  it("the flag is inert when the registration names no arbiter", async () => {
    const proofs = [makeSignedProof(buyerPriv)]; // buyer witness on a RELEASE
    const wallet = fakeWallet([{ state: "UNSPENT" }]);
    await expect(
      executeEscrowPayout(
        makeRegistration(),
        "release",
        { proofs, directedByArbiter: true },
        {
          walletFactory: () => wallet,
          persistPreparedOutputs: persistMock(),
          nowSeconds: LOCKTIME - 10,
        }
      )
    ).rejects.toThrow(/not signed by the seller/);
    expect(wallet.checkProofsStates).not.toHaveBeenCalled();
  });
});
