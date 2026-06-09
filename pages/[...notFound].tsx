import type { GetServerSideProps } from "next";
import { buildAgentError } from "@/utils/api/agent-error";

// Site-wide content-negotiated 404. Next's pages router serves the static
// HTML 404 page for unmatched routes, which is invisible to agents that ask
// for machine-readable output. This root catch-all runs for any path that no
// more-specific route handled (specific + nested dynamic routes always win, so
// this only ever fires on a genuine 404). When the client does NOT want HTML
// (Accept has no text/html — i.e. an agent/CLI sending application/json, */*,
// markdown, etc.) we emit the SAME structured error shape as the /api catch-all
// so agents get a real 404 with discovery hints. Browsers (Accept: text/html)
// fall through to the normal pages/404.tsx UI.
export const getServerSideProps: GetServerSideProps = async ({
  req,
  res,
  resolvedUrl,
}) => {
  const accept = (req.headers.accept || "").toLowerCase();
  const wantsHtml = accept.includes("text/html");

  if (!wantsHtml) {
    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Vary", "Accept, User-Agent");
    res.write(
      JSON.stringify(
        buildAgentError({
          status: 404,
          error: "Not found",
          code: "not_found",
          message: `No page matches ${resolvedUrl}.`,
          path: resolvedUrl,
        })
      )
    );
    res.end();
    // Response already written; returning empty props keeps Next from trying
    // to render (it detects the finished response, same pattern as the
    // sitemap.xml / rss.xml page-router endpoints).
    return { props: {} };
  }

  // Human/browser request — render the standard HTML 404 page with a 404 status.
  return { notFound: true };
};

export default function NotFoundCatchAll() {
  return null;
}
