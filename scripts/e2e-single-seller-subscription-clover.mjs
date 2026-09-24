/**
 * E2E staging verification (#453): the single-seller recurring checkout route
 * (/api/stripe/create-subscription) must return a usable card-form
 * clientSecret on apiVersion 2025-09-30.clover.
 *
 * Clover (Basil family) removed Invoice.payment_intent, so the route's
 * expand:["latest_invoice.payment_intent"] silently yields nothing. The
 * route must resolve the first-payment PaymentIntent via the invoice's
 * invoicePayments instead — this harness exercises the REAL Stripe test API
 * (no mocks) and fails if clientSecret comes back null (the regression: the
 * buyer's card form never renders).
 *
 * The checkout runs against the PLATFORM seller (NEXT_PUBLIC_SELF_SOWN_PK):
 * this Stripe test account cannot onboard charges-enabled connected accounts
 * (custom accounts are blocked on the Connect platform profile; the reusable
 * express accounts are transfers-only), and the PaymentIntent resolution
 * under test is identical on both paths. The connected-account stripeAccount
 * threading is pinned by unit tests instead.
 *
 * Prerequisites: a server instance of THIS build running with test-mode
 * Stripe keys (the main dev workflow keeps its live keys untouched):
 *
 *   PORT=3001 HOSTNAME=127.0.0.1 \
 *     STRIPE_SECRET_KEY="$STRIPE_TEST_SECRET_KEY" \
 *     node .next/standalone/server.js
 *
 * Then:
 *
 *   STRIPE_TEST_SECRET_KEY=sk_test_... BASE_URL=http://127.0.0.1:3001 \
 *     node scripts/e2e-single-seller-subscription-clover.mjs
 *
 * The harness REFUSES to run with a live-mode key. It writes one synthetic
 * subscription row into DATABASE_URL and deletes it in cleanup, pass or fail.
 */
import { createHash } from "node:crypto";
import Stripe from "stripe";
import pg from "pg";

const SECRET = process.env.STRIPE_TEST_SECRET_KEY || "";
if (!SECRET.startsWith("sk_test")) {
  console.error(
    "REFUSING TO RUN: STRIPE_TEST_SECRET_KEY must be a test-mode key (sk_test_...)."
  );
  process.exit(2);
}
const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:3001";
const PLATFORM_PK = process.env.NEXT_PUBLIC_SELF_SOWN_PK || "";
if (!/^[0-9a-f]{64}$/.test(PLATFORM_PK)) {
  console.error(
    "REFUSING TO RUN: NEXT_PUBLIC_SELF_SOWN_PK (platform seller pubkey) is required."
  );
  process.exit(2);
}

const stripe = new Stripe(SECRET, { apiVersion: "2025-09-30.clover" });
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });

const pk = (label) => createHash("sha256").update(label).digest("hex");
const BUYER = pk("e2e-single-sub-buyer-v1");
const RUN = Date.now().toString(36);
const EMAIL = `e2e-single-sub-${RUN}@staging-fixture.invalid`;
// The client sends DOLLARS (major units); the server converts to cents.
const AMOUNT = 12;

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`
  );
  if (!ok) process.exitCode = 1;
};

const cleanup = { subscriptionId: "", customerId: "" };

async function main() {
  await db.connect();
  console.log(
    `run id: ${RUN}  platform seller: ${PLATFORM_PK.slice(0, 12)}...`
  );

  // --- 1. Single-seller recurring checkout ------------------------------
  const resp = await fetch(`${BASE_URL}/api/stripe/create-subscription`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      customerEmail: EMAIL,
      buyerPubkey: BUYER,
      productTitle: "E2E Single-Seller Monthly Box",
      productEventId: pk("e2e-single-sub-product-v1"),
      amount: AMOUNT,
      currency: "USD",
      quantity: 1,
      frequency: "monthly",
      sellerPubkey: PLATFORM_PK,
    }),
  });
  const body = await resp.json();
  check(
    "single-seller subscription created (no 400)",
    resp.status === 200 && body.success === true,
    `status=${resp.status} sub=${body.subscriptionId || ""} err=${body.error || ""}`
  );
  if (!body.success) throw new Error("subscription creation failed; aborting");
  cleanup.subscriptionId = body.subscriptionId;
  cleanup.customerId = body.customerId;

  // --- 2. The #453 regression pin ---------------------------------------
  // On clover the Invoice object has no top-level payment_intent; the route
  // must resolve the PI via the invoice's invoicePayments and return a
  // usable clientSecret, or the buyer-facing card form never renders.
  check(
    "create-subscription returns a card-form clientSecret on clover",
    typeof body.clientSecret === "string" && body.clientSecret.length > 0,
    body.clientSecret ? "present" : "NULL (regression: card form never renders)"
  );
  if (!body.clientSecret) throw new Error("clientSecret null; aborting");

  // --- 3. Prove the secret actually pays the first invoice --------------
  const sub = await stripe.subscriptions.retrieve(body.subscriptionId);
  const invoiceId =
    typeof sub.latest_invoice === "string"
      ? sub.latest_invoice
      : sub.latest_invoice?.id;
  check(
    "clover invoice carries no top-level payment_intent (drift reproduced)",
    !!invoiceId && !(sub.latest_invoice || {}).payment_intent,
    `invoice=${invoiceId || ""}`
  );
  const invPayments = await stripe.invoicePayments.list({
    invoice: invoiceId,
    limit: 10,
  });
  const piId = invPayments.data
    .map((p) => p.payment?.payment_intent)
    .find((id) => typeof id === "string");
  if (!piId) throw new Error("no payment intent found on first invoice");
  check(
    "returned clientSecret matches the invoice's PaymentIntent",
    body.clientSecret.startsWith(`${piId}_secret_`),
    `pi=${piId}`
  );
  // tok_bypassPending: raw card-number APIs are disabled on this key.
  const pm = await stripe.paymentMethods.create({
    type: "card",
    card: { token: "tok_bypassPending" },
  });
  await stripe.paymentMethods.attach(pm.id, { customer: body.customerId });
  const confirmed = await stripe.paymentIntents.confirm(piId, {
    payment_method: pm.id,
  });
  check(
    "first invoice payment succeeded via the returned secret's PI",
    confirmed.status === "succeeded",
    `pi=${confirmed.status}`
  );
}

async function teardown() {
  console.log("--- cleanup ---");
  try {
    if (cleanup.subscriptionId)
      await stripe.subscriptions
        .cancel(cleanup.subscriptionId)
        .catch((e) => console.warn("cancel sub:", e.message));
    if (cleanup.customerId)
      await stripe.customers
        .del(cleanup.customerId)
        .catch((e) => console.warn("del customer:", e.message));
  } catch (e) {
    console.warn("stripe cleanup:", e.message);
  }
  try {
    if (cleanup.subscriptionId)
      await db.query(
        `DELETE FROM subscriptions WHERE stripe_subscription_id = $1`,
        [cleanup.subscriptionId]
      );
  } catch (e) {
    console.warn("db cleanup:", e.message);
  }
  await db.end().catch(() => {});
}

main()
  .catch((e) => {
    console.error("HARNESS ERROR:", e.stack || e.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await teardown();
    const failed = results.filter((r) => !r.ok).length;
    console.log(
      `--- ${results.length - failed}/${results.length} checks passed ---`
    );
  });
