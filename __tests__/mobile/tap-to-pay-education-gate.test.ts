/** @jest-environment node */

// Apple checklist 4.2 wiring: the first in-person charge must pause on the
// merchant education screens and resume exactly once when dismissed. Covers
// the extracted gate used by apps/mobile/app/(tabs)/pos/card.tsx — a refactor
// must not let the sale proceed without the education, nor hang the sale if
// the modal's exit path stops resolving.

const asyncStorageStore = new Map<string, string>();

jest.mock(
  "@react-native-async-storage/async-storage",
  () => ({
    getItem: jest.fn(async (key: string) => asyncStorageStore.get(key) ?? null),
    setItem: jest.fn(async (key: string, value: string) => {
      asyncStorageStore.set(key, value);
    }),
    removeItem: jest.fn(async (key: string) => {
      asyncStorageStore.delete(key);
    }),
  }),
  { virtual: true }
);

import {
  createTapToPayEducationGate,
  markTapToPayEducationSeen,
  shouldShowEducationAfterConnect,
} from "../../apps/mobile/lib/tap-to-pay-education";

beforeEach(() => {
  asyncStorageStore.clear();
  jest.clearAllMocks();
});

describe("shouldShowEducationAfterConnect", () => {
  it("pauses on a fresh connect when the seller has not seen the education", async () => {
    await expect(
      shouldShowEducationAfterConnect({
        reusedConnection: false,
        pubkey: "pk-a",
      })
    ).resolves.toBe(true);
  });

  it("never pauses when the education was already seen", async () => {
    await markTapToPayEducationSeen("pk-a");
    await expect(
      shouldShowEducationAfterConnect({
        reusedConnection: false,
        pubkey: "pk-a",
      })
    ).resolves.toBe(false);
  });

  it("never pauses on a reused live reader connection, even when unseen", async () => {
    await expect(
      shouldShowEducationAfterConnect({
        reusedConnection: true,
        pubkey: "pk-a",
      })
    ).resolves.toBe(false);
  });

  it("never pauses without a seller identity (no hang on a missing session)", async () => {
    await expect(
      shouldShowEducationAfterConnect({
        reusedConnection: false,
        pubkey: null,
      })
    ).resolves.toBe(false);
  });
});

describe("education gate handshake", () => {
  it("holds the sale until the modal is dismissed, then resumes exactly once", async () => {
    const gate = createTapToPayEducationGate();
    const onResume = jest.fn();
    const paused = gate.waitForDismissal().then(onResume);

    expect(gate.isPaused()).toBe(true);
    expect(onResume).not.toHaveBeenCalled();

    gate.dismiss("pk-a");
    await paused;
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(gate.isPaused()).toBe(false);

    // A duplicate dismiss (e.g. double-tap on the modal's done button) is a
    // no-op and cannot resume anything twice.
    gate.dismiss("pk-a");
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  it("clears the resolver before release so a stale dismiss cannot release a later pause", async () => {
    const gate = createTapToPayEducationGate();
    const first = gate.waitForDismissal();
    gate.dismiss("pk-a");
    await first;

    // Stale extra dismiss left over from the first modal cycle.
    gate.dismiss("pk-a");

    let secondResumed = false;
    const second = gate.waitForDismissal().then(() => {
      secondResumed = true;
    });
    await Promise.resolve();
    expect(secondResumed).toBe(false);

    gate.dismiss("pk-a");
    await second;
    expect(secondResumed).toBe(true);
  });

  it("marks the education seen on dismiss so the next sale never pauses", async () => {
    const gate = createTapToPayEducationGate();
    const paused = gate.waitForDismissal();
    gate.dismiss("pk-a");
    await paused;

    await expect(
      shouldShowEducationAfterConnect({
        reusedConnection: false,
        pubkey: "pk-a",
      })
    ).resolves.toBe(false);
    // ...but the next seller on the same shared device still gets it.
    await expect(
      shouldShowEducationAfterConnect({
        reusedConnection: false,
        pubkey: "pk-b",
      })
    ).resolves.toBe(true);
  });

  it("dismiss without a pause is a safe no-op", () => {
    const gate = createTapToPayEducationGate();
    expect(() => gate.dismiss(null)).not.toThrow();
    expect(gate.isPaused()).toBe(false);
  });

  it("wires the pause like the sale flow: check, pause, dismiss, resume", async () => {
    const gate = createTapToPayEducationGate();
    let saleContinued = false;

    // Mirrors runSale() in card.tsx: education check after the connect
    // resolution, then pause until the modal's onDone dismisses.
    const sale = (async () => {
      if (
        await shouldShowEducationAfterConnect({
          reusedConnection: false,
          pubkey: "pk-a",
        })
      ) {
        await gate.waitForDismissal();
      }
      saleContinued = true;
    })();

    // Let the async education check settle into the pause.
    while (!gate.isPaused()) await Promise.resolve();
    expect(saleContinued).toBe(false);

    gate.dismiss("pk-a");
    await sale;
    expect(saleContinued).toBe(true);
  });
});
