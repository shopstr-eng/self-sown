/**
 * selfsown — terminal client for the Self-Sown marketplace.
 *
 * Audience model: catalog endpoints are public; checkout endpoints take a
 * Bearer API key. Any agent can mint a FREE shopping key via `onboard`
 * (no membership required). Seller tooling stays in the MCP server.
 *
 * Zero runtime dependencies; Node >= 18 (global fetch). All logic is
 * exported for tests — the published bin (bin/selfsown.js) is a thin shim
 * that calls main(). Kept in one module so the compiled dist/ output has no
 * relative imports to resolve under Node ESM.
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const CLI_VERSION = "0.1.0";

const DEFAULT_BASE_URL = "https://self-sown.com";
const API_KEY_ENV = "SELF_SOWN_API_KEY";
const BASE_URL_ENV = "SELF_SOWN_BASE_URL";
const CONFIG_FILE = join(".config", "selfsown", "config.json");

const USAGE = `selfsown — shop the Self-Sown marketplace from a terminal

Usage:
  selfsown onboard --name <agent-name> [--save]
  selfsown search <query> [--category c] [--seller pubkey] [--availability in_stock] [--location loc] [--limit n] [--offset n]
  selfsown product <product-id>
  selfsown product --slug <slug> --pubkey <seller-pubkey>
  selfsown checkout create --product <id> [--quantity n] [--email e] [--payment-method m]
      [--variant id] [--size s] [--volume v] [--weight w] [--bulk-units u]
      [--discount-code code] [--mint-url url] [--cashu-token token]
      [--fiat-method m] [--subscription-frequency f] [--shipping-address '{"zip":"..."}']
  selfsown checkout list [--limit n] [--offset n]
  selfsown checkout status <session-id>
  selfsown checkout complete <session-id>
  selfsown version

Global flags:
  --base-url <url>   API base (env ${BASE_URL_ENV}, default ${DEFAULT_BASE_URL})
  --api-key <key>    Bearer key (env ${API_KEY_ENV}, or ~/${CONFIG_FILE})
  --raw              Compact single-line JSON output
  --help             Show this help

Catalog commands are public. Checkout commands need a key — onboard mints a
free shopping key for any agent, no membership required. Seller tooling lives
in the MCP server (see the mcpEndpoint field returned by onboard).
Output is JSON on stdout; errors are JSON on stderr, exit 1 (2 for usage).`;

export class CliError extends Error {
  readonly status?: number;
  readonly code?: string;
  readonly retryAfterSeconds?: number;
  readonly usage: boolean;

  constructor(
    message: string,
    options: {
      status?: number;
      code?: string;
      retryAfterSeconds?: number;
      usage?: boolean;
    } = {}
  ) {
    super(message);
    this.name = "CliError";
    this.status = options.status;
    this.code = options.code;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.usage = options.usage ?? false;
  }
}

/** Injectable seams so tests never touch the network, env, or disk. */
export interface CliIo {
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  homeDir?: string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  readConfig?: (path: string) => string | undefined;
  writeConfig?: (path: string, contents: string) => void;
}

export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | true>;
}

/** Flags that never take a value — they must not swallow the next token. */
const BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  "save",
  "raw",
  "help",
  "version",
]);

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === undefined) continue;
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      if (eq !== -1) {
        flags[token.slice(2, eq)] = token.slice(eq + 1);
        continue;
      }
      const name = token.slice(2);
      if (BOOLEAN_FLAGS.has(name)) {
        flags[name] = true;
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[name] = next;
        i += 1;
      } else {
        flags[name] = true;
      }
      continue;
    }
    positionals.push(token);
  }
  return { positionals, flags };
}

/**
 * Every non-boolean flag must carry a value — a bare `--quantity` is a usage
 * error, never a silent server default.
 */
function assertFlagValues(flags: Record<string, string | true>): void {
  for (const [name, value] of Object.entries(flags)) {
    if (value === true && !BOOLEAN_FLAGS.has(name)) {
      throw new CliError(`--${name} expects a value`, { usage: true });
    }
  }
}

function stringFlag(
  flags: Record<string, string | true>,
  name: string
): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

function hasFlag(flags: Record<string, string | true>, name: string): boolean {
  return flags[name] !== undefined;
}

/** Number("") === 0, so a blank flag must never silently become a number. */
function intFlag(
  flags: Record<string, string | true>,
  name: string,
  min: number,
  max: number = Number.MAX_SAFE_INTEGER
): number | undefined {
  const raw = stringFlag(flags, name);
  if (raw === undefined) return undefined;
  if (raw.trim() === "") {
    throw new CliError(`--${name} expects an integer`, { usage: true });
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new CliError(
      `--${name} expects an integer between ${min} and ${max}, got "${raw}"`,
      { usage: true }
    );
  }
  return value;
}

function validateBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(trimmed)) {
    throw new CliError(
      `base URL must start with http:// or https:// (got "${raw}")`,
      { usage: true }
    );
  }
  return trimmed;
}

function defaultReadConfig(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function defaultWriteConfig(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, { mode: 0o600 });
  // writeFileSync mode only applies when CREATING the file — an existing
  // permissively readable config would keep its old mode on overwrite.
  chmodSync(path, 0o600);
}

interface CliConnection {
  baseUrl: string;
  apiKey?: string;
}

/**
 * Resolve the base URL and API key together: a key saved by `onboard --save`
 * is bound to the origin that minted it. Using a saved key against a
 * different host requires an explicit --api-key -- never silently send a
 * Bearer token across origins.
 */
function resolveConnection(
  flags: Record<string, string | true>,
  env: Record<string, string | undefined>,
  configPath: string,
  readConfig: (path: string) => string | undefined
): CliConnection {
  const explicitBase = stringFlag(flags, "base-url") ?? env[BASE_URL_ENV];
  const directKey = stringFlag(flags, "api-key") ?? env[API_KEY_ENV];
  if (directKey !== undefined && directKey.trim() !== "") {
    return {
      baseUrl: validateBaseUrl(explicitBase ?? DEFAULT_BASE_URL),
      apiKey: directKey.trim(),
    };
  }
  const raw = readConfig(configPath);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as {
        apiKey?: unknown;
        baseUrl?: unknown;
      };
      if (typeof parsed.apiKey === "string" && parsed.apiKey.trim() !== "") {
        const savedBase =
          typeof parsed.baseUrl === "string" && parsed.baseUrl.trim() !== ""
            ? parsed.baseUrl
            : DEFAULT_BASE_URL;
        if (
          explicitBase !== undefined &&
          validateBaseUrl(explicitBase) !== validateBaseUrl(savedBase)
        ) {
          throw new CliError(
            `the saved key is bound to ${savedBase}; pass --api-key explicitly to use a different host`,
            { usage: true }
          );
        }
        return { baseUrl: validateBaseUrl(savedBase), apiKey: parsed.apiKey };
      }
    } catch (error) {
      if (error instanceof CliError) throw error;
      // Corrupt config: fall through to defaults without a key.
    }
  }
  return { baseUrl: validateBaseUrl(explicitBase ?? DEFAULT_BASE_URL) };
}

interface ApiRequestOptions {
  method: "GET" | "POST";
  url: string;
  apiKey?: string;
  body?: Record<string, unknown>;
}

async function apiRequest(
  fetchImpl: typeof fetch,
  request: ApiRequestOptions
): Promise<unknown> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (request.apiKey) headers.Authorization = `Bearer ${request.apiKey}`;
  if (request.body) headers["Content-Type"] = "application/json";

  let response: Response;
  try {
    response = await fetchImpl(request.url, {
      method: request.method,
      headers,
      body: request.body ? JSON.stringify(request.body) : undefined,
    });
  } catch (error) {
    throw new CliError(
      `network error: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  const text = await response.text();
  let parsed: unknown;
  if (text.trim() !== "") {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { raw: text };
    }
  }

  if (!response.ok) {
    const obj = (parsed && typeof parsed === "object" ? parsed : {}) as Record<
      string,
      unknown
    >;
    const message =
      typeof obj.error === "string"
        ? obj.error
        : typeof obj.message === "string"
          ? obj.message
          : `HTTP ${response.status}`;
    let retryAfterSeconds: number | undefined;
    if (typeof obj.retryAfterSeconds === "number") {
      retryAfterSeconds = obj.retryAfterSeconds;
    } else {
      const retryHeader = response.headers.get("retry-after");
      if (retryHeader) {
        const parsedHeader = Number(retryHeader);
        if (Number.isFinite(parsedHeader)) retryAfterSeconds = parsedHeader;
      }
    }
    throw new CliError(message, {
      status: response.status,
      code: typeof obj.code === "string" ? obj.code : undefined,
      retryAfterSeconds,
    });
  }
  return parsed ?? {};
}

interface CommandContext {
  fetchImpl: typeof fetch;
  baseUrl: string;
  apiKey?: string;
  configPath: string;
  err: (text: string) => void;
  writeConfig: (path: string, contents: string) => void;
}

function requireApiKey(ctx: CommandContext): string {
  if (!ctx.apiKey) {
    throw new CliError(
      "this command needs an API key. Mint a free shopping key: " +
        "selfsown onboard --name <name> --save (or set " +
        API_KEY_ENV +
        ")",
      { usage: true }
    );
  }
  return ctx.apiKey;
}

async function runOnboard(
  ctx: CommandContext,
  flags: Record<string, string | true>
): Promise<unknown> {
  const name = stringFlag(flags, "name")?.trim();
  if (!name) {
    throw new CliError("onboard requires --name <agent-or-app-name>", {
      usage: true,
    });
  }
  const result = await apiRequest(ctx.fetchImpl, {
    method: "POST",
    url: `${ctx.baseUrl}/api/mcp/onboard`,
    body: { name, audience: "shopping" },
  });

  if (hasFlag(flags, "save")) {
    const apiKey = (result as { apiKey?: unknown }).apiKey;
    if (typeof apiKey !== "string" || apiKey === "") {
      throw new CliError("server response did not include an apiKey to save");
    }
    ctx.writeConfig(
      ctx.configPath,
      JSON.stringify({ apiKey, baseUrl: ctx.baseUrl }, null, 2)
    );
    ctx.err(`saved API key to ${ctx.configPath} (mode 600)`);
  }

  const nsec = (result as { nsec?: unknown }).nsec;
  if (typeof nsec === "string" && nsec !== "") {
    ctx.err(
      "the response includes a one-time Nostr secret key (nsec) — store it somewhere safe; it will not be shown again"
    );
  }
  return result;
}

async function runSearch(
  ctx: CommandContext,
  positionals: string[],
  flags: Record<string, string | true>
): Promise<unknown> {
  const query = positionals.slice(1).join(" ").trim();
  if (!query) {
    throw new CliError("search requires a query: selfsown search <query>", {
      usage: true,
    });
  }
  const params = new URLSearchParams();
  params.set("q", query);
  for (const flag of ["category", "seller", "availability", "location"]) {
    const value = stringFlag(flags, flag);
    if (value) params.set(flag, value);
  }
  const limit = intFlag(flags, "limit", 1);
  if (limit !== undefined) params.set("limit", String(limit));
  const offset = intFlag(flags, "offset", 0);
  if (offset !== undefined) params.set("offset", String(offset));
  return apiRequest(ctx.fetchImpl, {
    method: "GET",
    url: `${ctx.baseUrl}/api/ucp/catalog/search?${params.toString()}`,
  });
}

async function runProduct(
  ctx: CommandContext,
  positionals: string[],
  flags: Record<string, string | true>
): Promise<unknown> {
  const params = new URLSearchParams();
  const id = positionals[1] ?? stringFlag(flags, "id");
  if (id) {
    params.set("id", id);
  } else {
    const slug = stringFlag(flags, "slug");
    const pubkey = stringFlag(flags, "pubkey") ?? stringFlag(flags, "seller");
    if (slug && pubkey) {
      params.set("slug", slug);
      params.set("pubkey", pubkey);
    } else {
      throw new CliError(
        "product requires an id (selfsown product <id>) or --slug <slug> --pubkey <seller-pubkey>",
        { usage: true }
      );
    }
  }
  return apiRequest(ctx.fetchImpl, {
    method: "GET",
    url: `${ctx.baseUrl}/api/ucp/catalog/lookup?${params.toString()}`,
  });
}

const CHECKOUT_FLAG_MAP: ReadonlyArray<readonly [string, string]> = [
  ["variant", "variantId"],
  ["email", "buyerEmail"],
  ["size", "selectedSize"],
  ["volume", "selectedVolume"],
  ["weight", "selectedWeight"],
  ["discount-code", "discountCode"],
  ["payment-method", "paymentMethod"],
  ["mint-url", "mintUrl"],
  ["cashu-token", "cashuToken"],
  ["fiat-method", "fiatMethod"],
  ["subscription-frequency", "subscriptionFrequency"],
];

async function runCheckout(
  ctx: CommandContext,
  positionals: string[],
  flags: Record<string, string | true>
): Promise<unknown> {
  const subcommand = positionals[1];
  const apiKey = requireApiKey(ctx);

  switch (subcommand) {
    case "create": {
      const productId =
        stringFlag(flags, "product") ??
        stringFlag(flags, "product-id") ??
        positionals[2];
      if (!productId) {
        throw new CliError("checkout create requires --product <product-id>", {
          usage: true,
        });
      }
      const body: Record<string, unknown> = { productId };
      const quantity = intFlag(flags, "quantity", 1);
      if (quantity !== undefined) body.quantity = quantity;
      // Bulk tiers key off numeric values server-side, so this one must be a
      // number in the JSON body, not a string like the other option fields.
      const bulkUnits = intFlag(flags, "bulk-units", 1, 100000);
      if (bulkUnits !== undefined) body.selectedBulkUnits = bulkUnits;
      for (const [flag, field] of CHECKOUT_FLAG_MAP) {
        const value = stringFlag(flags, flag);
        if (value) body[field] = value;
      }
      const shippingAddress = stringFlag(flags, "shipping-address");
      if (shippingAddress !== undefined) {
        try {
          body.shippingAddress = JSON.parse(shippingAddress);
        } catch {
          throw new CliError("--shipping-address must be valid JSON", {
            usage: true,
          });
        }
      }
      return apiRequest(ctx.fetchImpl, {
        method: "POST",
        url: `${ctx.baseUrl}/api/ucp/checkout/sessions`,
        apiKey,
        body,
      });
    }
    case "list": {
      const params = new URLSearchParams();
      const limit = intFlag(flags, "limit", 1);
      if (limit !== undefined) params.set("limit", String(limit));
      const offset = intFlag(flags, "offset", 0);
      if (offset !== undefined) params.set("offset", String(offset));
      const query = params.toString();
      return apiRequest(ctx.fetchImpl, {
        method: "GET",
        url: `${ctx.baseUrl}/api/ucp/checkout/sessions${query ? `?${query}` : ""}`,
        apiKey,
      });
    }
    case "status": {
      const sessionId = positionals[2];
      if (!sessionId) {
        throw new CliError("checkout status requires a session id", {
          usage: true,
        });
      }
      return apiRequest(ctx.fetchImpl, {
        method: "GET",
        url: `${ctx.baseUrl}/api/ucp/checkout/sessions/${encodeURIComponent(sessionId)}`,
        apiKey,
      });
    }
    case "complete": {
      const sessionId = positionals[2];
      if (!sessionId) {
        throw new CliError("checkout complete requires a session id", {
          usage: true,
        });
      }
      return apiRequest(ctx.fetchImpl, {
        method: "POST",
        url: `${ctx.baseUrl}/api/ucp/checkout/sessions/${encodeURIComponent(sessionId)}/complete`,
        apiKey,
      });
    }
    default:
      throw new CliError(
        `unknown checkout subcommand "${subcommand ?? ""}" — expected create, list, status, or complete`,
        { usage: true }
      );
  }
}

export async function main(argv: string[], io: CliIo = {}): Promise<number> {
  const out =
    io.stdout ??
    ((text: string) => {
      process.stdout.write(`${text}\n`);
    });
  const err =
    io.stderr ??
    ((text: string) => {
      process.stderr.write(`${text}\n`);
    });
  const env = io.env ?? process.env;
  const fetchImpl = io.fetchImpl ?? fetch;
  const homeDir = io.homeDir ?? homedir();
  const readConfig = io.readConfig ?? defaultReadConfig;
  const writeConfig = io.writeConfig ?? defaultWriteConfig;

  try {
    const { positionals, flags } = parseArgs(argv);
    assertFlagValues(flags);
    const command = positionals[0];

    if (command === undefined || command === "help" || hasFlag(flags, "help")) {
      out(USAGE);
      return 0;
    }
    if (command === "version" || hasFlag(flags, "version")) {
      out(JSON.stringify({ version: CLI_VERSION }));
      return 0;
    }

    if (
      command !== "onboard" &&
      command !== "search" &&
      command !== "product" &&
      command !== "checkout"
    ) {
      err(USAGE);
      throw new CliError(`unknown command "${command}"`, { usage: true });
    }

    const configPath = join(homeDir, CONFIG_FILE);
    // Public commands never send an API key, so the saved-key origin binding
    // only gates authenticated checkout calls — an existing saved key must
    // not block searching or onboarding against another host.
    const { baseUrl, apiKey }: CliConnection =
      command === "checkout"
        ? resolveConnection(flags, env, configPath, readConfig)
        : {
            baseUrl: validateBaseUrl(
              stringFlag(flags, "base-url") ??
                env[BASE_URL_ENV] ??
                DEFAULT_BASE_URL
            ),
          };
    const ctx: CommandContext = {
      fetchImpl,
      baseUrl,
      apiKey,
      configPath,
      err,
      writeConfig,
    };

    let result: unknown;
    switch (command) {
      case "onboard":
        result = await runOnboard(ctx, flags);
        break;
      case "search":
        result = await runSearch(ctx, positionals, flags);
        break;
      case "product":
        result = await runProduct(ctx, positionals, flags);
        break;
      default:
        result = await runCheckout(ctx, positionals, flags);
        break;
    }

    out(JSON.stringify(result, null, hasFlag(flags, "raw") ? 0 : 2));
    return 0;
  } catch (error) {
    if (error instanceof CliError) {
      const payload: Record<string, unknown> = { error: error.message };
      if (error.code !== undefined) payload.code = error.code;
      if (error.status !== undefined) payload.status = error.status;
      if (error.retryAfterSeconds !== undefined) {
        payload.retryAfterSeconds = error.retryAfterSeconds;
      }
      err(JSON.stringify(payload, null, 2));
      return error.usage ? 2 : 1;
    }
    err(
      JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
      })
    );
    return 1;
  }
}
