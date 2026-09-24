/**
 * E2E staging verification: a real two-seller recurring cart charges once and
 * pays both sellers.
 *
 * Exercises the REAL Stripe test-mode API end to end (no mocks):
 *   cart checkout -> subscription creation with compact metadata -> first
 *   invoice.paid webhook -> one transfer per seller -> simulated renewal via
 *   a Stripe test clock -> splits resolved from the stored record again.
 *
 * Prerequisites:
 *   1. A server instance of THIS build running with test-mode Stripe keys:
 *
 *        TEST_WHSEC="whsec_$(openssl rand -hex 24)"
 *        PORT=3001 HOSTNAME=127.0.0.1 \
 *          STRIPE_SECRET_KEY="$STRIPE_TEST_SECRET_KEY" \
 *          STRIPE_WEBHOOK_SECRET="$TEST_WHSEC" \
 *          STRIPE_WEBHOOK_CONNECT_SECRET="" \
 *          node .next/standalone/server.js
 *
 *      (run prepare-standalone.mjs first if the bundle was never served).
 *      The main dev workflow keeps its live keys untouched on port 5000.
 *
 *   2. Run this harness:
 *
 *        STRIPE_TEST_SECRET_KEY=sk_test_... \
 *        TEST_WEBHOOK_SECRET="$TEST_WHSEC" \
 *        BASE_URL=http://127.0.0.1:3001 \
 *          node scripts/e2e-multi-seller-subscription.mjs
 *
 * The harness REFUSES to run with a live-mode key. It writes synthetic rows
 * (two fake seller pubkeys + their Connect rows, the pending split record,
 * subscription rows, payout claims) into DATABASE_URL and deletes them all
 * in cleanup, pass or fail. Webhook events are the REAL event payloads
 * fetched from Stripe's API, re-signed with the test instance's throwaway
 * signing secret and POSTed through the actual /api/stripe/webhook route —
 * this exercises signature verification + the full handler; only Stripe's
 * own HTTP delivery is bypassed (no test-mode endpoint points at staging).
 *
 * Buyer card: 4000 0000 0000 0077 — succeeds AND lands directly in the
 * platform's available balance, so seller transfers can fund immediately.
 */
import { createHash, createHmac, randomUUID } from "node:crypto";
import Stripe from "stripe";
import pg from "pg";

const SECRET = process.env.STRIPE_TEST_SECRET_KEY || "";
if (!SECRET.startsWith("sk_test")) {
  console.error(
    "REFUSING TO RUN: STRIPE_TEST_SECRET_KEY must be a test-mode key (sk_test_...)."
  );
  process.exit(2);
}
const WHSEC = process.env.TEST_WEBHOOK_SECRET || "";
if (!WHSEC.startsWith("whsec_")) {
  console.error(
    "REFUSING TO RUN: TEST_WEBHOOK_SECRET (whsec_...) is required."
  );
  process.exit(2);
}
const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:3001";

const stripe = new Stripe(SECRET, { apiVersion: "2025-09-30.clover" });
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });

const pk = (label) => createHash("sha256").update(label).digest("hex");
const SELLER_A = pk("e2e-cart-sub-seller-a-v1");
const SELLER_B = pk("e2e-cart-sub-seller-b-v1");
const BUYER = pk("e2e-cart-sub-buyer-v1");
const RUN = Date.now().toString(36);
const EMAIL = `e2e-cart-sub-${RUN}@staging-fixture.invalid`;
// The client sends DOLLARS (major units); the server converts to smallest
// unit. Assertions below compare in cents.
const AMOUNT_A = 12; // $12.00
const AMOUNT_B = 25; // $25.00
const CENTS_A = 1200;
const CENTS_B = 2500;

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`
  );
  if (!ok) process.exitCode = 1;
};

const cleanup = {
  accountIds: [],
  eventIds: [],
  invoiceIds: [],
  transferGroup: "",
  subscriptionId: "",
  customerId: "",
  clockId: "",
};

async function dbQuery(text, params) {
  return db.query(text, params);
}

async function createTestConnectAccount(label) {
  // Custom account with full US test identity + bank data activates the
  // transfers/card_payments capabilities immediately in test mode.
  const account = await stripe.accounts.create({
    type: "custom",
    country: "US",
    email: `${label}-${RUN}@staging-fixture.example.com`,
    business_type: "individual",
    capabilities: {
      card_payments: { requested: true },
      transfers: { requested: true },
    },
    individual: {
      first_name: "E2E",
      last_name: "Fixture",
      email: `${label}-${RUN}@staging-fixture.example.com`,
      phone: "0000000000",
      dob: { day: 1, month: 1, year: 1901 },
      address: {
        line1: "address_full_match",
        city: "San Francisco",
        state: "CA",
        postal_code: "94111",
        country: "US",
      },
      ssn_last_4: "0000",
      id_number: "222222222",
    },
    business_profile: { mcc: "5734", url: "https://example.com" },
    tos_acceptance: { date: Math.floor(Date.now() / 1000), ip: "127.0.0.1" },
    external_account: {
      object: "bank_account",
      country: "US",
      currency: "usd",
      routing_number: "110000000",
      account_number: "000123456789",
    },
  });
  const fresh = await stripe.accounts.retrieve(account.id);
  if (
    fresh.capabilities?.transfers !== "active" ||
    fresh.capabilities?.card_payments !== "active"
  ) {
    throw new Error(
      `Test connected account ${account.id} capabilities not active: ${JSON.stringify(
        fresh.capabilities
      )}`
    );
  }
  return account.id;
}

async function deliverInvoicePaidEvent(invoiceId, sinceTs) {
  // Find the REAL event Stripe generated for this invoice and re-deliver it
  // through the actual webhook route, signed with the test instance's secret.
  let event = null;
  for (let i = 0; i < 20 && !event; i++) {
    const list = await stripe.events.list({
      types: ["invoice.paid"],
      created: { gte: sinceTs - 300 },
      limit: 100,
    });
    event = list.data.find((e) => e.data?.object?.id === invoiceId) || null;
    if (!event) await new Promise((r) => setTimeout(r, 1500));
  }
  if (!event) throw new Error(`No invoice.paid event found for ${invoiceId}`);
  cleanup.eventIds.push(event.id);

  // Shape normalization: the harness fetches events with the clover-pinned
  // SDK, where Basil removed invoice.subscription/payment_intent from the
  // Invoice object (now parent.subscription_details / invoicePayments). The
  // production webhook endpoints are pinned to "account default" (pre-Basil
  // for this account generation), whose payloads still carry both fields —
  // and the webhook handler keys off them. Copy them up so the delivered
  // payload matches what production receives today. (The clover-shape drift
  // this papers over is a documented finding + follow-up task.)
  const obj = event.data?.object;
  if (obj && typeof obj === "object") {
    if (!obj.subscription && obj.parent?.subscription_details?.subscription) {
      const s = obj.parent.subscription_details.subscription;
      obj.subscription = typeof s === "string" ? s : s?.id;
    }
    if (!obj.payment_intent) {
      const pays = await stripe.invoicePayments.list({
        invoice: invoiceId,
        limit: 5,
      });
      const pi = pays.data
        .map((p) => p.payment?.payment_intent)
        .find((id) => typeof id === "string");
      if (pi) obj.payment_intent = pi;
    }
  }

  const payload = JSON.stringify(event);
  const ts = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", WHSEC)
    .update(`${ts}.${payload}`, "utf8")
    .digest("hex");
  const resp = await fetch(`${BASE_URL}/api/stripe/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "stripe-signature": `t=${ts},v1=${sig}`,
    },
    body: payload,
  });
  const body = await resp.text();
  return { status: resp.status, body, eventId: event.id };
}

async function transfersByInvoice(transferGroup) {
  const out = new Map(); // invoiceId -> [{amount, destination, seller}]
  let startingAfter;
  for (;;) {
    const page = await stripe.transfers.list({
      transfer_group: transferGroup,
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    for (const t of page.data) {
      const inv = t.metadata?.invoiceId || "";
      if (!out.has(inv)) out.set(inv, []);
      out.get(inv).push({
        amount: t.amount,
        destination: t.destination,
        seller: t.metadata?.sellerPubkey || "",
      });
    }
    if (!page.has_more) break;
    startingAfter = page.data[page.data.length - 1].id;
  }
  return out;
}

async function main() {
  const startTs = Math.floor(Date.now() / 1000);
  await db.connect();
  console.log(`run id: ${RUN}`);
  console.log(
    `seller A: ${SELLER_A.slice(0, 12)}...  seller B: ${SELLER_B.slice(0, 12)}...`
  );

  // --- 1. Test connected accounts + seller rows -------------------------
  // Two sourcing modes:
  //  - default: create custom accounts via API (requires the platform's
  //    test-mode Connect platform profile to be completed once);
  //  - E2E_ACCOUNT_A / E2E_ACCOUNT_B env: reuse pre-onboarded express
  //    accounts (not deleted in cleanup — the harness doesn't own them).
  const acctA =
    process.env.E2E_ACCOUNT_A || (await createTestConnectAccount("seller-a"));
  const acctB =
    process.env.E2E_ACCOUNT_B || (await createTestConnectAccount("seller-b"));
  if (!process.env.E2E_ACCOUNT_A) cleanup.accountIds.push(acctA);
  if (!process.env.E2E_ACCOUNT_B) cleanup.accountIds.push(acctB);
  for (const [name, id] of [
    ["A", acctA],
    ["B", acctB],
  ]) {
    const f = await stripe.accounts.retrieve(id);
    if (f.capabilities?.transfers !== "active")
      throw new Error(
        `account ${name} (${id}) transfers capability is ${f.capabilities?.transfers}`
      );
  }
  for (const [pubkey, acct] of [
    [SELLER_A, acctA],
    [SELLER_B, acctB],
  ]) {
    await dbQuery(
      `INSERT INTO stripe_connect_accounts
         (pubkey, stripe_account_id, onboarding_complete, charges_enabled, payouts_enabled, account_type, updated_at)
       VALUES ($1, $2, TRUE, TRUE, TRUE, 'custom', CURRENT_TIMESTAMP)
       ON CONFLICT (pubkey) DO UPDATE SET
         stripe_account_id = EXCLUDED.stripe_account_id,
         onboarding_complete = TRUE, charges_enabled = TRUE,
         payouts_enabled = TRUE, updated_at = CURRENT_TIMESTAMP`,
      [pubkey, acct]
    );
  }
  check(
    "two test connected accounts active + registered",
    true,
    `${acctA}, ${acctB}`
  );

  // NOTE on renewal simulation: test clocks must be set at customer
  // creation, but stripe.customers.list({email}) does NOT return test-clock
  // customers — the route would create a second, clockless customer and the
  // clock would be useless (verified empirically). The renewal below is
  // therefore simulated with a manual invoice carrying the subscription's
  // recurring prices, paid via the saved card, and its REAL invoice.paid
  // event re-delivered — exactly the "simulated renewal" the task allows.

  // --- 3. Create the two-seller recurring cart --------------------------
  const attemptNonce = randomUUID().replaceAll("-", "").slice(0, 16);
  const cartResp = await fetch(
    `${BASE_URL}/api/stripe/create-cart-subscription`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        customerEmail: EMAIL,
        buyerPubkey: BUYER,
        attemptNonce,
        items: [
          {
            productTitle: "E2E Seller A Monthly Box",
            productEventId: pk("e2e-cart-sub-product-a-v1"),
            amount: AMOUNT_A,
            currency: "USD",
            quantity: 1,
            isSubscription: true,
            frequency: "monthly",
            sellerPubkey: SELLER_A,
          },
          {
            productTitle: "E2E Seller B Monthly Box",
            productEventId: pk("e2e-cart-sub-product-b-v1"),
            amount: AMOUNT_B,
            currency: "USD",
            quantity: 1,
            isSubscription: true,
            frequency: "monthly",
            sellerPubkey: SELLER_B,
          },
        ],
      }),
    }
  );
  const cart = await cartResp.json();
  check(
    "multi-seller cart subscription created (no 400)",
    cartResp.status === 200 && cart.success === true,
    `status=${cartResp.status} sub=${cart.subscriptionId || ""} err=${cart.error || ""}`
  );
  if (!cart.success) throw new Error("cart creation failed; aborting");
  cleanup.transferGroup = cart.transferGroup;
  cleanup.subscriptionId = cart.subscriptionId;
  check(
    "response carries one split per seller",
    Array.isArray(cart.sellerSplits) &&
      cart.sellerSplits.length === 2 &&
      cart.sellerSplits.find((s) => s.pubkey === SELLER_A)?.amountCents ===
        CENTS_A &&
      cart.sellerSplits.find((s) => s.pubkey === SELLER_B)?.amountCents ===
        CENTS_B,
    JSON.stringify(cart.sellerSplits?.map((s) => s.amountCents))
  );

  // --- 4. Compact metadata + authority record ---------------------------
  const sub = await stripe.subscriptions.retrieve(cart.subscriptionId);
  const meta = sub.metadata || {};
  const oversized = Object.entries(meta).filter(
    ([, v]) => String(v).length > 490
  );
  check(
    "subscription metadata compact (no oversized values, no embedded splits)",
    meta.isMultiMerchant === "true" &&
      meta.transferGroup === cart.transferGroup &&
      meta.ssSplitAuthority === "pending-record-v1" &&
      !meta.sellerSplits &&
      oversized.length === 0,
    `keys=${Object.keys(meta).join(",")}`
  );
  check(
    "one recurring price per seller item",
    sub.items.data.length === 2 &&
      sub.items.data.every((li) => li.price?.recurring?.interval === "month"),
    `items=${sub.items.data.length}`
  );

  const rec = await dbQuery(
    `SELECT status, metadata FROM stripe_pending_payments WHERE intent_ref = $1`,
    [cart.transferGroup]
  );
  const recMeta = rec.rows[0]?.metadata || {};
  check(
    "authority record persisted with splits + per-price allocations",
    rec.rows.length === 1 &&
      rec.rows[0].status === "created" &&
      Array.isArray(recMeta.sellerSplits) &&
      recMeta.sellerSplits.length === 2 &&
      Array.isArray(recMeta.priceAllocations) &&
      recMeta.priceAllocations.length === 2 &&
      recMeta.priceAllocations.every((a) => a.recurring === true) &&
      recMeta.stripeSubscriptionId === cart.subscriptionId,
    `status=${rec.rows[0]?.status} splits=${recMeta.sellerSplits?.length} allocs=${recMeta.priceAllocations?.length}`
  );

  const subRows = await dbQuery(
    `SELECT seller_pubkey, subscription_price, status FROM subscriptions WHERE stripe_subscription_id = $1`,
    [cart.subscriptionId]
  );
  check(
    "per-item subscription rows recorded for both sellers",
    subRows.rows.length === 2 &&
      subRows.rows.some(
        (r) =>
          r.seller_pubkey === SELLER_A &&
          Number(r.subscription_price) === AMOUNT_A
      ) &&
      subRows.rows.some(
        (r) =>
          r.seller_pubkey === SELLER_B &&
          Number(r.subscription_price) === AMOUNT_B
      ),
    `rows=${subRows.rows.length}`
  );

  // --- 5. Pay the first invoice ------------------------------------------
  // #439 regression pin: on apiVersion 2025-09-30.clover the Invoice object
  // has no top-level payment_intent, so the route's
  // expand:["latest_invoice.payment_intent"] yields nothing — the route must
  // resolve the PI via the invoice's invoicePayments and return a usable
  // clientSecret, or the buyer-facing card form never renders.
  check(
    "create-cart-subscription returns a card-form clientSecret on clover",
    typeof cart.clientSecret === "string" && cart.clientSecret.length > 0,
    cart.clientSecret ? "present" : "NULL"
  );
  const invoice1Id =
    typeof sub.latest_invoice === "string"
      ? sub.latest_invoice
      : sub.latest_invoice?.id;
  const invPayments1 = await stripe.invoicePayments.list({
    invoice: invoice1Id,
    limit: 10,
  });
  const piId = invPayments1.data
    .map((p) => p.payment?.payment_intent)
    .find((id) => typeof id === "string");
  if (!piId) throw new Error("no payment intent found on first invoice");
  // tok_bypassPending maps to the test card whose funds land directly in
  // the available balance (raw card-number APIs are disabled on this key).
  const pm = await stripe.paymentMethods.create({
    type: "card",
    card: { token: "tok_bypassPending" },
  });
  // The route creates/owns the customer (it can't see test-clock customers,
  // so pre-creating one would fork identity) — attach to ITS customer id.
  await stripe.paymentMethods.attach(pm.id, { customer: cart.customerId });
  cleanup.customerId = cart.customerId;
  const confirmed = await stripe.paymentIntents.confirm(piId, {
    payment_method: pm.id,
  });
  check(
    "first invoice payment succeeded",
    confirmed.status === "succeeded",
    `pi=${confirmed.status}`
  );
  cleanup.invoiceIds.push(invoice1Id);

  // --- 6. First invoice.paid webhook -------------------------------------
  const first = await deliverInvoicePaidEvent(invoice1Id, startTs);
  check(
    "first invoice.paid webhook accepted",
    first.status === 200,
    `status=${first.status} body=${first.body.slice(0, 120)}`
  );
  const dup = await deliverInvoicePaidEvent(invoice1Id, startTs);
  check(
    "re-delivered first invoice.paid is deduped",
    dup.status === 200 && dup.body.includes("deduped"),
    `status=${dup.status}`
  );

  let byInvoice = await transfersByInvoice(cart.transferGroup);
  const t1 = byInvoice.get(invoice1Id) || [];
  check(
    "first invoice: exactly one transfer per seller for recorded amounts",
    t1.length === 2 &&
      t1.some(
        (t) =>
          t.seller === SELLER_A &&
          t.amount === CENTS_A &&
          t.destination === acctA
      ) &&
      t1.some(
        (t) =>
          t.seller === SELLER_B &&
          t.amount === CENTS_B &&
          t.destination === acctB
      ),
    JSON.stringify(
      t1.map((t) => `${t.seller.slice(0, 8)}:${t.amount}->${t.destination}`)
    )
  );

  // --- 7. Simulated renewal: quantity-bump proration invoice --------------
  // Renewal-simulation constraints discovered empirically on clover:
  //  - test clocks must be set at customer creation, but the route's
  //    customers.list({email}) cannot see clock customers (would fork
  //    identity), and billing_cycle_anchor:'now' generates NO invoice;
  //  - invoiceItems refuse recurring prices, so a manual invoice can't
  //    carry the subscription's price ids.
  // A quantity bump with proration_behavior:'always_invoice' creates a REAL
  // immediately-paid invoice whose lines carry the recurring price ids —
  // the exact allocation path a subscription_cycle renewal exercises.
  const subFresh = await stripe.subscriptions.retrieve(cart.subscriptionId);
  await stripe.subscriptions.update(cart.subscriptionId, {
    proration_behavior: "always_invoice",
    items: subFresh.items.data.map((li) => ({ id: li.id, quantity: 2 })),
  });
  let invoice2 = null;
  for (let i = 0; i < 20 && !invoice2; i++) {
    const invs = await stripe.invoices.list({
      subscription: cart.subscriptionId,
      limit: 10,
    });
    const renewal = invs.data.find((x) => x.id !== invoice1Id);
    if (renewal) {
      if (renewal.status === "draft")
        await stripe.invoices.finalizeInvoice(renewal.id);
      const fresh2 = await stripe.invoices.retrieve(renewal.id);
      if (fresh2.status === "paid") invoice2 = fresh2;
      else if (fresh2.status === "open") {
        const pays = await stripe.invoicePayments.list({
          invoice: renewal.id,
          limit: 5,
        });
        const rpi = pays.data
          .map((p) => p.payment?.payment_intent)
          .find((id) => typeof id === "string");
        if (rpi)
          await stripe.paymentIntents
            .confirm(rpi, { payment_method: pm.id })
            .catch(() => {});
        else
          await stripe.invoices
            .pay(renewal.id, { payment_method: pm.id })
            .catch(() => {});
      }
    }
    if (!invoice2) await new Promise((r) => setTimeout(r, 3000));
  }
  check(
    "renewal-style invoice paid from saved payment method",
    !!invoice2 && invoice2.amount_paid === CENTS_A + CENTS_B,
    invoice2
      ? `invoice=${invoice2.id} status=${invoice2.status} paid=${invoice2.amount_paid}`
      : "no renewal invoice"
  );
  if (!invoice2) throw new Error("renewal invoice never settled; aborting");
  cleanup.invoiceIds.push(invoice2.id);

  // Expected per-seller payouts derived from THIS invoice's real lines via
  // the stored price allocations — mirroring the webhook's derivation.
  const priceToSeller = new Map(
    recMeta.priceAllocations.map((a) => [a.priceId, a.sellerPubkey])
  );
  const lines2 = await stripe.invoices.listLineItems(invoice2.id, {
    limit: 100,
  });
  const expectedByInvoice2 = new Map();
  for (const l of lines2.data) {
    const pid =
      typeof l.price === "string"
        ? l.price
        : (l.price?.id ?? l.pricing?.price_details?.price);
    const seller = priceToSeller.get(pid);
    if (!seller) throw new Error(`harness: unattributed line price ${pid}`);
    expectedByInvoice2.set(
      seller,
      (expectedByInvoice2.get(seller) ?? 0) + l.amount
    );
  }

  // --- 8. Renewal invoice.paid webhook (re-sent real event) ---------------
  const second = await deliverInvoicePaidEvent(invoice2.id, startTs);
  check(
    "renewal invoice.paid webhook accepted",
    second.status === 200,
    `status=${second.status} body=${second.body.slice(0, 120)}`
  );

  byInvoice = await transfersByInvoice(cart.transferGroup);
  const t2 = byInvoice.get(invoice2.id) || [];
  check(
    "renewal: exactly one transfer per seller resolved from the stored record",
    t2.length === 2 &&
      t2.length === expectedByInvoice2.size &&
      [...expectedByInvoice2.entries()].every(([pk2, amt]) =>
        t2.some((t) => t.seller === pk2 && t.amount === amt)
      ),
    `expected=${JSON.stringify([...expectedByInvoice2.entries()].map(([k, v]) => `${k.slice(0, 8)}:${v}`))} got=${JSON.stringify(t2.map((t) => `${t.seller.slice(0, 8)}:${t.amount}->${t.destination}`))}`
  );
  const totalTransfers = [...byInvoice.values()].reduce(
    (n, arr) => n + arr.length,
    0
  );
  check(
    "exactly 4 transfers total across both invoices (no double pays)",
    byInvoice.size === 2 && totalTransfers === 4,
    `invoices=${byInvoice.size} transfers=${totalTransfers}`
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
    for (const acct of cleanup.accountIds)
      await stripe.accounts
        .del(acct)
        .catch((e) => console.warn("del account:", e.message));
  } catch (e) {
    console.warn("stripe cleanup:", e.message);
  }
  try {
    if (cleanup.transferGroup)
      await dbQuery(
        `DELETE FROM stripe_pending_payments WHERE intent_ref = $1`,
        [cleanup.transferGroup]
      );
    if (cleanup.subscriptionId)
      await dbQuery(
        `DELETE FROM subscriptions WHERE stripe_subscription_id = $1`,
        [cleanup.subscriptionId]
      );
    await dbQuery(
      `DELETE FROM stripe_connect_accounts WHERE pubkey = ANY($1)`,
      [[SELLER_A, SELLER_B]]
    );
    if (cleanup.invoiceIds.length)
      // Invoice payout claims share this table keyed under payment_intent_id.
      await dbQuery(
        `DELETE FROM stripe_payout_claims WHERE payment_intent_id = ANY($1)`,
        [cleanup.invoiceIds]
      );
    if (cleanup.eventIds.length)
      await dbQuery(
        `DELETE FROM stripe_processed_events WHERE event_id = ANY($1)`,
        [cleanup.eventIds]
      );
  } catch (e) {
    console.warn("db cleanup:", e.message);
  }
  await db.end().catch(() => {});
}

main()
  .catch((e) => {
    console.error("HARNESS ERROR:", e.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await teardown();
    const failed = results.filter((r) => !r.ok).length;
    console.log(
      `--- ${results.length - failed}/${results.length} checks passed ---`
    );
  });
