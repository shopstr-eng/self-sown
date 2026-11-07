// Wedge corpus integrity: the corpus is the moat, and a row without a real
// citation is invalid by definition. These tests run the same zod validation
// the store applies, plus the wedge coverage contract, so a broken or
// uncitable row fails CI before it can be served.

import {
  WEDGE_AGENCY_CONTACTS,
  WEDGE_CATEGORIES,
  WEDGE_CORPUS,
  WEDGE_STATES,
} from "@/utils/regulations/corpus";
import {
  agencyContactSchema,
  corpusRuleSchema,
} from "@/utils/regulations/schema";

const TODAY = "2026-11-07";

describe("wedge corpus schema validation", () => {
  test("every rule row validates (citation, excerpt, effective, last-verified)", () => {
    for (const rule of WEDGE_CORPUS) {
      const result = corpusRuleSchema.safeParse(rule);
      expect(result.success).toBe(true);
    }
  });

  test("every agency contact validates", () => {
    for (const contact of WEDGE_AGENCY_CONTACTS) {
      expect(agencyContactSchema.safeParse(contact).success).toBe(true);
    }
  });

  test("rule ids are unique", () => {
    const ids = WEDGE_CORPUS.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("citations are https URLs on primary-source hosts", () => {
    const allowedHosts = [
      "app.leg.wa.gov", // RCW + WAC
      "leg.wa.gov",
      "www.ecfr.gov", // federal regulations
      "agr.wa.gov", // WSDA guidance
      "cms.agr.wa.gov", // WSDA guidance PDFs
      "law.justia.com", // C.R.S. text (official portal is not deep-linkable; see decision doc)
      "cdphe.colorado.gov",
      "ag.colorado.gov",
    ];
    for (const rule of WEDGE_CORPUS) {
      const url = new URL(rule.citation_url);
      expect(url.protocol).toBe("https:");
      expect(allowedHosts).toContain(url.host);
    }
  });

  test("last_verified_at is a real date not in the future", () => {
    for (const rule of WEDGE_CORPUS) {
      expect(Number.isNaN(Date.parse(rule.last_verified_at))).toBe(false);
      expect(rule.last_verified_at <= TODAY).toBe(true);
    }
  });
});

describe("wedge coverage", () => {
  test("every wedge state × category slot has at least one rule", () => {
    for (const state of WEDGE_STATES) {
      for (const category of WEDGE_CATEGORIES) {
        const rules = WEDGE_CORPUS.filter(
          (rule) => rule.state === state && rule.category === category
        );
        expect(rules.length).toBeGreaterThan(0);
      }
    }
  });

  test("every wedge slot covers the parser-resolvable core channels", () => {
    for (const state of WEDGE_STATES) {
      for (const category of WEDGE_CATEGORIES) {
        const channels = new Set(
          WEDGE_CORPUS.filter(
            (rule) => rule.state === state && rule.category === category
          ).map((rule) => rule.channel)
        );
        // A missing channel answers "unknown" by design — that's lawful, but
        // the wedge promise is that the core channels are actually covered.
        for (const core of ["farmers_market", "on_farm", "online_interstate"]) {
          expect(channels.has(core)).toBe(true);
        }
      }
    }
  });

  test("interstate raw milk is prohibited in both wedge states via the federal rule", () => {
    for (const state of WEDGE_STATES) {
      const rows = WEDGE_CORPUS.filter(
        (rule) =>
          rule.state === state &&
          rule.category === "raw_milk" &&
          rule.channel === "online_interstate"
      );
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.decision).toBe("prohibited");
        expect(row.citation_url).toContain("ecfr.gov");
      }
    }
  });

  test("every wedge state has a default agency contact for unknown answers", () => {
    for (const state of WEDGE_STATES) {
      expect(
        WEDGE_AGENCY_CONTACTS.some(
          (contact) => contact.state === state && contact.category === null
        )
      ).toBe(true);
    }
  });

  test("every wedge state × category has a category-specific agency contact", () => {
    for (const state of WEDGE_STATES) {
      for (const category of WEDGE_CATEGORIES) {
        expect(
          WEDGE_AGENCY_CONTACTS.some(
            (contact) => contact.state === state && contact.category === category
          )
        ).toBe(true);
      }
    }
  });
});
