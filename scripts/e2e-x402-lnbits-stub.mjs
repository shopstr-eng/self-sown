/**
 * x402 E2E staging stub: a minimal LNbits-compatible invoice node.
 *
 * Why this exists: the x402 seller-authority path (utils/x402/authority.ts)
 * points a Pro seller at their own LNbits instance over public https. To run
 * a true end-to-end x402 settlement test without real mainnet sats, this
 * stub plays the role of the seller's Lightning node:
 *
 *   - GET  /api/v1/wallet            -> key verification (authority save)
 *   - POST /api/v1/payments          -> create invoice: returns a real,
 *     authentically-signed bolt11 whose payment hash is
 *     sha256(preimage bytes) with the caller's description_hash embedded
 *     (spec-strict binding), signed by the stub's node key.
 *   - GET  /api/v1/payments/<hash>   -> LNbits payment status (unpaid until
 *     settled via the control endpoint, then paid + preimage revealed).
 *   - POST /control/settle {payment_hash} -> models a buyer's wallet paying
 *     the invoice over Lightning: marks it paid and returns the preimage.
 *
 * Invoices are standard-semantics (sha256 of raw preimage bytes), unlike the
 * staging Cashu FakeWallet mint, whose invoices can never pass standard
 * preimage validation.
 *
 * Env: STUB_PORT (default 3000), STUB_LNBITS_KEY (API key the stub accepts).
 * Run: node scripts/e2e-x402-lnbits-stub.mjs
 */
import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import bolt11 from "bolt11";

const PORT = Number(process.env.STUB_PORT || 3000);
const API_KEY = process.env.STUB_LNBITS_KEY || "x402-e2e-stub-key";
// Deterministic stub node key (never used for real funds; invoices are
// unpayable outside this staging arrangement because only this stub knows
// the preimages and reveals them via /control/settle).
const NODE_KEY = "01".repeat(32);

/** payment_hash -> { preimage, paid, invoice, amountSats, createdAt, expiry } */
const invoices = new Map();

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 64 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
}

function issueInvoice({ amountSats, descriptionHash, memo, expirySeconds }) {
  const preimage = randomBytes(32);
  const paymentHash = createHash("sha256").update(preimage).digest("hex");
  const tags = [
    { tagName: "payment_hash", data: paymentHash },
    { tagName: "payment_secret", data: randomBytes(32).toString("hex") },
  ];
  // A bolt11 carries either a description or a description hash (commitment);
  // with the x402 binding present we commit to the hash exactly like a real
  // LNbits node honoring the description_hash parameter.
  if (descriptionHash) {
    tags.push({ tagName: "purpose_commit_hash", data: descriptionHash });
  } else if (memo) {
    tags.push({ tagName: "description", data: memo });
  }
  if (expirySeconds) {
    tags.push({ tagName: "expire_time", data: expirySeconds });
  }
  // bolt11's runtime encoder accepts `coinType` ("bc" = mainnet) even though
  // its .d.ts only declares the structured `network` field.
  const encoded = bolt11.encode({
    coinType: "bc",
    millisatoshis: String(amountSats * 1000),
    timestamp: Math.floor(Date.now() / 1000),
    tags,
  });
  const signed = bolt11.sign(encoded, NODE_KEY);
  if (!signed.paymentRequest) {
    throw new Error("bolt11 sign did not produce a payment request");
  }
  return {
    invoice: signed.paymentRequest,
    paymentHash,
    preimage: preimage.toString("hex"),
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;

    if (req.method === "GET" && path === "/") {
      return json(res, 200, { ok: true, service: "x402-e2e-lnbits-stub" });
    }

    if (req.method === "POST" && path === "/control/settle") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const rec = invoices.get(body.payment_hash);
      if (!rec) return json(res, 404, { error: "unknown payment_hash" });
      rec.paid = true;
      return json(res, 200, {
        payment_hash: body.payment_hash,
        preimage: rec.preimage,
        invoice: rec.invoice,
      });
    }

    if (req.method === "GET" && path === "/control/invoices") {
      return json(
        res,
        200,
        Array.from(invoices.entries()).map(([hash, rec]) => ({
          payment_hash: hash,
          paid: rec.paid,
          amount_sats: rec.amountSats,
        }))
      );
    }

    // Everything below is the LNbits-compatible surface and requires the key.
    if (req.headers["x-api-key"] !== API_KEY) {
      return json(res, 401, { detail: "Invalid API key" });
    }

    if (req.method === "GET" && path === "/api/v1/wallet") {
      return json(res, 200, {
        id: "x402-e2e-stub-wallet",
        name: "x402 E2E staging stub",
        balance: 21_000_000_000,
      });
    }

    if (req.method === "POST" && path === "/api/v1/payments") {
      const body = JSON.parse((await readBody(req)) || "{}");
      if (body.out === true) {
        return json(res, 400, { detail: "stub only issues invoices" });
      }
      const amountSats = Number(body.amount);
      if (!Number.isInteger(amountSats) || amountSats <= 0) {
        return json(res, 400, { detail: "invalid amount" });
      }
      const expirySeconds =
        Number(body.expiry) > 0 ? Number(body.expiry) : 3600;
      const descriptionHash =
        typeof body.description_hash === "string" &&
        /^[0-9a-f]{64}$/i.test(body.description_hash)
          ? body.description_hash.toLowerCase()
          : null;
      const { invoice, paymentHash, preimage } = issueInvoice({
        amountSats,
        descriptionHash,
        memo: typeof body.memo === "string" ? body.memo : null,
        expirySeconds,
      });
      invoices.set(paymentHash, {
        preimage,
        paid: false,
        invoice,
        amountSats,
        createdAt: Date.now(),
        expirySeconds,
      });
      return json(res, 201, {
        payment_hash: paymentHash,
        payment_request: invoice,
      });
    }

    const statusMatch = path.match(/^\/api\/v1\/payments\/([0-9a-f]{64})$/i);
    if (req.method === "GET" && statusMatch) {
      const rec = invoices.get(statusMatch[1].toLowerCase());
      if (!rec) return json(res, 200, { paid: false });
      return json(res, 200, {
        paid: rec.paid,
        preimage: rec.paid ? rec.preimage : "0".repeat(64),
        details: { status: rec.paid ? "success" : "pending" },
      });
    }

    return json(res, 404, { detail: "not found" });
  } catch (error) {
    return json(res, 500, {
      detail: error instanceof Error ? error.message : "stub error",
    });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[x402-stub] LNbits stub listening on 0.0.0.0:${PORT}`);
});
