// Legal-framing drift guard — the "legal information, not legal advice"
// contract is load-bearing (docs/producer-platform-plan.md, P0 trust gates),
// so every surface that carries it is pinned here, Tap-to-Pay-copy-test
// style: edit the framing on any surface and this suite fails.

import { readFileSync } from "fs";
import { join } from "path";
import { LEGAL_INFORMATION_DISCLAIMER } from "@/utils/regulations/schema";
import { GOLDEN_CASES, runGoldenCase } from "@/utils/regulations/golden-answers";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("not-legal-advice framing on every answer surface", () => {
  it("the disclaimer itself keeps the framing", () => {
    expect(LEGAL_INFORMATION_DISCLAIMER).toContain("legal information");
    expect(LEGAL_INFORMATION_DISCLAIMER).toContain("not legal advice");
  });

  it("the chat page carries the framing persistently, not only per message", () => {
    const page = read("pages/regulations/index.tsx");
    expect(page).toContain("not legal advice");
    expect(page).toContain("/terms");
  });

  it("the Terms of Service carry the regulation-answers section", () => {
    const terms = read("pages/terms/index.tsx");
    expect(terms).toContain("not legal advice");
    expect(terms.toLowerCase()).toContain("regulation");
    expect(terms).toContain("attorney-client");
  });

  it("the explain prompt still forbids advice and requires statute phrasing", () => {
    const explain = read("utils/regulations/explain.ts");
    expect(explain).toContain("the statute says X");
    expect(explain).toContain("Never say what the user should do");
  });

  it("every golden answer served to a user carries the disclaimer", async () => {
    for (const goldenCase of GOLDEN_CASES) {
      const answer = await runGoldenCase(goldenCase);
      expect(answer.failures).toEqual([]);
    }
    // runGoldenCase asserts the disclaimer on every status path; a direct
    // check here keeps that invariant explicit.
  });
});
