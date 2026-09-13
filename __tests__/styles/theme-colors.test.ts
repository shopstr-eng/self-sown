import { execFileSync } from "child_process";
import { rmSync, writeFileSync } from "fs";
import path from "path";

/**
 * Guards against className tokens that reference a color Tailwind will never
 * generate — the palette token is missing from the Tailwind v4 default
 * palette, tailwind.config.ts `theme.extend.colors`, and HeroUI's semantic
 * colors. Tailwind silently skips unknown color classes (no build error, the
 * style just never applies), so palette cleanups leave dead classes behind;
 * a stale `hover:text-accent-white/10` survived for weeks in
 * components/home/marketplace.tsx before anyone noticed.
 *
 * The scan itself lives in scripts/check-theme-colors.mjs; it exits non-zero
 * (listing every offending file:line + class token on stderr, surfaced here
 * via the execFileSync error) when any unknown color reference is found.
 */
describe("theme color class tokens", () => {
  it("only reference colors Tailwind can generate", () => {
    const scriptPath = path.join(
      __dirname,
      "../../scripts/check-theme-colors.mjs"
    );
    const stdout = execFileSync(process.execPath, [scriptPath], {
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(stdout).toContain("check-theme-colors: ok");
  }, 90_000);

  it("flags v3-era *-opacity-* utilities Tailwind v4 removed", () => {
    const scriptPath = path.join(
      __dirname,
      "../../scripts/check-theme-colors.mjs"
    );
    // Scanned extension in a scanned dir (utils/, never a Next route dir so a
    // leftover can't break `next build`), cleaned up even on failure.
    const fixturePath = path.join(
      __dirname,
      "../../utils/__theme-colors-opacity-fixture.ts"
    );
    writeFileSync(fixturePath, 'export const DEAD = "bg-opacity-50";\n');
    try {
      let stderr = "";
      try {
        execFileSync(process.execPath, [scriptPath], {
          encoding: "utf8",
          timeout: 60_000,
        });
      } catch (err) {
        stderr = (err as { stderr?: string }).stderr ?? "";
      }
      expect(stderr).toContain("__theme-colors-opacity-fixture.ts");
      expect(stderr).toContain("bg-opacity-50");
      expect(stderr).toContain("removed in Tailwind v4");
    } finally {
      rmSync(fixturePath, { force: true });
    }
  }, 90_000);

  it("flags v3 size classes Tailwind v4 re-scaled", () => {
    const scriptPath = path.join(
      __dirname,
      "../../scripts/check-theme-colors.mjs"
    );
    const fixturePath = path.join(
      __dirname,
      "../../utils/__theme-colors-resized-fixture.ts"
    );
    writeFileSync(
      fixturePath,
      'export const RESIZED = "hover:shadow-sm backdrop-blur-sm ' +
        'focus:outline-none rounded-sm blur-sm";\n'
    );
    try {
      let stderr = "";
      try {
        execFileSync(process.execPath, [scriptPath], {
          encoding: "utf8",
          timeout: 60_000,
        });
      } catch (err) {
        stderr = (err as { stderr?: string }).stderr ?? "";
      }
      expect(stderr).toContain("__theme-colors-resized-fixture.ts");
      expect(stderr).toContain("re-scaled in Tailwind v4");
      for (const token of [
        "hover:shadow-sm",
        "backdrop-blur-sm",
        "focus:outline-none",
        "rounded-sm",
        "blur-sm",
      ]) {
        expect(stderr).toContain(token);
      }
    } finally {
      rmSync(fixturePath, { force: true });
    }
  }, 90_000);
});
