import type { Event } from "nostr-tools";

import {
  canSellerTransitionOrderStatus,
  type SellerOrder,
  type SellerOrderStatus,
  type SellerSession,
  type SellerShippingUpdate,
} from "@milk-market/domain";
import type {
  OutboxExpectedStatus,
  SellerOrderNotificationOutbox,
  SellerOrderNotificationOutboxEntry,
} from "./order-notification-outbox";

export type SellerManagedOrderStatus = Extract<
  SellerOrderStatus,
  "confirmed" | "shipped" | "completed"
>;

export interface SellerOrderActionProgress {
  orderId: string;
  nextStatus: SellerManagedOrderStatus;
  sourceMessageId?: string;
  serverPersisted: boolean;
  buyerNotificationRequired: boolean;
  buyerNotified: boolean;
  giftWrap?: Event;
}

export type SellerOrderActionFailureCode =
  | "INVALID_TRANSITION"
  | "INVALID_RETRY"
  | "STATUS_EVENT_FAILED"
  | "OUTBOX_PERSISTENCE_FAILED"
  | "SERVER_PERSISTENCE_FAILED"
  | "BUYER_NOTIFICATION_FAILED";

export type SellerOrderActionResult =
  | { ok: true; progress: SellerOrderActionProgress }
  | {
      ok: false;
      code: SellerOrderActionFailureCode;
      message: string;
      progress: SellerOrderActionProgress;
    };

export interface ExecuteSellerOrderActionInput {
  session: SellerSession;
  order: SellerOrder;
  nextStatus: SellerManagedOrderStatus;
  shipping?: SellerShippingUpdate;
  previousProgress?: SellerOrderActionProgress;
}

export interface SellerOrderActionDependencies {
  apiBaseUrl: string;
  createStatusGiftWrap: (input: {
    session: SellerSession;
    buyerPubkey: string;
    orderId: string;
    productAddress: string;
    status: SellerManagedOrderStatus;
    shipping?: SellerShippingUpdate;
  }) => Event;
  createAuthorizationHeader: (input: {
    session: SellerSession;
    url: string;
    method: "POST";
    body: string;
  }) => string;
  persistStatus: (input: {
    orderId: string;
    sellerPubkey: string;
    buyerPubkey: string | null;
    expectedStatus: OutboxExpectedStatus;
    status: SellerManagedOrderStatus;
    messageId?: string;
    transitionId: string;
    authorizationHeader: string;
  }) => Promise<{ persisted: boolean }>;
  publishStatusGiftWrap: (input: {
    baseUrl: string;
    session: SellerSession;
    giftWrap: Event;
  }) => Promise<void>;
  outbox: SellerOrderNotificationOutbox;
}

export interface SellerOrderActionCoordinator {
  execute: (
    input: ExecuteSellerOrderActionInput
  ) => Promise<SellerOrderActionResult>;
}

function createInitialProgress(
  input: ExecuteSellerOrderActionInput
): SellerOrderActionProgress {
  return {
    orderId: input.order.orderId,
    nextStatus: input.nextStatus,
    ...(input.order.wrappedEventIds[0]
      ? { sourceMessageId: input.order.wrappedEventIds[0] }
      : {}),
    serverPersisted: false,
    buyerNotificationRequired: Boolean(
      !input.order.isGuest && input.order.buyerPubkey
    ),
    buyerNotified: false,
  };
}

function isMatchingProgress(
  progress: SellerOrderActionProgress,
  expected: SellerOrderActionProgress
): boolean {
  return (
    progress.orderId === expected.orderId &&
    progress.nextStatus === expected.nextStatus &&
    progress.sourceMessageId === expected.sourceMessageId &&
    progress.buyerNotificationRequired === expected.buyerNotificationRequired &&
    (!progress.buyerNotificationRequired || Boolean(progress.giftWrap))
  );
}

const EXPECTED_STATUS_BY_TARGET: Record<
  SellerManagedOrderStatus,
  OutboxExpectedStatus
> = {
  confirmed: "pending",
  shipped: "confirmed",
  completed: "shipped",
};

function serializeStatusBody(input: {
  orderId: string;
  sellerPubkey: string;
  buyerPubkey: string | null;
  expectedStatus: OutboxExpectedStatus;
  status: SellerManagedOrderStatus;
  sourceMessageId?: string;
  transitionId: string;
}): string {
  return JSON.stringify({
    orderId: input.orderId,
    sellerPubkey: input.sellerPubkey,
    buyerPubkey: input.buyerPubkey,
    expectedStatus: input.expectedStatus,
    status: input.status,
    ...(input.sourceMessageId ? { messageId: input.sourceMessageId } : {}),
    transitionId: input.transitionId,
  });
}

function createTransitionInput(
  input: ExecuteSellerOrderActionInput,
  progress: SellerOrderActionProgress
) {
  const expectedStatus = EXPECTED_STATUS_BY_TARGET[input.nextStatus];
  const transitionId =
    progress.giftWrap?.id ??
    `guest:${progress.sourceMessageId ?? input.order.orderId}:${input.nextStatus}`;
  return {
    orderId: progress.orderId,
    sellerPubkey: input.order.sellerPubkey,
    buyerPubkey: input.order.buyerPubkey ?? null,
    expectedStatus,
    status: progress.nextStatus,
    ...(progress.sourceMessageId
      ? { sourceMessageId: progress.sourceMessageId }
      : {}),
    transitionId,
  };
}

function toOutboxEntry(
  transition: ReturnType<typeof createTransitionInput>,
  progress: SellerOrderActionProgress
): SellerOrderNotificationOutboxEntry | null {
  if (
    !progress.buyerNotificationRequired ||
    !progress.giftWrap ||
    !transition.buyerPubkey ||
    !transition.sourceMessageId
  ) {
    return null;
  }
  return {
    version: 1,
    sellerPubkey: transition.sellerPubkey,
    buyerPubkey: transition.buyerPubkey,
    orderId: transition.orderId,
    expectedStatus: transition.expectedStatus,
    nextStatus: transition.status,
    sourceMessageId: transition.sourceMessageId,
    transitionId: transition.transitionId,
    queuedAt: Date.now(),
    serverPersisted: progress.serverPersisted,
    giftWrap: progress.giftWrap,
  };
}

function isPermanentPersistenceFailure(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("status" in error)) {
    return false;
  }
  const status = (error as { status?: unknown }).status;
  return (
    typeof status === "number" &&
    status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 429
  );
}

export function createSellerOrderActionCoordinator(
  dependencies: SellerOrderActionDependencies
): SellerOrderActionCoordinator {
  const inFlight = new Map<string, Promise<SellerOrderActionResult>>();

  async function executeOnce(
    input: ExecuteSellerOrderActionInput
  ): Promise<SellerOrderActionResult> {
    const initialProgress = createInitialProgress(input);
    if (
      input.session.pubkey !== input.order.sellerPubkey ||
      !initialProgress.sourceMessageId ||
      (input.previousProgress === undefined &&
        !canSellerTransitionOrderStatus(input.order.status, input.nextStatus))
    ) {
      return {
        ok: false,
        code: "INVALID_TRANSITION",
        message: "This order cannot move to the requested status.",
        progress: initialProgress,
      };
    }

    if (
      input.previousProgress &&
      (!isMatchingProgress(input.previousProgress, initialProgress) ||
        (!canSellerTransitionOrderStatus(
          input.order.status,
          input.nextStatus
        ) &&
          !(
            input.previousProgress.serverPersisted &&
            input.order.status === input.nextStatus
          )))
    ) {
      return {
        ok: false,
        code: "INVALID_RETRY",
        message: "This order retry no longer matches the requested action.",
        progress: initialProgress,
      };
    }

    const progress: SellerOrderActionProgress = input.previousProgress
      ? { ...input.previousProgress }
      : initialProgress;

    if (
      progress.buyerNotificationRequired &&
      !progress.giftWrap &&
      input.order.buyerPubkey
    ) {
      try {
        progress.giftWrap = dependencies.createStatusGiftWrap({
          session: input.session,
          buyerPubkey: input.order.buyerPubkey,
          orderId: input.order.orderId,
          productAddress: input.order.productAddress,
          status: input.nextStatus,
          ...(input.shipping ? { shipping: input.shipping } : {}),
        });
      } catch {
        return {
          ok: false,
          code: "STATUS_EVENT_FAILED",
          message: "The encrypted buyer update could not be prepared.",
          progress,
        };
      }
    }

    const transition = createTransitionInput(input, progress);
    const outboxEntry = toOutboxEntry(transition, progress);
    if (outboxEntry) {
      try {
        await dependencies.outbox.save(outboxEntry);
      } catch {
        return {
          ok: false,
          code: "OUTBOX_PERSISTENCE_FAILED",
          message:
            "The encrypted buyer update could not be saved for reliable delivery.",
          progress,
        };
      }
    }

    if (!progress.serverPersisted) {
      try {
        const body = serializeStatusBody(transition);
        const authorizationHeader = dependencies.createAuthorizationHeader({
          session: input.session,
          url: `${dependencies.apiBaseUrl.replace(/\/+$/, "")}/api/db/update-order-status`,
          method: "POST",
          body,
        });
        const response = await dependencies.persistStatus({
          orderId: progress.orderId,
          sellerPubkey: transition.sellerPubkey,
          buyerPubkey: transition.buyerPubkey,
          expectedStatus: transition.expectedStatus,
          status: progress.nextStatus,
          ...(progress.sourceMessageId
            ? { messageId: progress.sourceMessageId }
            : {}),
          transitionId: transition.transitionId,
          authorizationHeader,
        });
        if (!response.persisted) {
          throw new Error("status row was not persisted");
        }
        progress.serverPersisted = true;
      } catch (error) {
        if (outboxEntry && isPermanentPersistenceFailure(error)) {
          try {
            await dependencies.outbox.remove(
              transition.sellerPubkey,
              transition.transitionId
            );
          } catch {
            // A validated stale entry can be discarded on the next recovery.
          }
        }
        return {
          ok: false,
          code: "SERVER_PERSISTENCE_FAILED",
          message:
            "The status was not saved. Retry before notifying the buyer.",
          progress,
        };
      }
    }

    if (outboxEntry && progress.serverPersisted) {
      try {
        await dependencies.outbox.markServerPersisted(
          transition.sellerPubkey,
          transition.transitionId
        );
      } catch {
        return {
          ok: false,
          code: "OUTBOX_PERSISTENCE_FAILED",
          message:
            "The status was saved, but reliable buyer delivery could not be recorded.",
          progress,
        };
      }
    }

    if (
      progress.buyerNotificationRequired &&
      !progress.buyerNotified &&
      progress.giftWrap
    ) {
      try {
        await dependencies.publishStatusGiftWrap({
          baseUrl: dependencies.apiBaseUrl,
          session: input.session,
          giftWrap: progress.giftWrap,
        });
        progress.buyerNotified = true;
        try {
          await dependencies.outbox.remove(
            transition.sellerPubkey,
            transition.transitionId
          );
        } catch {
          // Replaying the exact same signed Nostr event is idempotent.
        }
      } catch {
        return {
          ok: false,
          code: "BUYER_NOTIFICATION_FAILED",
          message:
            "The status was saved, but the encrypted buyer update still needs to be published.",
          progress,
        };
      }
    }

    return { ok: true, progress };
  }

  return {
    execute(input) {
      const key = `${input.session.pubkey}:${input.order.orderId}:${input.nextStatus}`;
      const existing = inFlight.get(key);
      if (existing) {
        return existing;
      }

      const operation = executeOnce(input).finally(() => {
        if (inFlight.get(key) === operation) {
          inFlight.delete(key);
        }
      });
      inFlight.set(key, operation);
      return operation;
    },
  };
}

const recoveryInFlight = new Map<string, Promise<void>>();

export function retryPendingSellerOrderNotifications(
  session: SellerSession,
  dependencies: SellerOrderActionDependencies
): Promise<void> {
  const existing = recoveryInFlight.get(session.pubkey);
  if (existing) return existing;

  const operation = (async () => {
    const entries = await dependencies.outbox.list(session.pubkey);
    for (const entry of entries) {
      try {
        if (!entry.serverPersisted) {
          const transition = {
            orderId: entry.orderId,
            sellerPubkey: entry.sellerPubkey,
            buyerPubkey: entry.buyerPubkey,
            expectedStatus: entry.expectedStatus,
            status: entry.nextStatus,
            sourceMessageId: entry.sourceMessageId,
            transitionId: entry.transitionId,
          };
          const body = serializeStatusBody(transition);
          const authorizationHeader = dependencies.createAuthorizationHeader({
            session,
            url: `${dependencies.apiBaseUrl.replace(/\/+$/, "")}/api/db/update-order-status`,
            method: "POST",
            body,
          });
          const response = await dependencies.persistStatus({
            orderId: entry.orderId,
            sellerPubkey: entry.sellerPubkey,
            buyerPubkey: entry.buyerPubkey,
            expectedStatus: entry.expectedStatus,
            status: entry.nextStatus,
            messageId: entry.sourceMessageId,
            transitionId: entry.transitionId,
            authorizationHeader,
          });
          if (!response.persisted) continue;
          await dependencies.outbox.markServerPersisted(
            entry.sellerPubkey,
            entry.transitionId
          );
        }

        await dependencies.publishStatusGiftWrap({
          baseUrl: dependencies.apiBaseUrl,
          session,
          giftWrap: entry.giftWrap,
        });
        await dependencies.outbox.remove(
          entry.sellerPubkey,
          entry.transitionId
        );
      } catch {
        // Keep the validated entry for the next app start or foreground retry.
      }
    }
  })().finally(() => {
    if (recoveryInFlight.get(session.pubkey) === operation) {
      recoveryInFlight.delete(session.pubkey);
    }
  });
  recoveryInFlight.set(session.pubkey, operation);
  return operation;
}
