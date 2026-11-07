// The launch gate: the regulation chat serves nothing — page or API — until
// every golden case has documented attorney/FTCLDF sign-off
// (docs/regulations-attorney-review.md). This suite pins both halves: the
// gate is CLOSED while any case is pending, and the API route answers 404
// (not an unreviewed legal answer) while closed.

/** @jest-environment node */

import type { NextApiRequest, NextApiResponse } from "next";
import {
  allGoldenCasesApproved,
  GOLDEN_CASES,
  regulationsChatLaunched,
} from "@/utils/regulations/golden-set";

const mockApplyRateLimit = jest.fn();
jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: (...args: unknown[]) => mockApplyRateLimit(...args),
}));
const mockAnswer = jest.fn();
jest.mock("@/utils/regulations/chat", () => ({
  answerRegulationQuestion: (...args: unknown[]) => mockAnswer(...args),
  productionDeps: () => ({}),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const handler = require("@/pages/api/regulations/chat").default;

function mockRes() {
  const res: Partial<NextApiResponse> & {
    statusCode?: number;
    body?: unknown;
  } = {};
  res.status = (code: number) => {
    res.statusCode = code;
    return res as NextApiResponse;
  };
  res.json = (body: unknown) => {
    res.body = body;
    return res as NextApiResponse;
  };
  return res;
}

describe("regulations chat launch gate", () => {
  it("is closed while any golden case is pending review", () => {
    // The wedge set is pending attorney review today; the gate must be shut.
    expect(regulationsChatLaunched()).toBe(false);
    expect(allGoldenCasesApproved(GOLDEN_CASES)).toBe(false);
  });

  it("opens only when every case has a named reviewer and date", () => {
    const approved = GOLDEN_CASES.map((goldenCase) => ({
      ...goldenCase,
      review: {
        status: "approved" as const,
        reviewer: "J. Attorney, Food Law LLP",
        reviewedAt: "2026-11-07",
      },
    }));
    expect(allGoldenCasesApproved(approved)).toBe(true);
    // A single pending case — or an "approved" case with no reviewer — keeps
    // the gate shut: sign-off cannot be faked by flipping the status field.
    const onePending = approved.map((goldenCase, index) =>
      index === 0
        ? {
            ...goldenCase,
            review: {
              status: "pending_attorney_review" as const,
              reviewer: null,
              reviewedAt: null,
            },
          }
        : goldenCase
    );
    expect(allGoldenCasesApproved(onePending)).toBe(false);
    const unsigned = approved.map((goldenCase) => ({
      ...goldenCase,
      review: { ...goldenCase.review, reviewer: null },
    }));
    expect(allGoldenCasesApproved(unsigned)).toBe(false);
    expect(allGoldenCasesApproved([])).toBe(false);
  });

  it("the API route answers 404 while the gate is closed — no unreviewed answers served", async () => {
    const res = mockRes();
    await handler(
      { method: "POST", body: { message: "Can I sell jam in Colorado?" } } as NextApiRequest,
      res as NextApiResponse
    );
    expect(res.statusCode).toBe(404);
    // The gate sits before rate limiting and the answer path: nothing is
    // spent and no answer is produced for a closed feature.
    expect(mockApplyRateLimit).not.toHaveBeenCalled();
    expect(mockAnswer).not.toHaveBeenCalled();
  });
});
