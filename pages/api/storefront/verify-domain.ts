import type { NextApiRequest, NextApiResponse } from "next";
import { applyRateLimit } from "@/utils/rate-limit";
import { getDomainByPubkey, markVerified } from "@/utils/db/custom-domains";
import {
  PRIMARY_HOST,
  VALID_CNAME_TARGETS,
  checkWwwVariantHealth,
  type WwwHealth,
} from "@/utils/custom-domain-www-health";
import { checkDomainDns } from "@/utils/custom-domain-lifecycle";

const RATE_LIMIT = { limit: 30, windowMs: 60 * 1000 };

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (!(await applyRateLimit(req, res, "verify-domain", RATE_LIMIT))) return;

  const { pubkey } = req.body ?? {};
  if (!pubkey) {
    return res.status(400).json({ error: "pubkey is required" });
  }

  try {
    const row = await getDomainByPubkey(pubkey);
    if (!row) {
      return res.status(404).json({ error: "No custom domain found" });
    }

    const domain = row.domain;
    const expectedToken = row.verification_token;

    // Shared DNS check (also used by the automatic lifecycle advancer) so
    // the verify button and the background transition can never disagree
    // about what "verified" means.
    const dnsCheck = await checkDomainDns(domain, expectedToken);
    const { observed, txtMatch, verified } = dnsCheck;
    const dnsTargetMatch = dnsCheck.dnsTargetMatch;

    // www variant health (advisory — never blocks apex verification). The
    // platform 301s www.<domain> → <domain>, but only if the seller's DNS
    // has a www record pointing at us AND the deployment terminates TLS for
    // it. Checking here so the dashboard can be LOUD about a www dead end
    // instead of letting buyers hit a browser DNS/TLS error. Only meaningful
    // for apex domains — nobody types www.shop.example.com.
    // Shared health check (DNS first, TLS probe only once DNS points at us)
    // so the seller dashboard and the admin panel report the same www state.
    const www: WwwHealth | null = await checkWwwVariantHealth(domain);

    if (verified) {
      await markVerified(pubkey);
      // Deliberately NO Square Apple Pay activation here: DNS verification
      // fires while the domain may still be awaiting TLS attachment, and
      // Square requires a live HTTPS domain serving the association file.
      // The pre-SDK seller-status checkout route activates instead — it runs
      // exactly when the domain is live and about to take payment.
    }

    let message = "";
    if (verified) {
      message =
        "Domain verified! An admin will attach it to the deployment shortly to provision your TLS certificate.";
      if (www && !www.resolves) {
        message += ` Note: no www record found for www.${domain} — add a CNAME for "www" pointing to ${VALID_CNAME_TARGETS[0]} so buyers typing the www address don't hit a browser error.`;
      } else if (www && www.tlsOk === false && www.tlsReason === "certificate") {
        message += ` Note: www.${domain} points to us, but https://www.${domain} has no valid certificate yet — the www variant still needs to be attached under Publishing → Domains (an admin does this).`;
      }
    } else if (!dnsTargetMatch && !txtMatch) {
      message =
        "Neither the DNS target record nor the TXT verification record was found. DNS changes can take up to 48h to propagate.";
    } else if (!dnsTargetMatch) {
      message = `TXT verification succeeded, but no CNAME pointing to ${VALID_CNAME_TARGETS[0]} (or A record matching ${PRIMARY_HOST}) was found.`;
    } else {
      message = `DNS target verified, but the TXT record at _self-sown.${domain} doesn't match. Make sure the value is exactly: ${expectedToken}`;
    }

    return res.status(200).json({
      domain,
      verified,
      tlsStatus: verified ? "dns_verified" : row.tls_status,
      observed,
      www,
      expected: {
        cnameAnyOf: VALID_CNAME_TARGETS,
        txt: expectedToken
          ? { host: `_self-sown.${domain}`, value: expectedToken }
          : null,
      },
      message,
    });
  } catch (error) {
    console.error("Domain verification error:", error);
    return res.status(500).json({ error: "Verification failed" });
  }
}
