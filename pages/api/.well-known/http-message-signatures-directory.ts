import type { NextApiRequest, NextApiResponse } from "next";
import { applyRateLimit } from "@/utils/rate-limit";
import { sendAgentError } from "@/utils/api/agent-error";
import { getSignatureDirectory } from "@/utils/web-bot-auth/keys";

// Web Bot Auth signature directory. Publishes the platform's Ed25519 public
// verification key(s) as a JWK Set so agents/verifiers can discover Milk
// Market's signing identity (draft-meunier-http-message-signatures-directory).
//
// This is served at /.well-known/http-message-signatures-directory on BOTH the
// platform host and seller custom domains (proxy.ts rewrites it here before any
// host-specific routing), so the same canonical key directory is reachable
// wherever an agent is interacting.

const RATE_LIMIT = { limit: 600, windowMs: 60 * 1000 };

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  res.setHeader("Vary", "Accept");
  res.setHeader("Access-Control-Allow-Origin", "*");
  // Public, cacheable, and crawlable: this is meant to be discovered.
  res.setHeader("Cache-Control", "public, max-age=3600, s-maxage=3600");

  if (!applyRateLimit(req, res, "well-known-signatures", RATE_LIMIT)) return;

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    return sendAgentError(res, {
      status: 405,
      error: "Method not allowed",
      code: "method_not_allowed",
      message: "Use GET to retrieve the signature directory.",
      method: req.method,
    });
  }

  try {
    const directory = await getSignatureDirectory();
    // The IETF draft registers `application/http-message-signatures-directory`
    // for this document, and spec-aware verifiers (Cloudflare et al.) request it
    // via Accept or */*. But many generic agents/scanners only parse a body when
    // the Content-Type literally contains `application/json` — the `+json`
    // suffix alone isn't enough for them, so they fetch the directory, see an
    // unrecognized type, and report the keys as "not discoverable". When the
    // caller explicitly asks for application/json, answer in kind so the JWK Set
    // is parseable everywhere; otherwise serve the registered media type.
    const accept = (req.headers.accept || "").toLowerCase();
    const wantsPlainJson =
      accept.includes("application/json") &&
      !accept.includes("application/http-message-signatures-directory");
    // Use res.send (not res.json) so the chosen media type isn't overwritten.
    res.setHeader(
      "Content-Type",
      wantsPlainJson
        ? "application/json; charset=utf-8"
        : "application/http-message-signatures-directory+json; charset=utf-8"
    );
    return res.status(200).send(JSON.stringify(directory));
  } catch (error) {
    console.error("http-message-signatures-directory failed:", error);
    return sendAgentError(res, {
      status: 500,
      error: "Failed to build signature directory",
      code: "signature_directory_error",
      details: error instanceof Error ? error.message : "Unknown error",
    });
  }
}
