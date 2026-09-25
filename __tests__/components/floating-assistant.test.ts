/** @jest-environment node */

// Pure-helper coverage for the floating assistant widget's bubble position:
// clamping keeps the 56px bubble fully inside the viewport, and stored
// positions survive a round-trip while garbage never does.

import {
  clampBubbleTop,
  readStoredBubblePosition,
  serializeBubblePosition,
  BUBBLE_POSITION_STORAGE_KEY,
} from "@/components/assistant/floating-assistant";

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

describe("clampBubbleTop", () => {
  it("keeps the bubble inside the viewport", () => {
    expect(clampBubbleTop(-50, 800)).toBe(16);
    expect(clampBubbleTop(400, 800)).toBe(400);
    // 800 - 56 (bubble) - 16 (gap) = 728
    expect(clampBubbleTop(9999, 800)).toBe(728);
  });

  it("handles tiny viewports without going below the gap", () => {
    expect(clampBubbleTop(100, 60)).toBe(16);
  });

  it("replaces non-finite input with the gap", () => {
    expect(clampBubbleTop(Number.NaN, 800)).toBe(16);
    expect(clampBubbleTop(Number.POSITIVE_INFINITY, 800)).toBe(16);
  });
});

describe("bubble position storage round-trip", () => {
  it("reads back what it wrote", () => {
    const storage = fakeStorage();
    storage.setItem(
      BUBBLE_POSITION_STORAGE_KEY,
      serializeBubblePosition({ side: "left", top: 123.6 })
    );
    expect(readStoredBubblePosition(storage, 800)).toEqual({
      side: "left",
      top: 124,
    });
  });

  it("clamps a stored position that no longer fits the viewport", () => {
    const storage = fakeStorage({
      [BUBBLE_POSITION_STORAGE_KEY]: JSON.stringify({
        side: "right",
        top: 4000,
      }),
    });
    expect(readStoredBubblePosition(storage, 800)).toEqual({
      side: "right",
      top: 728,
    });
  });

  it("rejects missing, malformed, and wrong-shaped values", () => {
    expect(readStoredBubblePosition(fakeStorage(), 800)).toBeNull();
    expect(
      readStoredBubblePosition(
        fakeStorage({ [BUBBLE_POSITION_STORAGE_KEY]: "not json{" }),
        800
      )
    ).toBeNull();
    expect(
      readStoredBubblePosition(
        fakeStorage({
          [BUBBLE_POSITION_STORAGE_KEY]: JSON.stringify({
            side: "middle",
            top: 100,
          }),
        }),
        800
      )
    ).toBeNull();
    expect(
      readStoredBubblePosition(
        fakeStorage({
          [BUBBLE_POSITION_STORAGE_KEY]: JSON.stringify({
            side: "left",
            top: "100",
          }),
        }),
        800
      )
    ).toBeNull();
  });
});
