/** @jest-environment node */
import fs from "node:fs";
import path from "node:path";

// Exercise the installed patched packages, not a mirror of their algorithms.
function installed(name: string, version: string, file: string) {
  const store = path.join(process.cwd(), "node_modules/.pnpm");
  const selector = `${name}@${version}`;
  const lines = fs.readFileSync("pnpm-lock.yaml", "utf8").split("\n");
  const index = lines.findIndex((line) => line.trim().replaceAll("'", "") === `${selector}:`);
  const hash = lines[index + 1]?.trim().replace("hash: ", "");
  expect(hash).toMatch(/^[a-f0-9]{64}$/);
  // pnpm truncates long peer-qualified directory names and appends a digest.
  const prefix = `${name.replace("/", "+")}@${version}_patch_hash=${hash!.slice(0, 40)}`;
  const candidates = fs.readdirSync(store).filter((entry) => entry.startsWith(prefix));
  expect(candidates.length).toBeGreaterThan(0);
  const location = path.join(store, candidates.at(-1)!, "node_modules", name, file);
  return { location, exports: jest.requireActual(location) };
}

describe("Expo development plugin output budgets", () => {
  const directory = "build/src/start/server/devtools/";
  const loaded = installed("@expo/cli", "57.0.35", `${directory}DevToolsPluginCliExtensionResults.js`);
  const Results = loaded.exports.DevToolsPluginCliExtensionResults;
  const { createRequire } = require("node:module");
  const cliRequire = createRequire(loaded.location);
  const schemaUtils = jest.requireActual(cliRequire.resolve("@expo/schema-utils"));

  it("rejects oversized bytes and arrays before schema validation", () => {
    const parse = jest.spyOn(schemaUtils, "validate");
    const results = new Results();
    results.append("x".repeat(65537));
    expect(results.getOutput()).toEqual([expect.objectContaining({ level: "error" })]);
    expect(parse).not.toHaveBeenCalled();
    const array = new Results();
    array.append(JSON.stringify(Array.from({ length: 257 }, () => null)));
    expect(array.getOutput()[0].text).toContain("limit exceeded");
    expect(parse).not.toHaveBeenCalled();
    parse.mockRestore();
  });

  it("keeps normal structured and plain-text output working", () => {
    const callback = jest.fn();
    const results = new Results(callback);
    results.append(JSON.stringify([{ type: "text", text: "Ready", level: "info" }]));
    results.append("one\ntwo");
    expect(results.getOutput().map((entry: { text: string }) => entry.text)).toEqual(["Ready", "one", "two"]);
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it("bounds accumulated output and stops processing after the first overflow", () => {
    const callback = jest.fn();
    const results = new Results(callback);
    for (let i = 0; i < 2000; i++) results.append("normal output");
    expect(results.getOutput()).toHaveLength(1024);
    expect(results.getOutput().at(-1).text).toContain("limit exceeded");
    expect(callback).toHaveBeenCalledTimes(1024);
    const byteLimited = new Results();
    for (let i = 0; i < 100; i++) byteLimited.append("x".repeat(65536));
    expect(byteLimited.getOutput()).toHaveLength(17);
    expect(byteLimited.getOutput().at(-1).level).toBe("error");
  });
});

describe.each(["9.0.9", "10.2.5"])("minimatch %s expansion budgets", (version) => {
  const { Minimatch } = installed("minimatch", version, "dist/commonjs/index.js").exports;
  it("rejects amplification before quadratic second-phase processing", () => {
    const process = jest.spyOn(Minimatch.prototype, "secondPhasePreProcess");
    expect(() => new Minimatch(`root/${"**/../a/b/".repeat(18)}file`, { optimizationLevel: 2 })).toThrow(/complexity limit/);
    expect(process).not.toHaveBeenCalled();
    process.mockRestore();
  });
  it("retains normal file-discovery semantics", () => {
    const matcher = new Minimatch("src/{app,pages}/**/*.tsx", { optimizationLevel: 2 });
    expect(matcher.match("src/app/settings/index.tsx")).toBe(true);
    expect(matcher.match("src/other/index.tsx")).toBe(false);
  });
});

describe("glob 10 abort stops work immediately", () => {
  const { GlobWalker } = installed("glob", "10.5.0", "dist/commonjs/walker.js").exports;
  it.each(["walkCB", "walkCBSync"])("%s does not enter the next walk stage", (method) => {
    const controller = new AbortController();
    controller.abort();
    const walker = new GlobWalker([], {}, { signal: controller.signal });
    const next = jest.spyOn(walker, method === "walkCB" ? "walkCB2" : "walkCB2Sync");
    const done = jest.fn();
    walker[method]({}, [], done);
    expect(done).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalled();
  });
  it.each(["walkCB2", "walkCB2Sync"])("%s does not process patterns after abort", (method) => {
    const controller = new AbortController();
    controller.abort();
    const walker = new GlobWalker([], {}, { signal: controller.signal });
    const processor = { processPatterns: jest.fn() };
    const done = jest.fn();
    walker[method]({}, [], processor, done);
    expect(done).toHaveBeenCalledTimes(1);
    expect(processor.processPatterns).not.toHaveBeenCalled();
  });
});
