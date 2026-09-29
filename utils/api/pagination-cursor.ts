// Opaque cursor pagination for agent-facing list endpoints. The cursor encodes
// the next offset (the store layer is offset-based) plus a caller-supplied
// fingerprint of the active filter set, so changing filters mid-pagination
// fails loud with a 400 instead of silently skipping results. Keeping the
// payload opaque lets the encoding evolve without breaking agents, and matches
// the cursor-based convention agent tooling prefers over raw offset math.
// Offset params remain supported for backwards compatibility — a valid cursor
// wins when both are supplied.
//
// Pages are a moving snapshot: rows inserted between requests can shift
// offsets. Endpoints that promise continuity across writes need keyset
// pagination instead; neither current consumer does.

const CURSOR_PREFIX = "pg_";
// Node's base64url decoder silently ignores invalid characters, so validate
// the charset (and reject padding — toString("base64url") never emits it)
// before decoding; junk must 400, not decode to garbage.
const CURSOR_CHARSET = /^[A-Za-z0-9_-]+$/;

export function encodePaginationCursor(
  offset: number,
  fingerprint = ""
): string {
  return (
    CURSOR_PREFIX +
    Buffer.from(JSON.stringify({ o: offset, f: fingerprint })).toString(
      "base64url"
    )
  );
}

// Decodes a cursor produced by encodePaginationCursor. Throws on ANY mismatch
// — malformed encoding, bad offset, or a fingerprint that doesn't match the
// current query — and callers must turn that into a 400 rather than silently
// serving the first page (an agent paging from a bad position must notice).
export function decodePaginationCursor(
  cursor: string,
  fingerprint = ""
): number {
  const fail = (why: string): never => {
    throw new Error(`Invalid pagination cursor: ${why}`);
  };

  if (!cursor.startsWith(CURSOR_PREFIX)) fail("unknown prefix");
  const body = cursor.slice(CURSOR_PREFIX.length);
  if (!body || !CURSOR_CHARSET.test(body)) fail("malformed encoding");

  // Canonical-form check: Node's decoder silently DROPS valid-alphabet
  // trailing junk (an appended char that leaves the length % 4 == 1 decodes
  // to the same bytes), so a tampered cursor would otherwise be accepted.
  const decoded = Buffer.from(body, "base64url");
  if (decoded.toString("base64url") !== body) fail("non-canonical encoding");

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded.toString("utf8"));
  } catch {
    fail("malformed payload");
  }
  const o = (parsed as { o?: unknown } | null)?.o;
  // isSafeInteger, not isInteger: integers beyond 2^53 lose precision and
  // would misalign pages.
  if (typeof o !== "number" || !Number.isSafeInteger(o) || o < 0) {
    fail("offset is not a non-negative integer");
  }
  const f = (parsed as { f?: unknown } | null)?.f ?? "";
  if (f !== fingerprint) {
    fail("cursor does not match the current query (filters changed?)");
  }
  // Guarded above: o is a safe non-negative integer here.
  return o as number;
}
