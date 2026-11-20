import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..", "..");
const script = path.join(
  repoRoot,
  "apps",
  "mobile",
  "scripts",
  "verify-ios-entitlements.mjs"
);

const PROXIMITY = "com.apple.developer.proximity-reader.payment.acceptance";

function plist(entitlementLines: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<plist version="1.0"><dict>',
    "<key>Entitlements</key><dict>",
    entitlementLines,
    "</dict>",
    "</dict></plist>",
  ].join("");
}

// CMS-sign a plist exactly the way Apple wraps an embedded.mobileprovision, so
// the CLI's openssl decode path is exercised for real (not stubbed).
function signProfile(entitlementLines: string, dir: string, name: string) {
  const plistPath = path.join(dir, `${name}.plist`);
  const certPath = path.join(dir, "cert.pem");
  const keyPath = path.join(dir, "key.pem");
  const outPath = path.join(dir, `${name}.mobileprovision`);
  writeFileSync(plistPath, plist(entitlementLines));
  if (!existsSync(certPath)) {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-keyout",
        keyPath,
        "-out",
        certPath,
        "-days",
        "1",
        "-nodes",
        "-subj",
        "/CN=self-sown-test",
      ],
      { stdio: "ignore" }
    );
  }
  execFileSync(
    "openssl",
    [
      "smime",
      "-sign",
      "-in",
      plistPath,
      "-signer",
      certPath,
      "-inkey",
      keyPath,
      "-outform",
      "der",
      "-out",
      outPath,
      "-nodetach",
    ],
    { stdio: "ignore" }
  );
  return outPath;
}

function runVerify(target: string) {
  try {
    const stdout = execFileSync("node", [script, target], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    const failed = error as {
      status?: number;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    return {
      code: failed.status ?? 1,
      stdout: (failed.stdout ?? "").toString(),
      stderr: (failed.stderr ?? "").toString(),
    };
  }
}

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "ttp-entitlement-test-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const VALID = [
  "<key>aps-environment</key><string>production</string>",
  `<key>${PROXIMITY}</key><true/>`,
  "<key>application-identifier</key><string>JD83N884V6.com.selfsown.mobile</string>",
].join("");

describe("verify-ios-entitlements", () => {
  it("passes a production profile carrying the proximity-reader entitlement", () => {
    const profile = signProfile(VALID, dir, "valid");
    const result = runVerify(profile);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("aps-environment: production");
  });

  it("fails loudly when the proximity-reader entitlement is missing", () => {
    const profile = signProfile(
      "<key>aps-environment</key><string>production</string>",
      dir,
      "missing-proximity"
    );
    const result = runVerify(profile);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(PROXIMITY);
    expect(result.stderr).toContain("Refusing to proceed");
  });

  it("fails when aps-environment is not production", () => {
    const profile = signProfile(
      [
        "<key>aps-environment</key><string>development</string>",
        `<key>${PROXIMITY}</key><true/>`,
      ].join(""),
      dir,
      "dev-aps"
    );
    const result = runVerify(profile);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("aps-environment");
  });

  it("does not treat a nested/string-lookalike key as the entitlement", () => {
    // The entitlement key appears only as a value, never as a top-level key.
    const profile = signProfile(
      [
        "<key>aps-environment</key><string>production</string>",
        `<key>note</key><string>${PROXIMITY}</string>`,
      ].join(""),
      dir,
      "lookalike"
    );
    const result = runVerify(profile);
    expect(result.code).not.toBe(0);
  });

  const zipAvailable = (() => {
    try {
      execFileSync("zip", ["-v"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();

  it("reads the entitlement out of a real .ipa bundle", () => {
    if (!zipAvailable) return;
    const profile = signProfile(VALID, dir, "ipa-valid");
    const appDir = path.join(dir, "Payload", "SelfsownVendor.app");
    mkdirSync(appDir, { recursive: true });
    execFileSync("cp", [profile, path.join(appDir, "embedded.mobileprovision")]);
    const ipa = path.join(dir, "valid.ipa");
    execFileSync("zip", ["-q", "-r", ipa, "Payload"], { cwd: dir });
    const result = runVerify(ipa);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("aps-environment: production");
  });

  it("fails loudly on an .ipa whose profile lost the entitlement", () => {
    if (!zipAvailable) return;
    const profile = signProfile(
      "<key>aps-environment</key><string>production</string>",
      dir,
      "ipa-missing"
    );
    const appDir = path.join(dir, "Payload", "SelfsownVendor.app");
    execFileSync("cp", [profile, path.join(appDir, "embedded.mobileprovision")]);
    const ipa = path.join(dir, "missing.ipa");
    rmSync(ipa, { force: true });
    execFileSync("zip", ["-q", "-r", ipa, "Payload"], { cwd: dir });
    const result = runVerify(ipa);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(PROXIMITY);
  });
});

// ---- submission wrapper integration ----

const submitScript = path.join(
  repoRoot,
  "apps",
  "mobile",
  "scripts",
  "submit-ios.mjs"
);

async function runSubmit(args: string[], env: Record<string, string>) {
  // Async spawn (not execFileSync) so the event loop stays free to serve the
  // artifact HTTP server in the tests below; a synchronous call would deadlock.
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = spawn("node", [submitScript, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", () => resolve({ code: 1, stdout, stderr }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

// A stub EAS executable: logs its args, and answers the two commands the
// wrapper reads (build:list, build:view) with canned JSON.
function makeEasStub(dir: string, ipaUrl: string) {
  // A unique log per stub: a shared log would let one test's `submit` call
  // leak into another test's assertions.
  const log = path.join(mkdtempSync(path.join(dir, "stub-")), "eas-calls.log");
  const stub = path.join(dir, `eas-stub-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`);
  const listJson = JSON.stringify([{ id: "build-abc" }]);
  const viewJson = JSON.stringify({
    status: "FINISHED",
    artifacts: { buildUrl: ipaUrl },
  });
  writeFileSync(
    stub,
    [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$*" >> "${log}"`,
      'case "$1" in',
      `  build:list) printf '%s' '${listJson}' ;;`,
      `  build:view) printf '%s' '${viewJson}' ;;`,
      "esac",
      "exit 0",
      "",
    ].join("\n")
  );
  chmodSync(stub, 0o755);
  return { stub, log };
}

function makeIpa(dir: string, name: string, profile: string) {
  const work = mkdtempSync(path.join(dir, `${name}-`));
  const appDir = path.join(work, "Payload", "SelfsownVendor.app");
  mkdirSync(appDir, { recursive: true });
  execFileSync("cp", [profile, path.join(appDir, "embedded.mobileprovision")]);
  const ipa = path.join(work, `${name}.ipa`);
  execFileSync("zip", ["-q", "-r", ipa, "Payload"], { cwd: work });
  return ipa;
}

const zipAvailable = (() => {
  try {
    execFileSync("zip", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("submit-ios gate", () => {
  it("submits a verified IPA passed with --path, and tolerates a `--` separator", async () => {
    const profile = signProfile(VALID, dir, "submit-valid");
    const { stub, log } = makeEasStub(dir, "");
    const result = await runSubmit(["--", "--path", profile], {
      EAS_CLI_BIN: stub,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Tap to Pay entitlement present");
    const calls = existsSync(log) ? readFileSync(log, "utf8") : "";
    expect(calls).toContain("submit");
    expect(calls).toContain(profile);
  });

  it("never invokes submission when verification fails", async () => {
    const bad = signProfile(
      [
        "<key>aps-environment</key><string>development</string>",
        `<key>${PROXIMITY}</key><true/>`,
      ].join(""),
      dir,
      "submit-bad"
    );
    const { stub, log } = makeEasStub(dir, "");
    const result = await runSubmit(["--path", bad], { EAS_CLI_BIN: stub });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Refusing to submit");
    const calls = existsSync(log) ? readFileSync(log, "utf8") : "";
    expect(calls).not.toContain("submit");
  });

  it("resolves --latest, downloads the artifact, verifies it, then submits", async () => {
    if (!zipAvailable) return;
    const profile = signProfile(VALID, dir, "latest-valid");
    const ipa = makeIpa(dir, "latest", profile);
    const ipaBytes = readFileSync(ipa);
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(ipaBytes);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve())
    );
    const port = (server.address() as AddressInfo).port;
    try {
      const { stub, log } = makeEasStub(dir, `http://127.0.0.1:${port}/app.ipa`);
      const result = await runSubmit(["--latest"], {
        EAS_CLI_BIN: stub,
        EXPO_TOKEN: "test-token",
      });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("downloaded");
      const calls = existsSync(log) ? readFileSync(log, "utf8") : "";
      expect(calls).toContain("build:list");
      expect(calls).toContain("build:view");
      expect(calls).toContain("submit");
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it("resolves an explicit --build id without listing builds", async () => {
    if (!zipAvailable) return;
    const profile = signProfile(VALID, dir, "build-valid");
    const ipa = makeIpa(dir, "build", profile);
    const ipaBytes = readFileSync(ipa);
    const server = createServer((_req, res) => {
      res.writeHead(200);
      res.end(ipaBytes);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve())
    );
    const port = (server.address() as AddressInfo).port;
    try {
      const { stub, log } = makeEasStub(dir, `http://127.0.0.1:${port}/app.ipa`);
      const result = await runSubmit(["--build", "build-xyz"], {
        EAS_CLI_BIN: stub,
        EXPO_TOKEN: "test-token",
      });
      expect(result.code).toBe(0);
      const calls = existsSync(log) ? readFileSync(log, "utf8") : "";
      expect(calls).not.toContain("build:list");
      expect(calls).toContain("build:view build-xyz");
      expect(calls).toContain("submit");
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});
