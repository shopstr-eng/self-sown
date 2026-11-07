import type { NextApiRequest, NextApiResponse } from "next";
import { applyRateLimit } from "@/utils/rate-limit";
import { answerRegulationQuestion, productionDeps } from "@/utils/regulations/chat";
import { regulationsChatLaunched } from "@/utils/regulations/golden-set";

// The wedge regulation chat. Unauthenticated (legal information is a public
// surface, like the buyer storefront chat) but IP-budgeted because answered
// questions can spend model tokens on the explanation pass.
const RATE_LIMIT = { limit: 30, windowMs: 60 * 60 * 1000 };
const MAX_MESSAGE_CHARS = 1_000;

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  // Launch gate (P0 trust layer): the chat serves nothing until every golden
  // case has documented attorney/FTCLDF sign-off — see
  // docs/regulations-attorney-review.md. 404, not 403: an unlaunched feature
  // is not there.
  if (!regulationsChatLaunched()) {
    return res.status(404).json({ error: "Not found" });
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!(await applyRateLimit(req, res, "regulations-chat", RATE_LIMIT))) {
    return;
  }

  const message = (req.body as { message?: unknown })?.message;
  if (typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "message is required" });
  }
  if (message.length > MAX_MESSAGE_CHARS) {
    return res.status(400).json({ error: "message is too long" });
  }

  try {
    // Awaited (not returned bare) so async throws stay inside this catch —
    // see the un-awaited-helper lesson in agent memory.
    const answer = await answerRegulationQuestion(
      message.trim(),
      productionDeps()
    );
    return res.status(200).json(answer);
  } catch (error) {
    // Store outages throw (null means genuinely-empty corpus). A 503 is
    // explicit; it must never masquerade as an "unknown" legal answer.
    console.error("[regulations] chat failed:", error);
    return res
      .status(503)
      .json({ error: "Regulation service is temporarily unavailable" });
  }
}
