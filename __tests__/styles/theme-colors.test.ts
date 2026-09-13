import { execFileSync } from "child_process";
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
});
