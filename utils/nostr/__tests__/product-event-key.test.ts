import { NostrEvent } from "@/utils/types/types";
import {
  getProductEventKey,
  upsertProductEvent,
} from "@/utils/nostr/product-event-key";

const makeEvent = (overrides: Partial<NostrEvent> = {}): NostrEvent =>
  ({
    id: "event-id",
    pubkey: "seller",
    created_at: 1,
    kind: 30402,
    tags: [["d", "listing-1"]],
    content: "",
    sig: "sig",
    ...overrides,
  }) as NostrEvent;

describe("getProductEventKey", () => {
  it("keys kind 30402 products by pubkey:d-tag, not event id", () => {
    const a = makeEvent({ id: "id-a", pubkey: "seller", tags: [["d", "x"]] });
    const b = makeEvent({ id: "id-b", pubkey: "seller", tags: [["d", "x"]] });
    expect(getProductEventKey(a)).toBe("seller:x");
    expect(getProductEventKey(a)).toBe(getProductEventKey(b));
  });

  it("falls back to event id for non-replaceable events", () => {
    const note = makeEvent({ id: "note-id", kind: 1, tags: [] });
    expect(getProductEventKey(note)).toBe("note-id");
  });

  it("falls back to event id for a 30402 event missing its d tag", () => {
    const malformed = makeEvent({ id: "no-d", tags: [] });
    expect(getProductEventKey(malformed)).toBe("no-d");
  });
});

describe("upsertProductEvent", () => {
  it("appends a brand-new product", () => {
    const existing = [makeEvent({ id: "a", tags: [["d", "a"]] })];
    const incoming = makeEvent({ id: "b", tags: [["d", "b"]] });
    const result = upsertProductEvent(existing, incoming);
    expect(result).toHaveLength(2);
    expect(result.map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("replaces (does not duplicate) a republished product with the same d tag", () => {
    const old = makeEvent({
      id: "old",
      created_at: 100,
      tags: [["d", "milk"]],
    });
    const republished = makeEvent({
      id: "new",
      created_at: 200,
      tags: [["d", "milk"]],
    });
    const result = upsertProductEvent([old], republished);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("new");
  });

  it("ignores an older republish of an existing product", () => {
    const current = makeEvent({
      id: "current",
      created_at: 200,
      tags: [["d", "milk"]],
    });
    const stale = makeEvent({
      id: "stale",
      created_at: 100,
      tags: [["d", "milk"]],
    });
    const result = upsertProductEvent([current], stale);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("current");
  });

  it("preserves position when replacing so featured ordering is stable", () => {
    const first = makeEvent({ id: "f", created_at: 1, tags: [["d", "first"]] });
    const second = makeEvent({
      id: "s",
      created_at: 1,
      tags: [["d", "second"]],
    });
    const republishedFirst = makeEvent({
      id: "f2",
      created_at: 2,
      tags: [["d", "first"]],
    });
    const result = upsertProductEvent([first, second], republishedFirst);
    expect(result.map((e) => e.id)).toEqual(["f2", "s"]);
  });
});
