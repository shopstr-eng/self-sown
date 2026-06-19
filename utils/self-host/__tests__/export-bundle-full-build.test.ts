// Real, full compile-and-boot verification of the self-host export bundle.
//
// The companion suite (export-bundle-boot.test.ts) closes the loop on the
// bundle's *logic* — it packs the real ZIP, round-trips it, and feeds the output
// back through the runtime config reader + proxy routing helpers — but it
// deliberately stops short of a genuine `pnpm build` / `pnpm start`. A cold Next
// compile of the whole app OOMs inside the agent/test sandbox (this repo IS the
// upstream the bundle clones), so that step can only run in CI.
//
// This suite is that CI step. It is GATED behind RUN_SELF_HOST_BUILD=1 (mirroring
// the RUN_TESTCONTAINERS pattern), so it is skipped everywhere except the
// dedicated CI job. When it runs it:
//
//   1. Generates the REAL bundle (buildExportEntries) and writes it to a scratch
//      directory, exactly as a Wrangler seller's download would unzip.
//   2. Runs the generated `setup.sh`, pointed at the checked-out tree as the
//      "upstream" clone target, so the seller's documented bootstrap path is the
//      thing under test (clone + drop config in place).
//   3. Writes a test `.env` enabling single-tenant mode (MM_SELF_HOST=1, no
//      Stripe key — Lightning/Cashu only).
//   4. Runs `pnpm install` + `pnpm build`, then boots the server with `pnpm start`
//      (the run command the bundle's SETUP.md documents).
//   5. Asserts over real HTTP that `/` serves the tenant stall, `/marketplace`
//      and `/pro` redirect home, and the cart offers Lightning/Cashu (card off,
//      proven via the seller-status endpoint that drives the card button).
//
// A dependency or route change that breaks the single-tenant build — something
// the logical smoke test cannot see — fails here.

import { spawn, spawnSync, type ChildProcess } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { buildExportEntries } from "@/utils/self-host/export-bundle";

const RUN = process.env.RUN_SELF_HOST_BUILD === "1";
const maybeDescribe = RUN ? describe : describe.skip;

const PUBKEY = "b".repeat(64);
const SLUG = "green-pastures";
const RELAY = "wss://relay.example";
const BLOSSOM = "https://blossom.example";
const PORT = Number(process.env.SELF_HOST_BUILD_PORT || "34971");
const BASE = `http://127.0.0.1:${PORT}`;

// The single-tenant flow legitimately needs a real compile + install + boot.
// Give the whole setup hook a generous ceiling; CI runners are slow.
const SETUP_TIMEOUT_MS = 30 * 60 * 1000;
const STEP_TIMEOUT_MS = 20 * 60 * 1000;
const BOOT_TIMEOUT_MS = 3 * 60 * 1000;

function run(
  cmd: string,
  args: string[],
  cwd: string,
  extraEnv: Record<string, string> = {}
): void {
  const res = spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: "inherit",
    timeout: STEP_TIMEOUT_MS,
    env: { ...process.env, ...extraEnv },
  });
  if (res.status !== 0) {
    throw new Error(
      `Command failed (${res.status ?? res.signal}): ${cmd} ${args.join(" ")}`
    );
  }
}

async function waitForServer(deadlineMs: number): Promise<void> {
  const start = Date.now();
  let lastErr: unknown = null;
  while (Date.now() - start < deadlineMs) {
    try {
      const res = await fetch(`${BASE}/`, { redirect: "manual" });
      // Any HTTP response (even an error page) proves the server is listening.
      if (res.status > 0) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(
    `Server did not become ready within ${deadlineMs}ms: ${String(lastErr)}`
  );
}

maybeDescribe("self-host export bundle: full build + boot", () => {
  let workDir: string;
  let appDir: string;
  let server: ChildProcess | null = null;

  beforeAll(async () => {
    // 1. Lay the REAL bundle down on disk, exactly as an unzip would.
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-selfhost-"));
    const bundleDir = path.join(workDir, "bundle");
    fs.mkdirSync(bundleDir, { recursive: true });

    const entries = buildExportEntries({
      pubkey: PUBKEY,
      slug: SLUG,
      relays: [RELAY],
      blossomServers: [BLOSSOM],
      branding: { primaryColor: "#0a0" },
      generatedAt: "2026-06-16T00:00:00.000Z",
    });
    for (const entry of entries) {
      const data =
        typeof entry.data === "string"
          ? entry.data
          : Buffer.from(entry.data).toString("utf8");
      fs.writeFileSync(path.join(bundleDir, entry.name), data);
    }

    // 2. Run the generated bootstrap. We point its REPO arg at the checked-out
    //    tree (process.cwd()) so the clone target is this exact commit — the
    //    code actually under test — rather than whatever is live on the public
    //    remote. setup.sh clones into ./milk-market and copies the config in.
    run("bash", ["setup.sh", process.cwd(), "milk-market"], bundleDir);
    appDir = path.join(bundleDir, "milk-market");
    expect(fs.existsSync(path.join(appDir, "milk-market.config.json"))).toBe(
      true
    );

    // 3. Write the seller's .env: single-tenant on, no Stripe key (so card is
    //    off and only Lightning/Cashu are offered). DATABASE_URL comes from the
    //    CI Postgres service.
    const databaseUrl =
      process.env.DATABASE_URL ||
      "postgresql://milkmarket:milkmarket@localhost:5432/milkmarket";
    const dotenv = [
      "MM_SELF_HOST=1",
      `MM_SELF_HOST_PUBKEY=${PUBKEY}`,
      `MM_SELF_HOST_SLUG=${SLUG}`,
      `MM_SELF_HOST_RELAYS=${RELAY}`,
      `MM_SELF_HOST_BLOSSOM_SERVERS=${BLOSSOM}`,
      `DATABASE_URL=${databaseUrl}`,
      "",
    ].join("\n");
    fs.writeFileSync(path.join(appDir, ".env"), dotenv);

    // 4. Install + compile + boot — the seller's documented run path.
    run("pnpm", ["install", "--frozen-lockfile"], appDir);
    run("pnpm", ["build"], appDir, {
      NODE_OPTIONS: "--max-old-space-size=4096",
    });

    server = spawn("pnpm", ["start"], {
      cwd: appDir,
      stdio: "inherit",
      env: { ...process.env, PORT: String(PORT) },
    });

    await waitForServer(BOOT_TIMEOUT_MS);
  }, SETUP_TIMEOUT_MS);

  afterAll(() => {
    if (server && server.pid) {
      try {
        process.kill(server.pid, "SIGTERM");
      } catch {
        // already gone
      }
    }
    if (workDir) {
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    }
  });

  it("serves the tenant's storefront at the root URL", async () => {
    const res = await fetch(`${BASE}/`, { redirect: "manual" });
    // The proxy rewrites "/" → "/stall/<slug>" (a transparent rewrite, not a
    // redirect), so the root is served with a 200 by the stall route — never
    // bounced to the marketplace.
    expect(res.status).toBe(200);
  });

  it("redirects /marketplace home (marketplace hidden)", async () => {
    const res = await fetch(`${BASE}/marketplace`, { redirect: "manual" });
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/");
  });

  it("redirects /pro home (platform billing hidden)", async () => {
    const res = await fetch(`${BASE}/pro`, { redirect: "manual" });
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/");
  });

  it("offers Lightning/Cashu only — card is off without a Stripe key", async () => {
    // Lightning + Cashu checkout is fully client-side (wallet ↔ mint, no server
    // route or secret), so it works the moment the instance boots. The single
    // server-observable signal for "card off, LN/Cashu only" is the endpoint the
    // cart calls to decide whether to show the card button: with no
    // STRIPE_SECRET_KEY configured it must report the card option unavailable.
    const res = await fetch(`${BASE}/api/stripe/connect/seller-status`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pubkey: PUBKEY }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      hasStripeAccount?: boolean;
      chargesEnabled?: boolean;
    };
    expect(body.hasStripeAccount).toBe(false);
    expect(body.chargesEnabled).toBe(false);
  });
});
