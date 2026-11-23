# Dependency advisory triage — 2026-11-23

The initial static dependency scan found 65 advisory instances (19 high, 36
moderate, 10 low; no critical). After compatible upgrades and verified local
patches, a fresh scan reports 9 instances (2 high, 7 moderate; no critical).
This inventory distinguishes scanner version matches from reachable application
behavior.

## Resolved or independently mitigated

- Upgraded Next.js and `eslint-config-next` to 16.4.6, `undici` to 7.30.2,
  Zod 4 to 4.6.7, and the MCP SDK to 1.32.2.
- Updated the MCP SDK's Express `body-parser` to 2.4.0, and SendGrid's Axios
  parent to 1.21.1 (which resolves `follow-redirects` 1.16.3).
- Updated shared overrides in both root override maps: `@hono/node-server`
  1.19.19, Hono 4.13.21, `fast-uri` 3.1.9, `qs` 6.17.1,
  `serialize-javascript` 7.1.4, and `ip-address` 10.7.6. Updated `glob` 13 to
  13.0.7. Root `pnpm.overrides` and the legacy `overrides` map are kept in sync;
  `pnpm-workspace.yaml` only defines workspace package globs and has no override
  map to synchronize.
- Updated node-forge to upstream 1.4.4 and removed the now-redundant 1.4.0 patch.
  `scripts/security-dependency-smoke.mjs` asserts the installed version and
  verifies that nested garbage in RSA DigestInfo remains rejected.
- The scanner still reports elliptic 6.6.1, but the repository's
  `patches/elliptic@6.6.1.patch` corrects the reported RFC 6979 nonce-width
  issue. The same smoke script tests the leading-zero P-521 case and a
  `bolt11` signature. Its version-only alert is not evidence the patch failed.

## Remaining version matches and reachability

| Package finding | Dependency path / concrete use | Risk assessment |
| --- | --- | --- |
| `@hono/node-server` 1.19.19 — GHSA-rmxm-3fg6-px4f (moderate) | Production path: `@modelcontextprotocol/sdk` → `StreamableHTTPServerTransport` → `getRequestListener`, used by `pages/api/mcp/index.ts`. The adapter imports and calls `getRequestListener`; it does not call `serveStatic`. | The remaining double-decode issue is in `serveStatic`, which this app path does not use. The separate raw-backslash issue is fixed in 1.19.18 and later. |
| `glob` 10.5.0 — GHSA-3g3m-2fjr-6pw4 (moderate) | Development-only via Jest/test-exclude and testcontainers/archiver. These callers use configured test globs and local test archives. | No production dependency path or request-controlled glob pattern was found. |
| `glob` 13.0.7 — GHSA-3g3m-2fjr-6pw4 (moderate) | Development tooling: Jest and Expo config plugins. Expo's Android config helpers use fixed source-file patterns, e.g. `android/app/src/main/java/**/${name}.@(java|kt)` in `@expo/config-plugins/build/android/Paths.js`. | No production request path or caller-controlled `AbortSignal`-bounded glob walk was found. |
| `minimatch` 9.0.9, 10.2.4, 10.2.5 — GHSA-g3hv-75wg-m249 (moderate) | All are under the above Jest/Expo build-and-test glob tooling. No app source imports glob/minimatch. | No production reachability found. The scanner's fixed version is 11.0.1, a major override across multiple glob consumers; do not force it without parent compatibility tests. |
| `uuid` 3.4.0 — GHSA-w5hq-g745-h8pq (high) | Development-only through `@expo/ngrok`; `@expo/ngrok/index.js` calls only `uuid.v4()` without an output buffer or offset. | The advisory is specifically missing bounds checks in `v3`, `v5`, and `v6` when caller buffers are supplied. The only reachable API here is `v4`, so the vulnerable operations are not called. Do not force a major transitive uuid override. |
| Zod 3.25.76 — GHSA-mrhx-c7xc-m3w5 (high) | Expo CLI dev tooling. `DevToolsPluginCliExtensionResults.js` parses local plugin command output, and `DevToolsPlugin.schema.js` defines arrays without a maximum. The CLI pins a Zod 3 peer (`^3.25.76`); Expo SDK 55 does not offer a compatible patched Zod 3 release. | The scanner finding is real for oversized invalid arrays, but this parser runs in local development tooling, not the deployed web app or checkout API. Replacing Zod 3 with Zod 4 would cross a major API boundary, so it was not forced. |

These remaining entries are not assertions that the libraries are universally
safe. They document why the observed application paths do not reach the affected
operations and where a compatible upstream parent update is still needed.

## Verification

- Frozen pnpm install succeeds; no package firewall bypass was used.
- Existing dependency security smoke tests pass (10/10), including node-forge
  and elliptic regression checks.
- Web and mobile TypeScript checks pass.
- Checkout, authentication, storefront, and Stripe tests pass (48 suites,
  582 tests; 3 skipped). Expo mobile web export succeeds.
- The Next.js 16.4.6 production build compiles successfully in the configured
  dev workflow.
