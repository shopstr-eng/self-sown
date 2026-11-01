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
  it("pauses when the seller has not seen the education", async () => {
    await expect(
      shouldShowEducationAfterConnect({ pubkey: "pk-a" })
    ).resolves.toBe(true);
  });

  it("never pauses when the education was already seen", async () => {
    await markTapToPayEducationSeen("pk-a");
    await expect(
      shouldShowEducationAfterConnect({ pubkey: "pk-a" })
    ).resolves.toBe(false);
  });

  it("never pauses without a seller identity (no hang on a missing session)", async () => {
    await expect(
      shouldShowEducationAfterConnect({ pubkey: null })
    ).resolves.toBe(false);
  });

  it("pauses an unseen seller again after a cancelled first attempt — a reused reader connection cannot skip the education", async () => {
    // Regression: the native SDK keeps the reader connected across PoS
    // screens, so the charge after a cancelled mid-education attempt reuses
    // the live connection. The education decision must key off the seen flag
    // alone, or that seller charges without ever seeing the education.
    const gate = createTapToPayEducationGate();
    const first = gate.waitForDismissal();
    gate.cancel();
    await expect(first).resolves.toBe("cancelled");

    await expect(
      shouldShowEducationAfterConnect({ pubkey: "pk-a" })
    ).resolves.toBe(true);
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
      shouldShowEducationAfterConnect({ pubkey: "pk-a" })
    ).resolves.toBe(false);
    // ...but the next seller on the same shared device still gets it.
    await expect(
      shouldShowEducationAfterConnect({ pubkey: "pk-b" })
    ).resolves.toBe(true);
  });

  it("dismiss without a pause is a safe no-op", () => {
    const gate = createTapToPayEducationGate();
    expect(() => gate.dismiss(null)).not.toThrow();
    expect(gate.isPaused()).toBe(false);
  });

  it("cancel without a pause is a safe no-op", () => {
    const gate = createTapToPayEducationGate();
    expect(() => gate.cancel()).not.toThrow();
    expect(gate.isPaused()).toBe(false);
  });

  it("cancel releases the pause as 'cancelled' so the sale unwinds without charging", async () => {
    const gate = createTapToPayEducationGate();
    let chargeCreated = false;

    // Mirrors runSale() leaving the screen mid-education: the wait resolves,
    // but with 'cancelled', so the sale stops before creating the charge.
    const sale = (async () => {
      if ((await gate.waitForDismissal()) === "cancelled") return;
      chargeCreated = true;
    })();

    expect(gate.isPaused()).toBe(true);
    gate.cancel();
    await sale;

    expect(chargeCreated).toBe(false);
    expect(gate.isPaused()).toBe(false);
  });

  it("cancel does NOT mark the education seen — the next first charge pauses again", async () => {
    const gate = createTapToPayEducationGate();
    const paused = gate.waitForDismissal();
    gate.cancel();
    await expect(paused).resolves.toBe("cancelled");

    await expect(
      shouldShowEducationAfterConnect({ pubkey: "pk-a" })
    ).resolves.toBe(true);
  });

  it("a cancel with nothing paused arms only the NEXT wait — it cannot cancel two", async () => {
    const gate = createTapToPayEducationGate();
    // Screen exit before any pause exists (e.g. unmount during the async
    // education-seen check).
    gate.cancel();

    await expect(gate.waitForDismissal()).resolves.toBe("cancelled");

    // The arm is consumed: a later wait pauses normally until dismissed.
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

  it("cancel before the wait starts still releases the sale (unmount during the async education check)", async () => {
    const gate = createTapToPayEducationGate();
    let chargeCreated = false;

    // Mirrors runSale(): the screen unmounts while the education check is
    // still awaiting, so the cleanup's cancel() lands before
    // waitForDismissal() is ever called.
    gate.cancel();

    const sale = (async () => {
      if (await shouldShowEducationAfterConnect({ pubkey: "pk-a" })) {
        if ((await gate.waitForDismissal()) === "cancelled") return;
      }
      chargeCreated = true;
    })();
    await sale;

    expect(chargeCreated).toBe(false);
    expect(gate.isPaused()).toBe(false);
    // Unseen was never marked, so the next attempt pauses again.
    await expect(
      shouldShowEducationAfterConnect({ pubkey: "pk-a" })
    ).resolves.toBe(true);
  });

  it("unmount mid-education (wiring shape): cancel resolves the sale and education still shows next attempt", async () => {
    const gate = createTapToPayEducationGate();
    let chargeCreated = false;

    // Mirrors runSale() + the unmount cleanup in card.tsx: the education
    // check pauses the sale, the screen unmounts, and the cleanup's cancel
    // unwinds the sale without charging or marking the education seen.
    const sale = (async () => {
      if (await shouldShowEducationAfterConnect({ pubkey: "pk-a" })) {
        if ((await gate.waitForDismissal()) === "cancelled") return;
      }
      chargeCreated = true;
    })();

    // Let the async education check settle into the pause.
    while (!gate.isPaused()) await Promise.resolve();
    expect(chargeCreated).toBe(false);

    gate.cancel();
    await sale;
    expect(chargeCreated).toBe(false);

    await expect(
      shouldShowEducationAfterConnect({ pubkey: "pk-a" })
    ).resolves.toBe(true);
  });

  it("wires the pause like the sale flow: check, pause, dismiss, resume", async () => {
    const gate = createTapToPayEducationGate();
    let saleContinued = false;

    // Mirrors runSale() in card.tsx: education check after the connect
    // resolution, then pause until the modal's onDone dismisses.
    const sale = (async () => {
      if (await shouldShowEducationAfterConnect({ pubkey: "pk-a" })) {
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
