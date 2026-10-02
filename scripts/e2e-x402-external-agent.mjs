/**
 * x402 E2E external agent: drives the full discovery -> challenge -> pay ->
 * settle flow against a LIVE deployment of the app over public https, using
 * only the documented x402 v2 interfaces (no app internals).
 *
 * Legs:
 *   0. Discovery: GET /.well-known/x402.json, validate it parses and declares
 *      the v2 exact/lnbtc contract (headers, network, createOrder endpoint).
 *   A. x402 preimage settlement:
 *      1. POST /api/mcp/create-order (paymentMethod lightning) -> expect 402,
 *         decode the PAYMENT-REQUIRED header, validate the challenge against
 *         the discovery doc and the invoice terms.
 *      2. Pay the invoice (the seller's node is the staging stub; settling it
 *         reveals the preimage, exactly what a paying Lightning wallet learns).
 *      3. Retry the identical request with a PAYMENT-SIGNATURE header ->
 *         expect 200, status paid, settled receipt + PAYMENT-RESPONSE header.
 *      4. Replay the same retry -> must stay settled exactly once.
 *      5. POST /api/mcp/verify-payment -> already-paid view.
 *   B. Polling settlement (comparison baseline): second order, pay it, then
 *      POST /api/mcp/verify-payment polls the seller's node and settles.
 *   C. Seller views: both orders must appear to the seller paid and
 *      indistinguishable except the payment reference (GET
 *      /api/mcp/create-order?orderId= and the MCP get_notifications tool).
 *
 * Input: /tmp/x402-e2e-context.json written by e2e-x402-staging-setup.mjs.
 * Exit code 0 on full pass, 1 on any failed check.
 */
import fs from "node:fs";

const ctx = JSON.parse(fs.readFileSync("/tmp/x402-e2e-context.json", "utf8"));
const BASE = ctx.baseUrl.replace(/\/+$/, "");
const LNBTC_NETWORK = "lnbtc:000000000019d6689c085ae165831e93";

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`  PASS ${label}`);
  } else {
    failures += 1;
    console.log(
      `  FAIL ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`
    );
  }
}

function b64decodeJson(value) {
  // Spec: base64; base64url tolerated on decode.
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
}
function b64encodeJson(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

function decodeBolt11AmountMsat(invoice) {
  // lnbc<amount><multiplier>... — enough to cross-check the challenge amount.
  const m = invoice.match(/^lnbc(\d+)([munp]?)/i);
  if (!m) return null;
  const value = BigInt(m[1]);
  const mult = m[2].toLowerCase();
  const factor =
    mult === "m"
      ? 100_000_000n
      : mult === "u"
        ? 100_000n
        : mult === "n"
          ? 100n
          : mult === "p"
            ? 1n / 10n
            : 100_000_000_000n;
  return value * factor;
}

async function createOrder() {
  return fetch(`${BASE}/api/mcp/create-order`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${ctx.buyerApiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      productId: ctx.productId,
      quantity: 1,
      paymentMethod: "lightning",
      shippingAddress: {
        name: "External Agent",
        address: "1 Protocol Way",
        city: "Cypherpunk",
        postalCode: "00000",
        stateProvince: "NA",
        country: "United States of America",
      },
    }),
  });
}

async function payInvoice(invoice, paymentHash) {
  // Paying a real invoice means a Lightning wallet settles it and learns the
  // preimage. The seller's node here is the staging stub, so settling through
  // it plays the same role with no real sats at risk.
  const res = await fetch(`${ctx.stubBase}/control/settle`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ payment_hash: paymentHash }),
  });
  const data = await res.json();
  if (!res.ok || !data.preimage) {
    throw new Error(`payment failed: HTTP ${res.status} ${JSON.stringify(data)}`);
  }
  if (data.invoice !== invoice) {
    throw new Error("stub settled a different invoice than challenged");
  }
  return data.preimage.toLowerCase();
}

function settleWithPreimage(accepted, preimage) {
  return fetch(`${BASE}/api/mcp/create-order`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${ctx.buyerApiKey}`,
      "content-type": "application/json",
      "payment-signature": b64encodeJson({
        x402Version: 2,
        accepted,
        payload: { preimage },
      }),
    },
    body: JSON.stringify({
      productId: ctx.productId,
      quantity: 1,
      paymentMethod: "lightning",
      shippingAddress: {
        name: "External Agent",
        address: "1 Protocol Way",
        city: "Cypherpunk",
        postalCode: "00000",
        stateProvince: "NA",
        country: "United States of America",
      },
    }),
  });
}

// --- Leg 0: discovery -------------------------------------------------------
console.log(`\n== Leg 0: discovery document (${BASE}) ==`);
const docRes = await fetch(`${BASE}/.well-known/x402.json`);
check("GET /.well-known/x402.json returns 200", docRes.status === 200, docRes.status);
const doc = await docRes.json();
check("version is 2", doc.version === 2, doc.version);
check("scheme is exact", doc.scheme === "exact", doc.scheme);
check("network is lnbtc mainnet", doc.network === LNBTC_NETWORK, doc.network);
check("asset is BTC", doc.asset === "BTC", doc.asset);
check(
  "challenge header is PAYMENT-REQUIRED",
  doc.headers?.challenge === "PAYMENT-REQUIRED",
  doc.headers
);
check(
  "payment header is PAYMENT-SIGNATURE",
  doc.headers?.payment === "PAYMENT-SIGNATURE"
);
check(
  "settlement header is PAYMENT-RESPONSE",
  doc.headers?.settlement === "PAYMENT-RESPONSE"
);
check(
  "createOrder endpoint documented",
  doc.endpoints?.createOrder?.method === "POST" &&
    doc.endpoints.createOrder.url.endsWith("/api/mcp/create-order"),
  doc.endpoints?.createOrder
);

// --- Leg A: x402 preimage settlement ---------------------------------------
console.log("\n== Leg A: 402 challenge ==");
const challengeRes = await createOrder();
check("create-order returns 402", challengeRes.status === 402, challengeRes.status);
const wwwAuth = challengeRes.headers.get("www-authenticate") || "";
check(
  "WWW-Authenticate carries the L402 challenge",
  /^L402 macaroon="[^"]+", invoice="lnbc/i.test(wwwAuth),
  wwwAuth.slice(0, 60)
);
const prHeader = challengeRes.headers.get("payment-required");
check("PAYMENT-REQUIRED header present", typeof prHeader === "string" && prHeader.length > 0);
const challenge = prHeader ? b64decodeJson(prHeader) : null;
const challengeBody = await challengeRes.json();
check(
  "body mirrors the same x402 challenge",
  JSON.stringify(challengeBody?.x402) === JSON.stringify(challenge)
);
check("challenge x402Version is 2", challenge?.x402Version === 2, challenge?.x402Version);
const accepted = challenge?.accepts?.[0];
check("exactly one accepts entry", challenge?.accepts?.length === 1, challenge?.accepts?.length);
check("scheme is exact", accepted?.scheme === "exact", accepted?.scheme);
check("network is lnbtc mainnet", accepted?.network === LNBTC_NETWORK, accepted?.network);
check("asset is BTC", accepted?.asset === "BTC", accepted?.asset);
check(
  "payTo is a compressed node pubkey",
  typeof accepted?.payTo === "string" && /^0[23][0-9a-f]{64}$/i.test(accepted.payTo),
  accepted?.payTo
);
const invoice = accepted?.extra?.invoice;
check("invoice present in extra", typeof invoice === "string" && invoice.startsWith("lnbc"));
check(
  "requestHash present and well-formed",
  typeof accepted?.extra?.requestHash === "string" &&
    /^[0-9a-f]{64}$/.test(accepted.extra.requestHash)
);
check(
  "binding profile is http:1 with documented bound headers",
  accepted?.extra?.requestBindingProfile === "http:1" &&
    JSON.stringify(accepted.extra.requestBindingParams?.headers) ===
      JSON.stringify(["authorization", "content-type"]),
  accepted?.extra?.requestBindingProfile
);
const amountMsat = invoice ? decodeBolt11AmountMsat(invoice) : null;
check(
  "challenge amount matches invoice amount",
  amountMsat !== null && accepted?.amount === amountMsat.toString(),
  { challengeAmount: accepted?.amount, invoiceMsat: amountMsat?.toString() }
);
check(
  "resource URL identifies the create-order endpoint",
  challenge?.resource?.url?.endsWith("/api/mcp/create-order"),
  challenge?.resource?.url
);
const orderId = challengeBody?.order?.orderId ?? challengeBody?.orderId;
check("order id present in challenge body", typeof orderId === "string" && orderId.length > 0);
// For seller-authority (LNbits) invoices the challenge body's payment.quoteId
// is the authority's payment hash — the key the seller's node settles by.
const authorityPaymentHash = challengeBody?.payment?.quoteId;
check(
  "authority payment hash present (quoteId)",
  typeof authorityPaymentHash === "string" && /^[0-9a-f]{64}$/.test(authorityPaymentHash),
  challengeBody?.payment?.quoteId
);

console.log("\n== Leg A: pay the invoice ==");
const preimage = await payInvoice(invoice, authorityPaymentHash);
check("preimage learned from settlement", /^[0-9a-f]{64}$/.test(preimage));

console.log("\n== Leg A: paid retry with PAYMENT-SIGNATURE ==");
const settledRes = await settleWithPreimage(accepted, preimage);
const payRespHeader = settledRes.headers.get("payment-response");
const settledBody = await settledRes.json();
check("settlement returns 200", settledRes.status === 200, { status: settledRes.status, body: settledBody });
check("order is paid", settledBody?.success === true && settledBody?.status === "paid", settledBody?.status);
check("same order id settled", settledBody?.orderId === orderId, settledBody?.orderId);
check(
  "x402 settled receipt in body",
  settledBody?.x402?.settled === true &&
    settledBody?.x402?.network === LNBTC_NETWORK &&
    /^[0-9a-f]{64}$/.test(settledBody?.x402?.transaction ?? ""),
  settledBody?.x402
);
check("PAYMENT-RESPONSE header present", typeof payRespHeader === "string" && payRespHeader.length > 0);
const receipt = payRespHeader ? b64decodeJson(payRespHeader) : null;
check(
  "PAYMENT-RESPONSE receipt is a success on the lnbtc network",
  receipt?.success === true && receipt?.network === LNBTC_NETWORK,
  receipt
);
check(
  "receipt transaction matches body receipt",
  receipt?.transaction === settledBody?.x402?.transaction
);

console.log("\n== Leg A: replay the same preimage ==");
const replayRes = await settleWithPreimage(accepted, preimage);
const replayBody = await replayRes.json();
check("replay returns 200 (idempotent)", replayRes.status === 200, replayRes.status);
check("replay still reports the same paid order", replayBody?.orderId === orderId && replayBody?.status === "paid", replayBody);

console.log("\n== Leg A: verify-payment fallback view ==");
const verifyRes = await fetch(`${BASE}/api/mcp/verify-payment`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${ctx.buyerApiKey}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({ orderId }),
});
const verifyBody = await verifyRes.json();
check("verify-payment returns 200 paid", verifyRes.status === 200 && verifyBody?.status === "paid", verifyBody);

// --- Leg B: polling settlement baseline -------------------------------------
console.log("\n== Leg B: polling-settled order (baseline for view comparison) ==");
const challengeResB = await createOrder();
const challengeBodyB = await challengeResB.json();
check("second order also 402s", challengeResB.status === 402, challengeResB.status);
const orderIdB = challengeBodyB?.order?.orderId ?? challengeBodyB?.orderId;
const invoiceB = challengeBodyB?.x402?.accepts?.[0]?.extra?.invoice;
const phB = challengeBodyB?.payment?.quoteId;
await payInvoice(invoiceB, phB);
const verifyResB = await fetch(`${BASE}/api/mcp/verify-payment`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${ctx.buyerApiKey}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({ orderId: orderIdB }),
});
const verifyBodyB = await verifyResB.json();
check(
  "polling path settles the second order",
  verifyResB.status === 200 && verifyBodyB?.status === "paid",
  verifyBodyB
);
check(
  "polling path reports the settled preimage from the seller node",
  typeof verifyBodyB?.payment?.preimage === "string" &&
    /^[0-9a-f]{64}$/.test(verifyBodyB.payment.preimage),
  verifyBodyB?.payment
);

// --- Leg C: seller views ----------------------------------------------------
console.log("\n== Leg C: seller order views ==");
async function sellerGetOrder(id) {
  const res = await fetch(
    `${BASE}/api/mcp/create-order?orderId=${encodeURIComponent(id)}`,
    { headers: { authorization: `Bearer ${ctx.sellerApiKey}` } }
  );
  return { status: res.status, body: await res.json().catch(() => null) };
}
const sellerViewA = await sellerGetOrder(orderId);
const sellerViewB = await sellerGetOrder(orderIdB);
check(
  "seller can read the x402-settled order",
  sellerViewA.status === 200,
  sellerViewA
);
check(
  "seller can read the polling-settled order",
  sellerViewB.status === 200,
  sellerViewB
);
const orderViewA = sellerViewA.body?.order ?? sellerViewA.body;
const orderViewB = sellerViewB.body?.order ?? sellerViewB.body;
console.log("  x402 order view:    ", JSON.stringify(orderViewA));
console.log("  polling order view: ", JSON.stringify(orderViewB));
check(
  "both orders read paid to the seller",
  orderViewA?.paymentStatus === "paid" && orderViewB?.paymentStatus === "paid",
  { a: orderViewA?.paymentStatus, b: orderViewB?.paymentStatus }
);
check(
  "seller-facing fields are identical in shape",
  JSON.stringify(Object.keys(orderViewA ?? {}).sort()) ===
    JSON.stringify(Object.keys(orderViewB ?? {}).sort())
);
check(
  "amounts/currency/title match across both settlement paths",
  orderViewA?.amountTotal === orderViewB?.amountTotal &&
    orderViewA?.currency === orderViewB?.currency &&
    orderViewA?.productTitle === orderViewB?.productTitle
);

// The MCP endpoint is session-based: initialize first, then call tools with
// the assigned mcp-session-id.
const mcpHeaders = {
  authorization: `Bearer ${ctx.sellerApiKey}`,
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};
const initRes = await fetch(`${BASE}/api/mcp`, {
  method: "POST",
  headers: mcpHeaders,
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "x402-e2e-external-agent", version: "1.0.0" },
    },
  }),
});
const sessionId = initRes.headers.get("mcp-session-id");
check("seller MCP initialize returns a session", initRes.status === 200 && !!sessionId, initRes.status);
let mcpText = "";
if (sessionId) {
  await fetch(`${BASE}/api/mcp`, {
    method: "POST",
    headers: { ...mcpHeaders, "mcp-session-id": sessionId },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }),
  });
  const mcpRes = await fetch(`${BASE}/api/mcp`, {
    method: "POST",
    headers: { ...mcpHeaders, "mcp-session-id": sessionId },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "get_notifications", arguments: { orderLimit: 25 } },
    }),
  });
  mcpText = await mcpRes.text();
  check("seller MCP get_notifications returns 200", mcpRes.status === 200, mcpRes.status);
}
const sellerOrdersBlock = mcpText.includes(orderId) && mcpText.includes(orderIdB);
check(
  "seller MCP activity feed lists both settled orders",
  sellerOrdersBlock
);

console.log(
  failures === 0
    ? "\nALL CHECKS PASSED"
    : `\n${failures} CHECK(S) FAILED`
);
process.exit(failures === 0 ? 0 : 1);
