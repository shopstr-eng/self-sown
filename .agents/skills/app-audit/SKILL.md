---
name: app-audit
description: Run a comprehensive, adversarial audit of the application across security, reliability, concurrency, accessibility, and UI/visual consistency, then produce a graded findings report with a remediation plan and release recommendation. Use when the user asks to "audit the app", do a "security review", "pre-release review", "find vulnerabilities/races/a11y issues", or paste a broad multi-domain review prompt. Produces a report only — does not modify code during the audit.
---

# Comprehensive Application Audit

Produce a **verified, prioritized findings report** — not a linting pass. Trace real user flows end-to-end, be adversarial on security, systematic on accessibility, precise on UI. **Do not modify code during the audit.**

The single most important rule: **verify every severe finding by reading the actual code before you grade it.** Broad sweeps produce false positives (see the trap list below). A confirmed Medium beats a speculative Critical.

## Process

### 1. Map the codebase (cheap, first)

```
rg --files -g '*.ts' -g '*.tsx' | wc -l          # scale
ls pages pages/api utils components               # structure (adapt to the stack)
```

Note the framework, auth helpers, DB access layer, payment/integration surfaces. Read `replit.md` and `.agents/memory/MEMORY.md` for prior decisions and known quirks — they prevent re-flagging solved issues.

### 2. Dispatch parallel read-only explorers (one per domain)

Launch these **async, in parallel** with the `explore` tool (`run_asynchronously: true`), then collect with `wait_for_background_tasks`. Do NOT let explorers edit — they are read-only. The six domains:

1. **Security — auth & authorization:** missing server-side permission checks, IDOR / cross-tenant access (client-supplied `pubkey`/`id`/`orderId` used in queries without binding to the authed caller), privilege escalation (paid/admin features reachable without entitlement), auth-binding replay (generic vs `{method,path}`-bound proofs), webhook signature verification.
2. **Security — injection/SSRF/XSS/uploads/redirects/CORS/secrets:** parameterized SQL vs interpolation, server fetches of user URLs (must route through an SSRF-safe fetch), `dangerouslySetInnerHTML` sanitization, open redirects, upload size/type/path-traversal, wildcard CORS on credentialed routes, secrets in client code / responses / logs / `NEXT_PUBLIC_*`.
3. **Race conditions / concurrency / state integrity:** non-idempotent operations (payments, orders, grants, labels, payouts, enrollment) — claims taken after early-returns, claims released on failure; UI double-submit while in-flight; webhook dedup; multi-tab / wallet concurrency; effects/timers/subscriptions cleanup; out-of-order async / stale state; read-modify-write vs atomic SQL.
4. **Reliability / failure handling:** swallowed errors (`catch {}`, catch-and-return-success), fire-and-forget promises, infinite loading (loading not cleared in `finally`), missing loading/empty/error/offline/timeout/partial-success states, assumptions about API shape/ordering/nullability, rollback on partial failure, FX/rate resilience (display degrades vs charge fails-closed).
5. **Accessibility (WCAG 2.2 AA):** semantic HTML/landmarks, icon-only controls without accessible names, images without alt, keyboard nav + visible focus (`outline-none` without `:focus-visible`), focus trap/restore in modals, ARIA correctness + live regions, color-alone meaning + contrast + touch targets + reduced-motion, form label association / autocomplete / linked validation errors.
6. **Visual & interaction consistency (+ responsive/edge cases):** design-token vs hardcoded values, missing/inconsistent interaction states (hover/focus/active/disabled/loading/destructive), duplicated components that drift, overflow/clipping/truncation, empty/zero-result/long-content states, copy/terminology/format drift, mobile/tablet/wide/zoom/large-text.

Give each explorer the **per-finding output format** (below) and tell it to verify guards actually exist before reporting and to note where protections DO exist.

### 3. Verify severe findings yourself (the critical step)

For every Critical/High (and any surprising Medium), open the exact file and confirm. Read the helper the endpoint calls, not just the endpoint. Common **false-positive traps** to check before reporting:

- "IDOR via `?pubkey=`" → check whether the signed-proof verifier asserts `event.pubkey === proof.pubkey` **and** `verifyEvent()`. If so, it's safe (an attacker can't forge a victim's signature).
- "JSON-LD / HTML XSS" → check the serializer actually escapes `<`, `>`, `&`, U+2028/9.
- "SQL injection via table/column name" → check it's a hardcoded allowlist map, not user input.
- "Delete/update IDOR" → check the SQL `WHERE` includes the owner (`WHERE pubkey=$1 AND id=$2`).
- "Mobile overflow clipping" → `sm:`/`md:` responsive prefixes and `overflow-x-auto` wrappers usually make it safe.
- "Double-submit → duplicate charge" → check for a server-side atomic claim / single-use proof; if present, the client gap is only UX.
- "Missing atomicity" → look for a single SQL statement (`GREATEST`, conditional `WHERE`) doing it atomically.

Downgrade or drop anything you can't confirm; label residual ones **Needs Verification** honestly.

### 4. Report format (per finding)

```
### <ID> — <one-line title>
- Severity: Critical | High | Medium | Low | Informational
- Category: Security | Race Condition | Reliability | Accessibility | Performance | Visual Consistency
- Location: exact file:line + function/endpoint/flow
- Issue: what is wrong
- Impact: what realistically happens in production
- Evidence: the code path (quote the lines)
- Reproduction: steps to trigger/verify (where applicable)
- Recommended fix: specific, actionable remediation
- Confidence: Confirmed | High Confidence | Needs Verification
```

### 5. Deliverables (in this order), written to `docs/audit/comprehensive-audit-<YYYY-MM-DD>.md`

1. Executive summary (severity counts + one-line release call).
2. Findings grouped by **severity then category**.
3. A **"Verified NOT vulnerable"** section documenting disproven flags (prevents re-flagging next time).
4. Prioritized remediation plan.
5. Quick wins (low regression risk).
6. Items requiring architectural change / deeper investigation.
7. Release recommendation: **Safe to ship** / **Ship with known risks** / **Do not ship**, with justification (an unauthenticated, high-impact bug ⇒ "Do not ship" until fixed).

Present the file with `present_asset`. Only implement fixes if the user asks after seeing the report.

## Notes

- Prioritize by real-world impact and exploitability; unauthenticated + remote + high-impact ranks first.
- Distinguish confirmed vulnerabilities from theoretical concerns; don't pad the report with speculation.
- Accessibility is rarely "Critical" but keyboard/screen-reader blockers on core flows (nav, checkout, forms) are High.
- Reuse this project's own guarantees when grading: prefer bound single-use proofs, atomic-SQL claims, `safeFetch`, and server-authoritative writes as the "safe" baselines.
