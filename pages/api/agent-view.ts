import type { NextApiRequest, NextApiResponse } from "next";
import { getPageContent } from "@/utils/geo/page-content";
import { applyRateLimit } from "@/utils/rate-limit";
import { sendAgentError } from "@/utils/api/agent-error";

const RATE_LIMIT = { limit: 600, windowMs: 60 * 1000 };

// Backing endpoint for content negotiation. `proxy.ts` rewrites requests for
// content pages here (preserving the original URL) when the client asks for a
// non-HTML representation via Accept header or a known LLM User-Agent, passing
// the original path/format through request headers. This route returns
// markdown, JSON, or plain text for the requested page.

function markdownToPlainText(markdown: string): string {
  return markdown
    .replace(/^#+\s+/gm, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .trim();
}

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader("Vary", "Accept, User-Agent");
  res.setHeader("Cache-Control", "public, max-age=3600, s-maxage=3600");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("X-Robots-Tag", "noindex");

  if (!applyRateLimit(req, res, "agent-view", RATE_LIMIT)) return;

  const headerPath = req.headers["x-agent-view-path"];
  const queryPath = Array.isArray(req.query.path)
    ? req.query.path[0]
    : req.query.path;
  const rawPath =
    (Array.isArray(headerPath) ? headerPath[0] : headerPath) || queryPath;

  const headerFormat = req.headers["x-agent-view-format"];
  const queryFormat = Array.isArray(req.query.format)
    ? req.query.format[0]
    : req.query.format;
  const format = ((Array.isArray(headerFormat)
    ? headerFormat[0]
    : headerFormat) || queryFormat) as "md" | "json" | "txt" | undefined;

  const path = rawPath || "/";
  const content = getPageContent(path);

  if (!content) {
    return sendAgentError(res, {
      status: 404,
      error: "Not found",
      code: "not_found",
      message: `No machine-readable representation for path "${path}".`,
      path,
    });
  }

  if (format === "json") {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(200).json({
      path,
      title: content.title,
      description: content.description,
      content: content.markdown,
      links: {
        html: `https://milk.market${path}`,
        llms: "https://milk.market/llms.txt",
        skill: "https://milk.market/skill.md",
      },
    });
  }

  if (format === "txt") {
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.status(200).send(markdownToPlainText(content.markdown));
  }

  // default: markdown
  res.setHeader("Content-Type", "text/markdown; charset=utf-8");
  return res.status(200).send(content.markdown);
}
