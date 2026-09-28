/** @jest-environment node */

/**
 * Guard: every direct checkRateLimit( call under pages/api must pass a real
 * response object as the 4th argument, or the response keeps the proxy's
 * generic advisory `RateLimit-Policy: q=600;w=60` header while the route
 * enforces a different budget — misleading agents that schedule around the
 * header. (Passing a literal `undefined`/`null` 4th argument does not count:
 * checkRateLimit only stamps the headers when `res` is truthy.)
 *
 * Routes using applyRateLimit are covered automatically (it forwards res
 * internally); this scan only audits raw checkRateLimit( call sites.
 *
 * Escape hatch: a call site that deliberately does not stamp the response
 * (e.g. a per-event-id dedupe that isn't caller-scoped) must be registered in
 * NO_RES_ALLOWLIST below with the reason it is exempt. Allowlist entries that
 * no longer match a real call site fail the "stale allowlist" check so the
 * list cannot rot.
 *
 * Pure fs/regex scan: no app imports, no database.
 */
import fs from "fs";
import path from "path";

const REPO_ROOT = process.cwd();
const SCAN_DIR = path.join(REPO_ROOT, "pages", "api");

// Deliberate non-response checks. Each entry must name the file, the bucket
// literal used as the first argument, and why advertising that bucket on the
// response would be wrong.
const NO_RES_ALLOWLIST: Array<{
  file: string;
  bucket: string;
  reason: string;
}> = [
  {
    file: "pages/api/nostr/publish-order-event.ts",
    bucket: "publish-order-event:eid",
    reason:
      "per-event-id dedupe keyed on the event, not the caller; a rejection is reported inline per event, never as a client-facing 429, so stamping a budget on the response would misdescribe it",
  },
  {
    file: "pages/api/storefront/preview-from-url.ts",
    bucket: "storefront-preview-global",
    reason:
      "global (non-caller-scoped) bucket; it is advertised via reportRateLimit only when it is the bucket actually rejecting the request, never on allowed responses",
  },
];

type FoundCall = {
  argCount: number;
  /** Raw source text of the 4th argument, when present. */
  fourthArg: string | null;
  /** First argument if it is a string literal, else null. */
  bucket: string | null;
};

type CallSite = FoundCall & { file: string };

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      out.push(...collectSourceFiles(full));
    } else if (
      /\.(ts|tsx)$/.test(entry.name) &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".test.tsx")
    ) {
      out.push(full);
    }
  }
  return out;
}

/**
 * The 4th argument only stamps the response when checkRateLimit receives a
 * truthy NextApiResponse, so a placeholder (`undefined`, `null`, blank) is a
 * silent no-op and must fail the guard just like omitting the argument.
 */
function isResponseExpression(arg: string | null): boolean {
  if (arg === null) return false;
  const trimmed = arg.trim();
  return trimmed !== "" && trimmed !== "undefined" && trimmed !== "null";
}

function callAdvertisesBudget(call: FoundCall): boolean {
  return call.argCount >= 4 && isResponseExpression(call.fourthArg);
}

/**
 * Walk the source tracking comment/string state so `checkRateLimit(` inside a
 * comment or string is ignored, and extract the top-level argument list of
 * each real call. Handles nested parens/brackets/braces, quoted strings
 * (incl. escapes), and template literals well enough for these argument
 * lists.
 */
function findCheckRateLimitCalls(source: string): FoundCall[] {
  const calls: FoundCall[] = [];
  const n = source.length;
  const IDENT_CHAR = /[A-Za-z0-9_$]/;
  let i = 0;

  type State = "code" | "line" | "block" | "string";
  let state: State = "code";

  // Returns the index just past the string literal starting at `start`
  // (whose opening quote is source[start]).
  const skipString = (start: number): number => {
    const quote = source.charAt(start);
    let j = start + 1;
    while (j < n) {
      const c = source.charAt(j);
      if (c === "\\") {
        j += 2;
        continue;
      }
      if (c === quote) return j + 1;
      j++;
    }
    return n;
  };

  while (i < n) {
    const c = source.charAt(i);
    const next = source.charAt(i + 1);

    if (state === "line") {
      if (c === "\n") state = "code";
      i++;
      continue;
    }
    if (state === "block") {
      if (c === "*" && next === "/") {
        state = "code";
        i += 2;
      } else {
        i++;
      }
      continue;
    }
    if (state === "string") {
      i = skipString(i);
      state = "code";
      continue;
    }

    // state === "code"
    if (c === "/" && next === "/") {
      state = "line";
      i += 2;
      continue;
    }
    if (c === "/" && next === "*") {
      state = "block";
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      state = "string";
      continue;
    }

    if (
      source.startsWith("checkRateLimit", i) &&
      !IDENT_CHAR.test(source.charAt(i - 1)) &&
      !IDENT_CHAR.test(source.charAt(i + "checkRateLimit".length))
    ) {
      // Find the opening paren (allowing whitespace between).
      let j = i + "checkRateLimit".length;
      while (j < n && /\s/.test(source.charAt(j))) j++;
      if (source.charAt(j) !== "(") {
        // Import/type reference, not a call.
        i = j;
        continue;
      }

      // Scan to the matching close paren, respecting strings/comments.
      let depth = 1;
      let k = j + 1;
      let args = "";
      while (k < n && depth > 0) {
        const ch = source.charAt(k);
        const chNext = source.charAt(k + 1);
        if (ch === "/" && chNext === "/") {
          while (k < n && source.charAt(k) !== "\n") k++;
          continue;
        }
        if (ch === "/" && chNext === "*") {
          k += 2;
          while (
            k < n &&
            !(source.charAt(k) === "*" && source.charAt(k + 1) === "/")
          )
            k++;
          k += 2;
          continue;
        }
        if (ch === "'" || ch === '"' || ch === "`") {
          const end = skipString(k);
          args += source.slice(k, end);
          k = end;
          continue;
        }
        if (ch === "(") depth++;
        if (ch === ")") {
          depth--;
          if (depth === 0) break;
        }
        args += ch;
        k++;
      }

      // Split the argument list on top-level commas (paren/bracket/brace
      // depth 0, outside string literals).
      const argTexts: string[] = [];
      let current = "";
      let argDepth = 0;
      let inString: string | null = null;
      for (let m = 0; m < args.length; m++) {
        const ch = args.charAt(m);
        if (inString !== null) {
          current += ch;
          if (ch === "\\") {
            m++;
            current += args.charAt(m);
            continue;
          }
          if (ch === inString) inString = null;
          continue;
        }
        if (ch === "'" || ch === '"' || ch === "`") {
          inString = ch;
          current += ch;
          continue;
        }
        if (ch === "(" || ch === "[" || ch === "{") argDepth++;
        if (ch === ")" || ch === "]" || ch === "}") argDepth--;
        if (ch === "," && argDepth === 0) {
          argTexts.push(current);
          current = "";
          continue;
        }
        current += ch;
      }
      argTexts.push(current);

      const nonEmptyArgs = argTexts.filter((a) => a.trim().length > 0);
      const firstArg = (argTexts[0] ?? "").trim();
      const bucketMatch = /^["'`]([^"'`]+)["'`]$/.exec(firstArg);
      calls.push({
        argCount: nonEmptyArgs.length,
        fourthArg: argTexts.length >= 4 ? (argTexts[3] ?? null) : null,
        bucket: bucketMatch ? (bucketMatch[1] ?? null) : null,
      });
      i = k;
      continue;
    }

    i++;
  }

  return calls;
}

describe("checkRateLimit call sites advertise the real budget", () => {
  const files = collectSourceFiles(SCAN_DIR);
  const callSites: CallSite[] = [];
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    for (const call of findCheckRateLimitCalls(source)) {
      callSites.push({ file: path.relative(REPO_ROOT, file), ...call });
    }
  }

  // Sanity: the scan must actually find call sites, or a refactor that
  // renames the helper would silence this guard entirely.
  it("finds direct checkRateLimit( call sites in pages/api", () => {
    expect(files.length).toBeGreaterThan(0);
    expect(callSites.length).toBeGreaterThan(0);
  });

  it("every direct checkRateLimit( call passes a real res argument (or is allowlisted)", () => {
    const offenders = callSites.filter((call) => {
      if (callAdvertisesBudget(call)) return false;
      return !NO_RES_ALLOWLIST.some(
        (entry) => entry.file === call.file && entry.bucket === call.bucket
      );
    });

    if (offenders.length > 0) {
      throw new Error(
        "Direct checkRateLimit( calls without a real res argument leave the " +
          "proxy's advisory RateLimit-Policy (q=600;w=60) on the response " +
          "while enforcing a different budget. Pass the response object as " +
          "the 4th argument — a literal `undefined`/`null` does not count, " +
          "since checkRateLimit only stamps headers when res is truthy — or " +
          "use applyRateLimit. If the check is deliberately not " +
          "caller-facing, add it to NO_RES_ALLOWLIST in this test with the " +
          "reason. Offenders:\n" +
          offenders
            .map((o) => `${o.file} (bucket: ${o.bucket ?? "<dynamic>"})`)
            .join("\n")
      );
    }
    expect(offenders).toEqual([]);
  });

  it("has no stale allowlist entries (each matches a real no-res call)", () => {
    const stale = NO_RES_ALLOWLIST.filter(
      (entry) =>
        !callSites.some(
          (call) =>
            call.file === entry.file &&
            call.bucket === entry.bucket &&
            !callAdvertisesBudget(call)
        )
    );

    if (stale.length > 0) {
      throw new Error(
        "NO_RES_ALLOWLIST entries no longer match a checkRateLimit( call " +
          "missing a real res argument — remove them so the escape hatch " +
          "stays honest:\n" +
          stale.map((s) => `${s.file} (bucket: ${s.bucket})`).join("\n")
      );
    }
    expect(stale).toEqual([]);
  });

  it("every allowlist entry documents its reason", () => {
    for (const entry of NO_RES_ALLOWLIST) {
      expect(entry.reason.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("checkRateLimit call-site scanner", () => {
  it("ignores mentions inside comments and string literals", () => {
    const src = [
      '// checkRateLimit("comment", k, opts)',
      '/* checkRateLimit("block", k, opts) */',
      'const s = "checkRateLimit(\\"str\\", k, opts)";',
      'await checkRateLimit("real", key, opts, res);',
    ].join("\n");

    const calls = findCheckRateLimitCalls(src);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.bucket).toBe("real");
    expect(callAdvertisesBudget(calls[0] as FoundCall)).toBe(true);
  });

  it("rejects a literal `undefined` 4th argument (negative case)", () => {
    const calls = findCheckRateLimitCalls(
      'await checkRateLimit("b", key, opts, undefined);'
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.argCount).toBe(4);
    expect(callAdvertisesBudget(calls[0] as FoundCall)).toBe(false);
  });

  it("accepts a multi-line call whose 4th argument is the response", () => {
    const src = [
      "const rate = await checkRateLimit(",
      '  "cache-events",',
      "  getRequestIp(req),",
      "  RATE_LIMIT,",
      "  res",
      ");",
    ].join("\n");

    const calls = findCheckRateLimitCalls(src);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.bucket).toBe("cache-events");
    expect(calls[0]?.argCount).toBe(4);
    expect(callAdvertisesBudget(calls[0] as FoundCall)).toBe(true);
  });

  it("flags a call with only three arguments", () => {
    const calls = findCheckRateLimitCalls(
      'await checkRateLimit("b", event.id, PER_EVENT_LIMIT);'
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.argCount).toBe(3);
    expect(callAdvertisesBudget(calls[0] as FoundCall)).toBe(false);
  });

  it("does not mistake applyRateLimit( or reportRateLimit( for direct calls", () => {
    const src = [
      "await applyRateLimit(req, res, bucket, opts);",
      "reportRateLimit(res, bucket, rate, opts);",
    ].join("\n");
    expect(findCheckRateLimitCalls(src)).toHaveLength(0);
  });
});
