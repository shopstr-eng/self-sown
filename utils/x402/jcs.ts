// RFC 8785 JSON Canonicalization Scheme (JCS).
//
// The x402 lnbtc scheme hashes a JCS-encoded "binding object" as the request
// hash, so both sides must produce byte-identical JSON. This implements the
// subset of JCS needed for binding objects: null, booleans, finite numbers,
// strings, arrays, and objects with string keys.
//
// - Object members are sorted by UTF-16 code unit order (JS default string
//   sort semantics).
// - Numbers use ECMAScript Number::toString semantics (JSON.stringify), with
//   -0 normalized to 0 and non-finite / non-integer-safe values rejected.
// - Strings use the minimal JSON escape set with lowercase \u00xx hex for
//   remaining control characters.

function escapeString(value: string): string {
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    // RFC 8785: lone (unpaired) surrogates are invalid input — two different
    // strings must never collapse to the same replacement-character bytes.
    if (code >= 0xd800 && code <= 0xdfff) {
      throw new Error("JCS: unpaired surrogate in string");
    }
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code < 0x20) {
      out += "\\u" + code.toString(16).padStart(4, "0");
    } else {
      out += ch;
    }
  }
  return out + '"';
}

function serializeNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error("JCS: non-finite numbers are outside the data model");
  }
  if (Object.is(value, -0)) return "0";
  // All finite numbers (including 1e30 → "1e+30") serialize via ECMAScript
  // Number::toString, which is exactly the RFC 8785 es6numfmt algorithm and
  // is what JSON.stringify implements.
  return JSON.stringify(value);
}

export function canonicalizeJcs(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return serializeNumber(value);
  if (typeof value === "string") return escapeString(value);
  if (Array.isArray(value)) {
    return "[" + value.map((item) => canonicalizeJcs(item)).join(",") + "]";
  }
  if (typeof value === "object" && value !== undefined) {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts = keys.map((key) => {
      const member = obj[key];
      if (member === undefined) {
        throw new Error(`JCS: undefined member "${key}" is not serializable`);
      }
      return escapeString(key) + ":" + canonicalizeJcs(member);
    });
    return "{" + parts.join(",") + "}";
  }
  throw new Error(`JCS: unsupported value type ${typeof value}`);
}
