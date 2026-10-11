import { signEventTemplate } from "@self-sown/nostr";
import type { SellerSession } from "@self-sown/domain";

import { getApiBaseUrl } from "./api-base-url";

// Mobile port of the web account-recovery flow in
// components/settings/nostr-keys-section.tsx. Mirrors the web contract in
// pages/api/auth/{check-recovery,send-recovery-verification,setup-recovery}:
// every call carries a kind-27235 signed proof in the x-signed-event header
// whose tags bind action/method/path/pubkey plus the behavior-changing
// fields (sorted, String()-serialized, undefined/null/"" dropped) — the same
// pattern as lib/discount-codes.ts and utils/nostr/request-auth.ts.
const SIGNED_EVENT_HEADER = "x-signed-event";
const SIGNED_HTTP_REQUEST_KIND = 27235;
const CHECK_RECOVERY_PATH = "/api/auth/check-recovery";
const SEND_VERIFICATION_PATH = "/api/auth/send-recovery-verification";
const SETUP_RECOVERY_PATH = "/api/auth/setup-recovery";

export interface RecoveryStatus {
  hasRecovery: boolean;
  maskedEmail: string | null;
}

type ProofValue = string | number | null | undefined;

function signProof(
  session: SellerSession,
  action: string,
  path: string,
  fields: Record<string, ProofValue> = {}
): string {
  const sortedFields = Object.entries(fields)
    .flatMap(([key, value]) => {
      if (value === undefined || value === null || value === "") return [];
      return [[key, String(value)]] as Array<[string, string]>;
    })
    .sort(([left], [right]) => left.localeCompare(right));

  const signedEvent = signEventTemplate(session, {
    kind: SIGNED_HTTP_REQUEST_KIND,
    created_at: Math.floor(Date.now() / 1000),
    content: "",
    tags: [
      ["action", action],
      ["method", "POST"],
      ["path", path],
      ["pubkey", session.pubkey],
      ...sortedFields,
    ],
  });
  return JSON.stringify(signedEvent);
}

async function readErrorMessage(response: Response, fallback: string) {
  try {
    const body = (await response.json()) as { error?: string };
    return body.error ?? fallback;
  } catch {
    return fallback;
  }
}

// Client-side mirror of the server regex in send-recovery-verification.ts.
export function validateRecoveryEmail(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return "Please enter an email address.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed))
    return "Invalid email address.";
  return null;
}

// Mirrors maskEmail in pages/api/auth/check-recovery.ts so the status line
// can update immediately after setup without a refetch.
export function maskRecoveryEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!local || !domain) return "***@***.***";
  return local.slice(0, Math.min(2, local.length)) + "***@" + domain;
}

export async function checkRecoveryStatus(
  session: SellerSession
): Promise<RecoveryStatus> {
  const response = await fetch(`${getApiBaseUrl()}${CHECK_RECOVERY_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [SIGNED_EVENT_HEADER]: signProof(session, "check_recovery", CHECK_RECOVERY_PATH),
    },
    body: JSON.stringify({ pubkey: session.pubkey }),
  });
  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, "Recovery status could not be loaded.")
    );
  }
  const body = (await response.json()) as {
    hasRecovery?: boolean;
    maskedEmail?: string;
  };
  return {
    hasRecovery: body.hasRecovery === true,
    maskedEmail: typeof body.maskedEmail === "string" ? body.maskedEmail : null,
  };
}

export async function sendRecoveryVerificationCode(
  session: SellerSession,
  email: string
): Promise<void> {
  const response = await fetch(`${getApiBaseUrl()}${SEND_VERIFICATION_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [SIGNED_EVENT_HEADER]: signProof(
        session,
        "send_recovery_verification",
        SEND_VERIFICATION_PATH,
        { email }
      ),
    },
    body: JSON.stringify({ email, pubkey: session.pubkey }),
  });
  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, "Failed to send verification.")
    );
  }
}

// Confirms the emailed code and stores the recovery credential server-side.
// Returns the one-time recovery key — it is shown once and never retrievable
// again, so the caller must surface it immediately.
export async function confirmRecoverySetup(
  session: SellerSession,
  email: string,
  verificationCode: string
): Promise<{ recoveryKey: string }> {
  const response = await fetch(`${getApiBaseUrl()}${SETUP_RECOVERY_PATH}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // The nsec travels in the body (the server encrypts it with the new
      // recovery key) but is never a proof field — the event signature
      // already proves key ownership and tags could be logged.
      [SIGNED_EVENT_HEADER]: signProof(
        session,
        "setup_recovery",
        SETUP_RECOVERY_PATH,
        { email, authType: session.authMethod, verificationCode }
      ),
    },
    body: JSON.stringify({
      pubkey: session.pubkey,
      email,
      nsec: session.nsec,
      verificationCode,
      authType: session.authMethod,
    }),
  });
  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, "Failed to set up recovery.")
    );
  }
  const body = (await response.json()) as { recoveryKey?: string };
  if (!body.recoveryKey) {
    throw new Error("The server did not return a recovery key.");
  }
  return { recoveryKey: body.recoveryKey };
}
