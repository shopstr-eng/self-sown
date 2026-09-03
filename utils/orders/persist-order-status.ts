import { createNip98AuthorizationHeader } from "@/utils/nostr/nip98-auth";
import type { NostrSigner } from "@/utils/nostr/signers/nostr-signer";

type SellerLifecycleStatus = "pending" | "confirmed" | "shipped" | "completed";

interface PersistSellerOrderStatusInput {
  signer: NostrSigner;
  origin: string;
  orderId: string;
  sellerPubkey: string;
  buyerPubkey: string | null;
  sourceMessageId: string;
  currentStatus: string;
  targetStatus: Exclude<SellerLifecycleStatus, "pending">;
  fetchImpl?: typeof fetch;
}

const NEXT_STATUS: Record<
  Exclude<SellerLifecycleStatus, "completed">,
  Exclude<SellerLifecycleStatus, "pending">
> = {
  pending: "confirmed",
  confirmed: "shipped",
  shipped: "completed",
};
const STATUS_RANK: Record<SellerLifecycleStatus, number> = {
  pending: 0,
  confirmed: 1,
  shipped: 2,
  completed: 3,
};

function isSellerLifecycleStatus(
  value: unknown
): value is SellerLifecycleStatus {
  return (
    value === "pending" ||
    value === "confirmed" ||
    value === "shipped" ||
    value === "completed"
  );
}

export async function persistSellerOrderStatusThrough({
  signer,
  origin,
  orderId,
  sellerPubkey,
  buyerPubkey,
  sourceMessageId,
  currentStatus,
  targetStatus,
  fetchImpl = fetch,
}: PersistSellerOrderStatusInput): Promise<void> {
  // A terminal or otherwise unrecognized persisted status (e.g. "canceled")
  // must never be coerced to "pending" and walked forward — that would
  // resurrect a canceled order. Only advance from known lifecycle states.
  if (currentStatus && !isSellerLifecycleStatus(currentStatus)) {
    return;
  }

  let current: SellerLifecycleStatus = isSellerLifecycleStatus(currentStatus)
    ? currentStatus
    : "pending";

  while (STATUS_RANK[current] < STATUS_RANK[targetStatus]) {
    if (current === "completed") return;
    const next = NEXT_STATUS[current];
    const body = JSON.stringify({
      orderId,
      sellerPubkey,
      buyerPubkey,
      expectedStatus: current,
      status: next,
      messageId: sourceMessageId,
      transitionId: `${sourceMessageId}:${next}`,
    });
    const authorizationHeader = await createNip98AuthorizationHeader(
      signer,
      `${origin.replace(/\/+$/, "")}/api/db/update-order-status`,
      "POST",
      body
    );
    const response = await fetchImpl("/api/db/update-order-status", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authorizationHeader,
      },
      body,
    });
    if (response.ok) {
      current = next;
      continue;
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    const canonicalStatus =
      payload &&
      typeof payload === "object" &&
      "currentStatus" in payload &&
      isSellerLifecycleStatus(
        (payload as { currentStatus?: unknown }).currentStatus
      )
        ? (payload as { currentStatus: SellerLifecycleStatus }).currentStatus
        : null;
    if (
      response.status === 409 &&
      canonicalStatus &&
      STATUS_RANK[canonicalStatus] > STATUS_RANK[current]
    ) {
      current = canonicalStatus;
      continue;
    }
    throw new Error("Order status could not be persisted");
  }
}
