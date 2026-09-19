/** @jest-environment node */

/**
 * LIVE fencing verification for stripe_payout_claims (#429): drives the
 * claim → stale-takeover → old-owner-resumes sequence against a REAL
 * Postgres so the ownership-token fencing is proven at SQL level, not via
 * mocks:
 *
 *  1. A stale takeover (releaseStale + reclaim) ROTATES the claim token.
 *  2. A resumed previous owner's token-gated completion matches ZERO rows
 *     and throws PayoutClaimLostError — its transfer can never be recorded
 *     onto the replacement owner's claim.
 *  3. Its token-gated release likewise deletes nothing.
 *  4. A completed claim is immune to release even with the current token.
 *
 * GATED: runs ONLY when PAYOUT_CLAIMS_TEST_DATABASE_URL is explicitly set
 * (its value overrides DATABASE_URL for this process). Uses unique per-run
 * zz-payoutclaim-<ts>-* keys and deletes only this run's rows afterwards
 * (plus stragglers older than 2h from crashed runs); never touches real
 * claims.
 */

const RUN = !!process.env.PAYOUT_CLAIMS_TEST_DATABASE_URL;
// The pool is built lazily on first use, so overriding DATABASE_URL here —
// before any test runs — is enough.
if (RUN) {
  process.env.DATABASE_URL = process.env.PAYOUT_CLAIMS_TEST_DATABASE_URL;
}

import {
  claimPayout,
  completePayoutClaim,
  releasePayoutClaim,
  releaseStalePayoutClaim,
  PayoutClaimLostError,
} from "@/utils/stripe/payout-claims";
import { getDbPool } from "@/utils/db/db-service";

const RUN_ID = `zz-payoutclaim-${Date.now()}`;
const STRAGGLER_AGE_MS = 2 * 60 * 60 * 1000;

const describeLive = RUN ? describe : describe.skip;

describeLive("payout-claims token fencing (live Postgres)", () => {
  afterAll(async () => {
    const pool = getDbPool();
    await pool.query(
      `DELETE FROM stripe_payout_claims WHERE payment_intent_id LIKE $1`,
      [`${RUN_ID}-%`]
    );
    // Stragglers from crashed runs (any run's synthetic rows older than 2h).
    await pool.query(
      `DELETE FROM stripe_payout_claims
        WHERE payment_intent_id LIKE 'zz-payoutclaim-%' AND created_at < $1`,
      [Date.now() - STRAGGLER_AGE_MS]
    );
  });

  it("a stale takeover rotates the token: the resumed old owner can neither complete nor release the new claim", async () => {
    const id = `${RUN_ID}-takeover`;
    const seller = `${RUN_ID}-seller`;

    // Attempt 1 owns the claim.
    const first = await claimPayout(id, seller);
    expect(first.created).toBe(true);
    expect(first.claimToken).toBeTruthy();

    // The claim goes stale and attempt 2 takes it over (stale release +
    // reclaim with a fresh token). A negative stale window makes the just-
    // created row "stale" for the purposes of this test.
    await releaseStalePayoutClaim(id, seller, -1);
    const second = await claimPayout(id, seller);
    expect(second.created).toBe(true);
    expect(second.claimToken).toBeTruthy();
    expect(second.claimToken).not.toBe(first.claimToken);

    // Resumed attempt 1: its token-gated completion matches ZERO rows and
    // fails loudly instead of recording its transfer on the new claim.
    await expect(
      completePayoutClaim(id, seller, "tr_old_owner", first.claimToken)
    ).rejects.toThrow(PayoutClaimLostError);

    // Its release deletes nothing either — the new owner's row survives.
    await releasePayoutClaim(id, seller, first.claimToken);
    const afterOldOwner = await claimPayout(id, seller);
    expect(afterOldOwner.created).toBe(false);
    expect(afterOldOwner.transferId).toBeNull();

    // The new owner completes normally and the transfer is recorded.
    await completePayoutClaim(id, seller, "tr_new_owner", second.claimToken);
    const completed = await claimPayout(id, seller);
    expect(completed.created).toBe(false);
    expect(completed.transferId).toBe("tr_new_owner");
  });

  it("a completed claim is immune to release, even with the current token", async () => {
    const id = `${RUN_ID}-completed`;
    const seller = `${RUN_ID}-seller`;
    const claim = await claimPayout(id, seller);
    await completePayoutClaim(id, seller, "tr_done", claim.claimToken);
    await releasePayoutClaim(id, seller, claim.claimToken);
    const after = await claimPayout(id, seller);
    expect(after.created).toBe(false);
    expect(after.transferId).toBe("tr_done");
  });
});
