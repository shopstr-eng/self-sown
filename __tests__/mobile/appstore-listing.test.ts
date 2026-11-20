import { ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { LISTING } from "../../apps/mobile/scripts/appstore-listing.mjs";

const repoRoot = path.resolve(__dirname, "..", "..");
const script = path.join(repoRoot, "apps", "mobile", "scripts", "appstore-listing.mjs");

type Call = { method: string; path: string; body: any };

// Live listing state the stub serves; tests mutate one field to introduce drift.
interface StubState {
  calls: Call[];
  app: { contentRightsDeclaration: string };
  infoLoc: { id: string; attributes: any } | null;
  category: string | null;
  age: { id: string; attributes: any };
  versionLoc: { id: string; attributes: any } | null;
  copyright: string | null;
  price: {
    exists: boolean;
    baseTerritory: string;
    prices: { id: string; pricePoint: string; startDate: string | null; endDate: string | null; customerPrice: string }[];
  };
}

function canonicalState(): StubState {
  return {
    calls: [],
    app: { contentRightsDeclaration: LISTING.app.contentRightsDeclaration },
    infoLoc: {
      id: "INFO_LOC",
      attributes: {
        locale: "en-US",
        name: LISTING.app.name,
        subtitle: LISTING.app.subtitle,
        privacyPolicyUrl: LISTING.app.privacyPolicyUrl,
      },
    },
    category: LISTING.app.primaryCategory,
    age: { id: "AGE", attributes: { ...LISTING.ageRating } },
    versionLoc: {
      id: "VER_LOC",
      attributes: {
        locale: "en-US",
        description: LISTING.version.description,
        keywords: LISTING.version.keywords,
        supportUrl: LISTING.version.supportUrl,
        marketingUrl: LISTING.version.marketingUrl,
      },
    },
    copyright: LISTING.version.copyright,
    price: {
      exists: true,
      baseTerritory: LISTING.pricing.baseTerritory,
      prices: [
        { id: "P1", pricePoint: "PP0", startDate: null, endDate: null, customerPrice: "0.0" },
      ],
    },
  };
}

function startStub() {
  const state = canonicalState();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const isJson = (req.headers["content-type"] ?? "").includes("application/json");
      const parsed = isJson && raw.length ? JSON.parse(raw.toString()) : null;
      const p = new URL(req.url ?? "", "http://x").pathname;
      const m = req.method ?? "GET";
      state.calls.push({ method: m, path: p, body: parsed });
      const reply = (status: number, json?: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(json === undefined ? "" : JSON.stringify(json));
      };

      if (m === "GET" && p === "/v1/apps")
        return reply(200, {
          data: [
            {
              id: "APP",
              attributes: {
                bundleId: "com.selfsown.mobile",
                contentRightsDeclaration: state.app.contentRightsDeclaration,
              },
            },
          ],
        });
      if (m === "GET" && p === "/v1/apps/APP")
        return reply(200, {
          data: {
            id: "APP",
            attributes: {
              bundleId: "com.selfsown.mobile",
              contentRightsDeclaration: state.app.contentRightsDeclaration,
            },
          },
        });
      if (m === "GET" && p === "/v1/apps/APP/appInfos")
        return reply(200, {
          data: [{ id: "INFO", attributes: { state: "PREPARE_FOR_SUBMISSION" } }],
        });
      if (m === "GET" && p === "/v1/appInfos/INFO/appInfoLocalizations")
        return reply(200, { data: state.infoLoc ? [state.infoLoc] : [] });
      if (m === "GET" && p === "/v1/appInfos/INFO/primaryCategory")
        return reply(200, { data: state.category ? { id: state.category } : null });
      if (m === "GET" && p === "/v1/appInfos/INFO/ageRatingDeclaration")
        return reply(200, { data: state.age });
      if (m === "GET" && p === "/v1/apps/APP/appStoreVersions")
        return reply(200, {
          data: [
            {
              id: "VER",
              attributes: {
                versionString: "1.0",
                appStoreState: "PREPARE_FOR_SUBMISSION",
                copyright: state.copyright,
              },
            },
          ],
        });
      if (m === "GET" && p === "/v1/appStoreVersions/VER/appStoreVersionLocalizations")
        return reply(200, { data: state.versionLoc ? [state.versionLoc] : [] });
      if (m === "GET" && p === "/v1/apps/APP/appPriceSchedule")
        return state.price.exists
          ? reply(200, {
              data: {
                id: "SCHED",
                relationships: {
                  baseTerritory: { data: { type: "territories", id: state.price.baseTerritory } },
                },
              },
            })
          : reply(200, { data: null });
      if (m === "GET" && p === "/v1/appPriceSchedules/SCHED/manualPrices")
        return reply(200, {
          data: state.price.prices.map((pr) => ({
            id: pr.id,
            attributes: { startDate: pr.startDate, endDate: pr.endDate },
            relationships: { appPricePoint: { data: { id: pr.pricePoint } } },
          })),
          included: state.price.prices.map((pr) => ({
            id: pr.pricePoint,
            attributes: { customerPrice: pr.customerPrice },
          })),
        });
      if (m === "GET" && p === "/v1/apps/APP/appPricePoints")
        return reply(200, { data: [{ id: "FREE_PP", attributes: { customerPrice: "0.0" } }] });

      if (m === "PATCH" && p === "/v1/appInfoLocalizations/INFO_LOC") {
        Object.assign(state.infoLoc!.attributes, parsed.data.attributes);
        return reply(200, { data: state.infoLoc });
      }
      if (m === "POST" && p === "/v1/appInfoLocalizations") {
        state.infoLoc = { id: "INFO_LOC", attributes: parsed.data.attributes };
        return reply(201, { data: state.infoLoc });
      }
      if (m === "PATCH" && p === "/v1/appInfos/INFO") {
        state.category = parsed.data.relationships.primaryCategory.data.id;
        return reply(200, { data: { id: "INFO" } });
      }
      if (m === "PATCH" && p === "/v1/ageRatingDeclarations/AGE") {
        Object.assign(state.age.attributes, parsed.data.attributes);
        return reply(200, { data: state.age });
      }
      if (m === "PATCH" && p === "/v1/apps/APP") {
        state.app.contentRightsDeclaration = parsed.data.attributes.contentRightsDeclaration;
        return reply(200, { data: { id: "APP", attributes: state.app } });
      }
      if (m === "PATCH" && p === "/v1/appStoreVersionLocalizations/VER_LOC") {
        Object.assign(state.versionLoc!.attributes, parsed.data.attributes);
        return reply(200, { data: state.versionLoc });
      }
      if (m === "POST" && p === "/v1/appStoreVersionLocalizations") {
        state.versionLoc = { id: "VER_LOC", attributes: parsed.data.attributes };
        return reply(201, { data: state.versionLoc });
      }
      if (m === "PATCH" && p === "/v1/appStoreVersions/VER") {
        state.copyright = parsed.data.attributes.copyright;
        return reply(200, { data: { id: "VER", attributes: { copyright: state.copyright } } });
      }
      if (m === "POST" && p === "/v1/appPriceSchedules") {
        state.price = {
          exists: true,
          baseTerritory: parsed.data.relationships.baseTerritory.data.id,
          prices: [
            {
              id: "P1",
              pricePoint: parsed.included[0].relationships.appPricePoint.data.id,
              startDate: null,
              endDate: null,
              customerPrice: "0.0",
            },
          ],
        };
        return reply(201, { data: { id: "SCHED" } });
      }
      return reply(404, { errors: [{ code: "NOT_FOUND", detail: `${m} ${p}` }] });
    });
  });
  return { server, state };
}

let dir: string;
let keyPath: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "asc-listing-test-"));
  keyPath = path.join(dir, "asc-key.p8");
  execFileSync(
    "openssl",
    ["genpkey", "-algorithm", "EC", "-pkeyopt", "ec_paramgen_curve:P-256", "-out", keyPath],
    { stdio: "ignore" }
  );
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function runCli(args: string[], base: string) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child: ChildProcess = spawn("node", [script, ...args], {
      cwd: repoRoot,
      env: {
        ...process.env,
        APP_STORE_CONNECT_KEY_ID: "TESTKEY",
        APP_STORE_CONNECT_ISSUER_ID: "TESTISSUER",
        APP_STORE_CONNECT_PRIVATE_KEY: "",
        ASC_KEY_PATH: keyPath,
        ASC_API_BASE_URL: base,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c) => (stdout += c.toString()));
    child.stderr?.on("data", (c) => (stderr += c.toString()));
    child.on("error", () => resolve({ code: 1, stdout, stderr }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

let server: Server;
let state: StubState;
let base: string;

beforeEach(async () => {
  const started = startStub();
  server = started.server;
  state = started.state;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function writes() {
  return state.calls.filter((c) => c.method !== "GET");
}

describe("appstore-listing check", () => {
  it("reports the listing is in sync when every value matches", async () => {
    const result = await runCli(["check"], base);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("in sync");
    expect(writes()).toHaveLength(0);
  });

  it("exits non-zero and names the drifted field", async () => {
    state.versionLoc!.attributes.description = "An old description";
    const result = await runCli(["check"], base);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toContain("version.description");
    expect(result.stdout).toContain("apply");
    expect(writes()).toHaveLength(0);
  });

  it("detects category, content-rights and pricing drift", async () => {
    state.category = "BUSINESS";
    state.app.contentRightsDeclaration = "DOES_NOT_USE_THIRD_PARTY_CONTENT";
    state.price.prices = [
      { id: "P1", pricePoint: "PP0", startDate: null, endDate: null, customerPrice: "4.99" },
    ];
    const result = await runCli(["check"], base);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toContain("app.primaryCategory");
    expect(result.stdout).toContain("app.contentRightsDeclaration");
    expect(result.stdout).toContain("pricing");
  });

  it("passes an explicitly selected app (--app) that is already canonical", async () => {
    const result = await runCli(["check", "--app", "APP"], base);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("in sync");
  });

  it("flags a non-free price even when a zero-priced entry also exists", async () => {
    state.price.prices = [
      // An expired free period (history) plus a current paid period.
      { id: "OLD", pricePoint: "PP0", startDate: "2024-01-01T00:00:00Z", endDate: "2024-06-01T00:00:00Z", customerPrice: "0.0" },
      { id: "NOW", pricePoint: "PP9", startDate: "2024-06-01T00:00:00Z", endDate: null, customerPrice: "9.99" },
    ];
    const result = await runCli(["check"], base);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toContain("pricing");
  });

  it("flags a scheduled future paid price", async () => {
    state.price.prices = [
      { id: "NOW", pricePoint: "PP0", startDate: null, endDate: "2030-01-01T00:00:00Z", customerPrice: "0.0" },
      { id: "SOON", pricePoint: "PP9", startDate: "2027-01-01T00:00:00Z", endDate: null, customerPrice: "9.99" },
    ];
    const result = await runCli(["check"], base);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toContain("pricing");
  });

  it("flags a mismatched base territory", async () => {
    state.price.baseTerritory = "GBR";
    const result = await runCli(["check"], base);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toContain("pricing.baseTerritory");
  });
});

describe("appstore-listing apply", () => {
  it("writes every drifted field with the canonical value", async () => {
    state.infoLoc!.attributes.name = "Old name";
    state.category = "BUSINESS";
    state.age.attributes.messagingAndChat = false;
    state.app.contentRightsDeclaration = "DOES_NOT_USE_THIRD_PARTY_CONTENT";
    state.versionLoc!.attributes.keywords = "stale";
    state.copyright = null;

    const result = await runCli(["apply"], base);
    expect(result.code).toBe(0);

    const infoPatch = state.calls.find((c) => c.method === "PATCH" && c.path === "/v1/appInfoLocalizations/INFO_LOC");
    expect(infoPatch!.body.data.attributes.name).toBe(LISTING.app.name);

    const categoryPatch = state.calls.find((c) => c.method === "PATCH" && c.path === "/v1/appInfos/INFO");
    expect(categoryPatch!.body.data.relationships.primaryCategory.data.id).toBe(LISTING.app.primaryCategory);

    const agePatch = state.calls.find((c) => c.method === "PATCH" && c.path === "/v1/ageRatingDeclarations/AGE");
    expect(agePatch!.body.data.attributes.messagingAndChat).toBe(true);

    const appPatch = state.calls.find((c) => c.method === "PATCH" && c.path === "/v1/apps/APP");
    expect(appPatch!.body.data.attributes.contentRightsDeclaration).toBe(LISTING.app.contentRightsDeclaration);

    const verLocPatch = state.calls.find((c) => c.method === "PATCH" && c.path === "/v1/appStoreVersionLocalizations/VER_LOC");
    expect(verLocPatch!.body.data.attributes.keywords).toBe(LISTING.version.keywords);

    const verPatch = state.calls.find((c) => c.method === "PATCH" && c.path === "/v1/appStoreVersions/VER");
    expect(verPatch!.body.data.attributes.copyright).toBe(LISTING.version.copyright);
  });

  it("creates the version localization for a new version", async () => {
    state.versionLoc = null;
    const result = await runCli(["apply"], base);
    expect(result.code).toBe(0);
    const created = state.calls.find((c) => c.method === "POST" && c.path === "/v1/appStoreVersionLocalizations");
    expect(created).toBeTruthy();
    expect(created!.body.data.attributes.description).toBe(LISTING.version.description);
    expect(created!.body.data.attributes.locale).toBe("en-US");
    expect(created!.body.data.relationships.appStoreVersion.data.id).toBe("VER");
  });

  it("creates a free price schedule when the app has none", async () => {
    state.price = { exists: false, baseTerritory: "USA", prices: [] };
    const result = await runCli(["apply"], base);
    expect(result.code).toBe(0);
    const created = state.calls.find((c) => c.method === "POST" && c.path === "/v1/appPriceSchedules");
    expect(created).toBeTruthy();
    expect(created!.body.data.relationships.baseTerritory.data.id).toBe(LISTING.pricing.baseTerritory);
    expect(created!.body.included[0].relationships.appPricePoint.data.id).toBe("FREE_PP");
  });

  it("fails loudly when an existing paid schedule cannot be changed via the API", async () => {
    state.price.prices = [
      { id: "NOW", pricePoint: "PP9", startDate: null, endDate: null, customerPrice: "9.99" },
    ];
    const result = await runCli(["apply"], base);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("cannot change an existing price schedule");
    expect(state.calls.some((c) => c.method === "POST" && c.path === "/v1/appPriceSchedules")).toBe(false);
  });

  it("writes nothing when an explicitly selected app already matches", async () => {
    const result = await runCli(["apply", "--app", "APP"], base);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("already matches");
    expect(writes()).toHaveLength(0);
  });

  it("writes nothing when the listing already matches", async () => {
    const result = await runCli(["apply"], base);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("already matches");
    expect(writes()).toHaveLength(0);
  });
});
