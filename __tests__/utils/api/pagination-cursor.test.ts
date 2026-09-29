import {
  decodePaginationCursor,
  encodePaginationCursor,
} from "@/utils/api/pagination-cursor";

const b64 = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

describe("pagination cursors", () => {
  it("round-trips an offset", () => {
    expect(decodePaginationCursor(encodePaginationCursor(0))).toBe(0);
    expect(decodePaginationCursor(encodePaginationCursor(42))).toBe(42);
  });

  it("round-trips an offset with a filter fingerprint", () => {
    const cursor = encodePaginationCursor(7, "host|milk||in_stock||3");
    expect(decodePaginationCursor(cursor, "host|milk||in_stock||3")).toBe(7);
  });

  it("rejects a cursor whose fingerprint no longer matches the query", () => {
    const cursor = encodePaginationCursor(7, "q=milk");
    expect(() => decodePaginationCursor(cursor, "q=eggs")).toThrow(
      "filters changed"
    );
  });

  it("distinguishes fingerprints whose components contain delimiters", () => {
    // Routes fingerprint with JSON.stringify(components) precisely so these
    // two different filter sets can't collide into one string.
    const a = JSON.stringify(["milk|eggs", "nuts"]);
    const b = JSON.stringify(["milk", "eggs|nuts"]);
    expect(a).not.toBe(b);
    const cursor = encodePaginationCursor(7, a);
    expect(() => decodePaginationCursor(cursor, b)).toThrow(
      "Invalid pagination cursor"
    );
  });

  it("produces opaque prefixed cursors", () => {
    const cursor = encodePaginationCursor(10);
    expect(cursor.startsWith("pg_")).toBe(true);
    expect(cursor).not.toContain("10");
  });

  it.each([
    "", // present-but-empty must NOT silently restart at page one
    "not-a-cursor",
    "pg_", // empty body
    "pg_!!!", // invalid charset
    "pg_" + b64({ o: 1 }) + "==", // padding junk the lenient decoder would eat
    "pg_" + b64({ o: 1 }) + "AA", // trailing junk appended after a valid body
    // 12-char body + one valid-alphabet char = length % 4 == 1, which Node's
    // decoder silently DROPS (would decode to the same payload) — the
    // canonical re-encode check must reject it.
    "pg_" + b64({ o: 123 }) + "A",
    "pg_" + b64({ o: -1 }),
    "pg_" + b64({ o: 1.5 }),
    "pg_" + b64({ o: 2 ** 53 }), // integer but not a SAFE integer
    "pg_" + b64({ nope: 1 }),
    "pg_" + Buffer.from("not json").toString("base64url"),
  ])("throws on malformed cursor (%s)", (cursor) => {
    expect(() => decodePaginationCursor(cursor)).toThrow(
      "Invalid pagination cursor"
    );
  });
});
