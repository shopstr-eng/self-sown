/** @jest-environment node */

// Apple Tap to Pay merchant education (checklist v1.8, 4.2-4.8): slide
// content coverage and once-per-seller persistence.

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
  TAP_TO_PAY_EDUCATION_SLIDES,
  TAP_TO_PAY_EDUCATION_SLIDES_ANDROID,
  hasSeenTapToPayEducation,
  markTapToPayEducationSeen,
  tapToPayEducationSlidesFor,
  tapToPayEducationStorageKey,
} from "../../apps/mobile/lib/tap-to-pay-education";

beforeEach(() => {
  asyncStorageStore.clear();
  jest.clearAllMocks();
});

describe("TAP_TO_PAY_EDUCATION_SLIDES", () => {
  it("has stable unique ids and non-empty copy", () => {
    expect(TAP_TO_PAY_EDUCATION_SLIDES.length).toBeGreaterThanOrEqual(4);
    const ids = TAP_TO_PAY_EDUCATION_SLIDES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const slide of TAP_TO_PAY_EDUCATION_SLIDES) {
      expect(slide.title.trim().length).toBeGreaterThan(0);
      expect(slide.body.trim().length).toBeGreaterThan(0);
    }
  });

  it("demonstrates accepting contactless cards (Req 4.5)", () => {
    const slide = TAP_TO_PAY_EDUCATION_SLIDES.find(
      (s) => s.id === "contactless-cards"
    );
    expect(slide).toBeDefined();
    expect(slide!.body).toMatch(/contactless card/i);
    expect(slide!.body).toMatch(/near the top of your iPhone/i);
  });

  it("demonstrates accepting Apple Pay and digital wallets (Req 4.6)", () => {
    const slide = TAP_TO_PAY_EDUCATION_SLIDES.find(
      (s) => s.id === "apple-pay-wallets"
    );
    expect(slide).toBeDefined();
    expect(slide!.body).toMatch(/Apple Pay/);
    expect(slide!.body).toMatch(/digital wallet/i);
  });

  it("mentions PIN entry and PIN-screen accessibility (Req 4.7, US region)", () => {
    const slide = TAP_TO_PAY_EDUCATION_SLIDES.find((s) => s.id === "pin-entry");
    expect(slide).toBeDefined();
    expect(slide!.body).toMatch(/PIN/);
    expect(slide!.body).toMatch(/accessibility/i);
  });

  it("carries Apple's prescribed fallback-payment copy (Req 4.8)", () => {
    const slide = TAP_TO_PAY_EDUCATION_SLIDES.find(
      (s) => s.id === "fallback-payment"
    );
    expect(slide).toBeDefined();
    // Verbatim copy the guide requires on custom education screens.
    expect(slide!.body).toContain(
      "Some cards are not able to complete contactless transactions using a PIN"
    );
    expect(slide!.body).toMatch(
      /alternative contactless card or digital wallet/i
    );
  });
});

describe("TAP_TO_PAY_EDUCATION_SLIDES_ANDROID", () => {
  it("mirrors the iOS lesson coverage with device-neutral wording", () => {
    // Same four lessons in the same order so the pager behaves identically;
    // only the wording (and the dropped Apple Pay mark) differs.
    expect(TAP_TO_PAY_EDUCATION_SLIDES_ANDROID.map((s) => s.id)).toEqual([
      "contactless-cards",
      "digital-wallets",
      "pin-entry",
      "fallback-payment",
    ]);
    for (const slide of TAP_TO_PAY_EDUCATION_SLIDES_ANDROID) {
      expect(slide.title.trim().length).toBeGreaterThan(0);
      expect(slide.body.trim().length).toBeGreaterThan(0);
    }
  });

  it("never references Apple hardware, Apple Pay, or iOS features", () => {
    // The whole point of the Android set: an Android seller must not be
    // taught with iPhone/iOS/Apple wording (Apple's marks guidance also
    // forbids showing Apple marks where Apple Pay isn't offered).
    for (const slide of TAP_TO_PAY_EDUCATION_SLIDES_ANDROID) {
      const copy = `${slide.title} ${slide.body}`;
      expect(copy).not.toMatch(/iPhone|iOS|Apple|VoiceOver/);
      expect(slide.applePayMark).toBeUndefined();
    }
  });

  it("keeps the prescribed fallback-payment guidance", () => {
    const slide = TAP_TO_PAY_EDUCATION_SLIDES_ANDROID.find(
      (s) => s.id === "fallback-payment"
    );
    expect(slide).toBeDefined();
    expect(slide!.body).toContain(
      "Some cards are not able to complete contactless transactions using a PIN"
    );
    expect(slide!.body).toMatch(
      /alternative contactless card or digital wallet/i
    );
  });
});

describe("tapToPayEducationSlidesFor", () => {
  it("returns the Android set only for android, the Apple set otherwise", () => {
    expect(tapToPayEducationSlidesFor("android")).toBe(
      TAP_TO_PAY_EDUCATION_SLIDES_ANDROID
    );
    // iOS must keep the byte-identical Apple-review slides.
    expect(tapToPayEducationSlidesFor("ios")).toBe(TAP_TO_PAY_EDUCATION_SLIDES);
  });
});

describe("education persistence", () => {
  it("is scoped per seller pubkey and shows until marked seen", async () => {
    await expect(hasSeenTapToPayEducation("pk-a")).resolves.toBe(false);
    await markTapToPayEducationSeen("pk-a");
    await expect(hasSeenTapToPayEducation("pk-a")).resolves.toBe(true);
    // A shared device must not hide the education from the next account.
    await expect(hasSeenTapToPayEducation("pk-b")).resolves.toBe(false);
    expect(tapToPayEducationStorageKey("pk-a")).not.toBe(
      tapToPayEducationStorageKey("pk-b")
    );
  });

  it("fails open when storage read throws so education still shows", async () => {
    const storage = jest.requireMock(
      "@react-native-async-storage/async-storage"
    );
    storage.getItem.mockRejectedValueOnce(new Error("storage down"));
    await expect(hasSeenTapToPayEducation("pk-a")).resolves.toBe(false);
  });

  it("ignores storage write failures", async () => {
    const storage = jest.requireMock(
      "@react-native-async-storage/async-storage"
    );
    storage.setItem.mockRejectedValueOnce(new Error("storage down"));
    await expect(markTapToPayEducationSeen("pk-a")).resolves.toBeUndefined();
  });
});
