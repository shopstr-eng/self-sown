/**
 * @jest-environment node
 */
// Unit coverage for the standalone boot path (`pnpm start`). The app builds
// with `output: "standalone"`, where `next start` is unsupported — these
// scripts are the supported entry point, so their failure modes (missing
// build, asset folding, non-strict Sharp repair) are pinned here. The genuine
// compile-and-boot run lives in
// utils/self-host/__tests__/export-bundle-full-build.test.ts (gated).

import { spawn, spawnSync, type ChildProcess } from "child_process";
import fs from "fs";
import http from "http";
import type { AddressInfo } from "net";
import os from "os";
import path from "path";

const ROOT = path.resolve(__dirname, "..", "..");
const PREPARE = path.join(ROOT, "scripts", "prepare-standalone.mjs");
const START = path.join(ROOT, "scripts", "start-standalone.mjs");

function makeFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-standalone-"));
  fs.mkdirSync(path.join(dir, ".next", "standalone"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".next", "standalone", "server.js"),
    "// fixture\n"
  );
  fs.mkdirSync(path.join(dir, ".next", "static", "chunks"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(dir, ".next", "static", "chunks", "app.js"),
    "// chunk\n"
  );
  fs.mkdirSync(path.join(dir, "public"), { recursive: true });
  fs.writeFileSync(path.join(dir, "public", "favicon.ico"), "icon");
  return dir;
}

describe("prepare-standalone.mjs", () => {
  let workDir: string;
  afterEach(() => {
    if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
  });

  it("fails loudly when there is no standalone build", () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-standalone-"));
    const res = spawnSync(process.execPath, [PREPARE], {
      cwd: workDir,
      encoding: "utf8",
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("pnpm build");
  });

  it("folds .next/static and public into the standalone bundle", () => {
    workDir = makeFixture();
    const res = spawnSync(process.execPath, [PREPARE], {
      cwd: workDir,
      encoding: "utf8",
    });
    // The fixture has no Sharp in its fake standalone bundle: the non-strict
    // repair must WARN (not fail) so a self-host boot is never blocked by it.
    expect(res.status).toBe(0);
    expect(res.stderr).toMatch(/WARNING: .*Sharp/i);
    expect(
      fs.existsSync(
        path.join(
          workDir,
          ".next",
          "standalone",
          ".next",
          "static",
          "chunks",
          "app.js"
        )
      )
    ).toBe(true);
    expect(
      fs.existsSync(
        path.join(workDir, ".next", "standalone", "public", "favicon.ico")
      )
    ).toBe(true);
  });

  it("fails the Sharp repair under --strict-sharp (deploy build behavior)", () => {
    workDir = makeFixture();
    const res = spawnSync(process.execPath, [PREPARE, "--strict-sharp"], {
      cwd: workDir,
      encoding: "utf8",
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/Sharp/);
    // Static folding still happened before the Sharp failure.
    expect(
      fs.existsSync(
        path.join(workDir, ".next", "standalone", "public", "favicon.ico")
      )
    ).toBe(true);
  });
});

describe("start-standalone.mjs", () => {
  let workDir: string;
  afterEach(() => {
    if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
  });

  it("refuses to boot without a build and points at pnpm build", () => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), "mm-standalone-"));
    const res = spawnSync(process.execPath, [START], {
      cwd: workDir,
      encoding: "utf8",
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("pnpm build");
  });

  it("prepares the bundle, then boots the standalone server on PORT", async () => {
    workDir = makeFixture();
    // A real HTTP fixture server in place of the Next standalone server.js:
    // proves start-standalone runs prepare first, then execs server.js with
    // the env PORT honored (the self-host run contract).
    fs.writeFileSync(
      path.join(workDir, ".next", "standalone", "server.js"),
      `require("http").createServer((req, res) => { res.end("ok"); })\n` +
        `  .listen(Number(process.env.PORT), "0.0.0.0");\n`
    );
    // Allocate a free port instead of fixing one — a fixed port collides with
    // whatever else is running and turns this test into a hang.
    const port = await new Promise<number>((resolve, reject) => {
      const srv = http.createServer();
      srv.once("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        const allocated = (srv.address() as AddressInfo).port;
        srv.close(() => resolve(allocated));
      });
    });

    const child: ChildProcess = spawn(process.execPath, [START], {
      cwd: workDir,
      env: { ...process.env, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (d) => {
      stderr += String(d);
    });

    try {
      // Poll over real HTTP until the fixture server answers.
      const deadline = Date.now() + 20000;
      let body = "";
      for (;;) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/`);
          body = await res.text();
          break;
        } catch {
          if (Date.now() > deadline) {
            throw new Error(
              `fixture server did not boot within 20s; stderr: ${stderr}`
            );
          }
          await new Promise((r) => setTimeout(r, 300));
        }
      }
      expect(body).toBe("ok");
      // Prepare ran before the boot: assets are folded into the bundle.
      expect(
        fs.existsSync(
          path.join(workDir, ".next", "standalone", "public", "favicon.ico")
        )
      ).toBe(true);
      expect(
        fs.existsSync(
          path.join(
            workDir,
            ".next",
            "standalone",
            ".next",
            "static",
            "chunks",
            "app.js"
          )
        )
      ).toBe(true);
    } finally {
      // Deterministic cleanup: SIGTERM the wrapper (which forwards it to the
      // fixture server) and await its exit so nothing outlives the test.
      if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
      await new Promise((r) => child.once("exit", r));
    }
  }, 30000);
});
