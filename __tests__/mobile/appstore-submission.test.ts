import { ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..", "..");
const script = path.join(
  repoRoot,
  "apps",
  "mobile",
  "scripts",
  "appstore-submission.mjs"
);

// ---------------------------------------------------------------------------
// Stub App Store Connect API.

type Call = { method: string; path: string; body: unknown };

type Body = {
  data: {
    id?: string;
    attributes: {
      screenshotDisplayType?: string;
      fileSize?: number;
      uploaded?: boolean;
      submitted?: boolean;
    };
    relationships?: Record<string, { data?: { id?: string } }>;
  };
};

const BLOCKERS = {
  "/v1/appStoreVersionLocalizations/LOC/placements": [
    {
      code: "STATE_ERROR.SCREENSHOT_REQUIRED.IPAD_13_PROFILE",
      title: "App screenshot missing (IPAD_13_PROFILE).",
      detail: "A screenshot for one of the following types is required",
    },
    {
      code: "STATE_ERROR.SCREENSHOT_REQUIRED.IPHONE_DYNAMIC_ISLAND",
      title: "App screenshot missing (IPHONE_DYNAMIC_ISLAND).",
      detail: "A screenshot for one of the following types is required",
    },
  ],
  "/v1/appDataUsages/": [
    {
      code: "STATE_ERROR.APP_DATA_USAGES_REQUIRED",
      title: "Answers to what data your app collects and how it's used are needed.",
      detail: "You must have published answers to your app's data usages.",
    },
  ],
};

interface StubState {
  calls: Call[];
  sets: { id: string; attributes: { screenshotDisplayType: string } }[];
  shots: Record<string, { id: string }[]>;
  attachments: { id: string }[];
  blockers: unknown;
  submitOk: boolean;
  submissions: {
    id: string;
    attributes: { platform?: string; state: string; submittedDate: string | null };
  }[];
  items: string[]; // staged appStoreVersion ids
}

function startStub() {
  const state: StubState = {
    calls: [],
    sets: [],
    shots: {},
    attachments: [],
    blockers: BLOCKERS,
    submitOk: false,
    submissions: [],
    items: [],
  };
  let seq = 0;

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const isJson = (req.headers["content-type"] ?? "").includes("application/json");
      const parsed = isJson && raw.length ? JSON.parse(raw.toString()) : null;
      const url = new URL(req.url ?? "", "http://x");
      const p = url.pathname;
      const m = req.method ?? "GET";
      state.calls.push({ method: m, path: p, body: parsed });
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const reply = (status: number, json?: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(json === undefined ? "" : JSON.stringify(json));
      };

      if (m === "GET" && p === "/v1/apps")
        return reply(200, {
          data: [{ id: "APP", attributes: { bundleId: "com.selfsown.mobile" } }],
        });
      if (m === "GET" && p === "/v1/apps/APP/appStoreVersions")
        return reply(200, {
          data: [
            {
              id: "VER",
              attributes: {
                versionString: "1.0",
                appStoreState: "PREPARE_FOR_SUBMISSION",
              },
            },
          ],
        });
      if (m === "GET" && p === "/v1/appStoreVersions/VER/appStoreVersionLocalizations")
        return reply(200, { data: [{ id: "LOC", attributes: { locale: "en-US" } }] });
      if (m === "GET" && p === "/v1/appStoreVersionLocalizations/LOC/appScreenshotSets")
        return reply(200, { data: state.sets });
      if (m === "POST" && p === "/v1/appScreenshotSets") {
        const dt = (parsed as Body).data.attributes.screenshotDisplayType as string;
        const set = { id: `SET-${dt}`, attributes: { screenshotDisplayType: dt } };
        state.sets.push(set);
        return reply(201, { data: set });
      }
      if (m === "GET" && p.startsWith("/v1/appScreenshotSets/") && p.endsWith("/appScreenshots")) {
        const id = p.slice("/v1/appScreenshotSets/".length, -"appScreenshots".length - 1);
        return reply(200, { data: state.shots[id] ?? [] });
      }
      if (m === "POST" && p === "/v1/appScreenshots") {
        seq += 1;
        return reply(201, {
          data: {
            id: `SHOT-${seq}`,
            attributes: {
              uploadOperations: [
                {
                  method: "PUT",
                  url: `${base}/upload`,
                  length: (parsed as Body).data.attributes.fileSize,
                  offset: 0,
                  requestHeaders: [{ name: "Content-Type", value: "image/png" }],
                },
              ],
            },
          },
        });
      }
      if (m === "PATCH" && p.startsWith("/v1/appScreenshots/"))
        return reply(200, { data: { id: p.split("/").pop() } });
      if (m === "DELETE" && p.startsWith("/v1/appScreenshots/")) return reply(204);
      if (m === "GET" && p === "/v1/appStoreVersions/VER/appStoreReviewDetail")
        return reply(200, { data: { id: "RD", attributes: {} } });
      if (m === "GET" && p === "/v1/appStoreReviewDetails/RD/appStoreReviewAttachments")
        return reply(200, { data: state.attachments });
      if (m === "POST" && p === "/v1/appStoreReviewAttachments") {
        state.attachments.push({ id: "ATT" });
        return reply(201, {
          data: {
            id: "ATT",
            attributes: {
              uploadOperations: [
                {
                  method: "PUT",
                  url: `${base}/upload`,
                  length: (parsed as Body).data.attributes.fileSize,
                  offset: 0,
                  requestHeaders: [{ name: "Content-Type", value: "video/mp4" }],
                },
              ],
            },
          },
        });
      }
      if (m === "PATCH" && p.startsWith("/v1/appStoreReviewAttachments/"))
        return reply(200, { data: {} });
      if (m === "GET" && p === "/v1/apps/APP/reviewSubmissions")
        return reply(200, { data: state.submissions });
      if (m === "POST" && p === "/v1/reviewSubmissions") {
        const sub = {
          id: "SUB",
          attributes: { platform: "IOS", state: "READY_FOR_REVIEW", submittedDate: null },
        };
        state.submissions.push(sub);
        return reply(201, { data: sub });
      }
      if (m === "GET" && p === "/v1/reviewSubmissions/SUB/items")
        return reply(200, {
          data: state.items.map((versionId, i) => ({
            id: `ITEM-${i}`,
            relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: versionId } } },
          })),
        });
      if (m === "POST" && p === "/v1/reviewSubmissionItems") {
        if (state.submitOk) {
          state.items.push("VER");
          return reply(201, { data: { id: "ITEM" } });
        }
        return reply(409, {
          errors: [
            {
              id: "E",
              status: "409",
              code: "STATE_ERROR.ENTITY_STATE_INVALID",
              title: "version not in valid state",
              detail: "check associated errors",
              meta: { associatedErrors: state.blockers },
            },
          ],
        });
      }
      if (m === "PATCH" && p.startsWith("/v1/reviewSubmissions/"))
        return reply(200, { data: { id: "SUB", attributes: { submitted: true } } });
      if (m === "PUT" && p === "/upload") return reply(200, {});
      return reply(404, { errors: [{ code: "NOT_FOUND", detail: `${m} ${p}` }] });
    });
  });

  return { server, state };
}

// ---------------------------------------------------------------------------

function png(width: number, height: number): Buffer {
  // Minimal PNG header: signature + IHDR (enough for a dimension read).
  const buf = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

let dir: string;
let keyPath: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "asc-submit-test-"));
  keyPath = path.join(dir, "asc-key.p8");
  execFileSync(
    "openssl",
    [
      "genpkey",
      "-algorithm",
      "EC",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
      "-out",
      keyPath,
    ],
    { stdio: "ignore" }
  );
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

function runCli(args: string[], base: string, extraEnv: Record<string, string> = {}, cwd = repoRoot) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child: ChildProcess = spawn("node", [script, ...args], {
      cwd,
      env: {
        ...process.env,
        APP_STORE_CONNECT_KEY_ID: "TESTKEY",
        APP_STORE_CONNECT_ISSUER_ID: "TESTISSUER",
        APP_STORE_CONNECT_PRIVATE_KEY: "",
        ASC_KEY_PATH: keyPath,
        ASC_API_BASE_URL: base,
        ...extraEnv,
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

describe("appstore-submission status", () => {
  it("prints the blocker checklist Apple reports for the version", async () => {
    const result = await runCli(["status"], base);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("SCREENSHOT_REQUIRED.IPAD_13_PROFILE");
    expect(result.stdout).toContain("SCREENSHOT_REQUIRED.IPHONE_DYNAMIC_ISLAND");
    expect(result.stdout).toContain("APP_DATA_USAGES_REQUIRED");
    // reviewSubmissions cannot be deleted (Apple 403s); the CLI must never try.
    expect(state.calls.some((c) => c.method === "DELETE" && c.path.startsWith("/v1/reviewSubmissions/"))).toBe(false);
  });

  it("reuses the app's existing draft submission instead of creating another", async () => {
    state.submissions = [
      { id: "SUB", attributes: { platform: "IOS", state: "READY_FOR_REVIEW", submittedDate: null } },
    ];
    const result = await runCli(["status"], base);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("SCREENSHOT_REQUIRED.IPAD_13_PROFILE");
    expect(state.calls.some((c) => c.method === "POST" && c.path === "/v1/reviewSubmissions")).toBe(false);
  });

  it("reports readiness when Apple lists no blockers", async () => {
    state.submitOk = true;
    const result = await runCli(["status"], base);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("No API-reportable blockers");
  });

  it("reports a version already staged on the draft submission", async () => {
    state.items = ["VER"];
    const result = await runCli(["status"], base);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("already staged");
  });

  it("reports a conflict when the draft stages a different version", async () => {
    state.items = ["OTHER-VERSION"];
    const result = await runCli(["status"], base);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toContain("already stages other review content");
    expect(result.stdout).not.toContain("No API-reportable blockers");
  });

  it("ignores a draft submission for a different platform", async () => {
    state.submissions = [
      { id: "MAC", attributes: { platform: "MAC_OS", state: "READY_FOR_REVIEW", submittedDate: null } },
    ];
    const result = await runCli(["status"], base);
    expect(result.code).toBe(0);
    // It must not consume the macOS draft; it creates an iOS one instead.
    expect(state.calls.some((c) => c.method === "POST" && c.path === "/v1/reviewSubmissions")).toBe(true);
  });
});

describe("appstore-submission screenshots", () => {
  function shotDir(files: Record<string, Buffer>) {
    const d = mkdtempSync(path.join(dir, "shots-"));
    for (const [name, buf] of Object.entries(files)) writeFileSync(path.join(d, name), buf);
    return d;
  }

  it("uploads both required device sets and completes each asset", async () => {
    const d = shotDir({
      "iphone-1.png": png(1290, 2796),
      "ipad-1.png": png(2048, 2732),
    });
    const result = await runCli(["screenshots", "--dir", d], base);
    expect(result.code).toBe(0);
    const created = state.calls.filter((c) => c.method === "POST" && c.path === "/v1/appScreenshotSets");
    const types = created.map((c) => (c.body as Body).data.attributes.screenshotDisplayType).sort();
    expect(types).toEqual(["APP_IPAD_PRO_3GEN_129", "APP_IPHONE_67"]);
    // Two assets created and two upload PUTs performed.
    expect(state.calls.filter((c) => c.method === "POST" && c.path === "/v1/appScreenshots")).toHaveLength(2);
    expect(state.calls.filter((c) => c.method === "PUT" && c.path === "/upload")).toHaveLength(2);
    // Each asset is marked uploaded.
    const patches = state.calls.filter((c) => c.method === "PATCH" && c.path.startsWith("/v1/appScreenshots/"));
    expect(patches).toHaveLength(2);
    expect((patches[0]!.body as Body).data.attributes.uploaded).toBe(true);
  });

  it("rejects a wrong-size image before uploading anything", async () => {
    const d = shotDir({
      "iphone-1.png": png(1290, 2796),
      "oops.png": png(1000, 1000),
    });
    const result = await runCli(["screenshots", "--dir", d], base);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("not an accepted App Store size");
    expect(state.calls.some((c) => c.method === "PUT")).toBe(false);
    expect(state.calls.some((c) => c.method === "POST" && c.path === "/v1/appScreenshots")).toBe(false);
  });

  it("requires both device sets for a tablet build", async () => {
    const d = shotDir({ "iphone-1.png": png(1320, 2868) });
    const result = await runCli(["screenshots", "--dir", d], base);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("iPad");
    expect(state.calls.some((c) => c.method === "POST" && c.path === "/v1/appScreenshotSets")).toBe(false);
  });

  it("refuses to clobber existing screenshots without --replace", async () => {
    state.sets = [{ id: "SET-APP_IPHONE_67", attributes: { screenshotDisplayType: "APP_IPHONE_67" } }];
    state.shots["SET-APP_IPHONE_67"] = [{ id: "OLD" }];
    const d = shotDir({
      "iphone-1.png": png(1290, 2796),
      "ipad-1.png": png(2048, 2732),
    });
    const result = await runCli(["screenshots", "--dir", d], base);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("--replace");
    expect(state.calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("replaces existing screenshots when --replace is passed", async () => {
    state.sets = [{ id: "SET-APP_IPHONE_67", attributes: { screenshotDisplayType: "APP_IPHONE_67" } }];
    state.shots["SET-APP_IPHONE_67"] = [{ id: "OLD" }];
    const d = shotDir({
      "iphone-1.png": png(1290, 2796),
      "ipad-1.png": png(2064, 2752),
    });
    const result = await runCli(["screenshots", "--dir", d, "--replace"], base);
    expect(result.code).toBe(0);
    expect(state.calls.some((c) => c.method === "DELETE" && c.path === "/v1/appScreenshots/OLD")).toBe(true);
  });
});

describe("appstore-submission attachment", () => {
  it("uploads the walkthrough video to the review detail", async () => {
    const file = path.join(dir, "walkthrough.mp4");
    writeFileSync(file, Buffer.alloc(2048));
    const result = await runCli(["attachment", "--file", file], base);
    expect(result.code).toBe(0);
    const created = state.calls.find((c) => c.method === "POST" && c.path === "/v1/appStoreReviewAttachments");
    expect(created).toBeTruthy();
    expect((created!.body as Body).data.relationships?.appStoreReviewDetail?.data?.id).toBe("RD");
    expect(state.calls.some((c) => c.method === "PUT" && c.path === "/upload")).toBe(true);
  });
});

describe("appstore-submission submit", () => {
  it("stages the version on the draft submission and submits it", async () => {
    state.submitOk = true;
    const result = await runCli(["submit", "--version", "1.0"], base);
    expect(result.code).toBe(0);
    expect(state.calls.some((c) => c.method === "POST" && c.path === "/v1/reviewSubmissionItems")).toBe(true);
    const patch = state.calls.find((c) => c.method === "PATCH" && c.path === "/v1/reviewSubmissions/SUB");
    expect(patch).toBeTruthy();
    expect((patch!.body as Body).data.attributes.submitted).toBe(true);
    expect(result.stdout).toContain("Submitted version 1.0");
  });

  it("does not duplicate an already-staged version", async () => {
    state.items = ["VER"];
    const result = await runCli(["submit", "--version", "1.0"], base);
    expect(result.code).toBe(0);
    expect(state.calls.some((c) => c.method === "POST" && c.path === "/v1/reviewSubmissionItems")).toBe(false);
    expect(state.calls.some((c) => c.method === "PATCH" && c.path === "/v1/reviewSubmissions/SUB")).toBe(true);
  });

  it("refuses to submit when the draft stages other content", async () => {
    state.submitOk = true;
    state.items = ["OTHER-VERSION"];
    const result = await runCli(["submit", "--version", "1.0"], base);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("already stages other review content");
    expect(state.calls.some((c) => c.method === "PATCH" && c.path.startsWith("/v1/reviewSubmissions/"))).toBe(false);
  });

  it("aborts when the version still has blockers", async () => {
    const result = await runCli(["submit", "--version", "1.0"], base);
    expect(result.code).not.toBe(0);
    expect(state.calls.some((c) => c.method === "PATCH" && c.path === "/v1/reviewSubmissions/SUB")).toBe(false);
  });
});

describe("appstore-submission key handling", () => {
  it("parses a private key that arrived newline-collapsed from a secret", async () => {
    const collapsed = readFileSync(keyPath, "utf8").replace(/\n/g, " ").trim();
    const result = await runCli(["status"], base, {
      APP_STORE_CONNECT_PRIVATE_KEY: collapsed,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Version 1.0");
  });

  it("resolves the default key path from the script, not the working directory", async () => {
    // pnpm --filter runs these commands with cwd=apps/mobile; a cwd-relative
    // default would look for apps/mobile/apps/mobile/keys/asc-key.p8.
    const mobileDir = path.join(repoRoot, "apps", "mobile");
    const result = await runCli(["status"], base, {
      ASC_KEY_PATH: "",
      APP_STORE_CONNECT_PRIVATE_KEY: "",
    }, mobileDir);
    const output = result.stdout + result.stderr;
    expect(output).not.toContain(path.join("apps", "mobile", "apps", "mobile"));
  });
});
