/** @jest-environment node */

// apps/mobile/lib/api-base-url.ts reads the RN global __DEV__.
(globalThis as { __DEV__?: boolean }).__DEV__ = true;

jest.mock("react-native", () => ({ Platform: { OS: "web" } }), {
  virtual: true,
});

// Deterministic stand-in for the real signer: echoes the proof template tags
// so tests can assert exactly what the request binds.
jest.mock(
  "@self-sown/nostr",
  () => ({
    signEventTemplate: (
      session: { pubkey: string },
      template: { tags: string[][] }
    ) => ({
      id: "signed",
      pubkey: session.pubkey,
      kind: 27235,
      tags: template.tags,
    }),
  }),
  { virtual: true }
);

import {
  checkRecoveryStatus,
  confirmRecoverySetup,
  maskRecoveryEmail,
  sendRecoveryVerificationCode,
  validateRecoveryEmail,
} from "@/apps/mobile/lib/account-recovery";
import type { SellerSession } from "@self-sown/domain";

const session = {
  pubkey: "c".repeat(64),
  nsec: "nsec1test",
  authMethod: "nsec",
} as unknown as SellerSession;

const fetchMock = jest.fn();
(globalThis as { fetch?: unknown }).fetch = fetchMock;

function jsonResponse(payload: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => payload,
  } as unknown as Response;
}

function lastCall() {
  const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [
    string,
    RequestInit,
  ];
  const header = (init.headers as Record<string, string | undefined>)[
    "x-signed-event"
  ];
  if (!header) throw new Error("missing x-signed-event header");
  const signedEvent = JSON.parse(header) as { tags: string[][] };
  const tagValue = (name: string) =>
    signedEvent.tags.find((tag) => tag[0] === name)?.[1];
  return { url, init, signedEvent, tagValue };
}

beforeEach(() => {
  fetchMock.mockReset();
});

describe("validateRecoveryEmail", () => {
  it("rejects blank and malformed addresses", () => {
    expect(validateRecoveryEmail("")).toBe("Please enter an email address.");
    expect(validateRecoveryEmail("   ")).toBe("Please enter an email address.");
    expect(validateRecoveryEmail("not-an-email")).toBe(
      "Invalid email address."
    );
    expect(validateRecoveryEmail("a@b")).toBe("Invalid email address.");
  });

  it("accepts a normal address", () => {
    expect(validateRecoveryEmail("seller@example.com")).toBeNull();
  });
});

describe("maskRecoveryEmail", () => {
  it("matches the server masking shape", () => {
    expect(maskRecoveryEmail("seller@example.com")).toBe("se***@example.com");
    expect(maskRecoveryEmail("a@example.com")).toBe("a***@example.com");
    expect(maskRecoveryEmail("invalid")).toBe("***@***.***");
  });
});

describe("checkRecoveryStatus", () => {
  it("posts a signed check_recovery proof and maps the response", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ hasRecovery: true, maskedEmail: "se***@example.com" })
    );

    const status = await checkRecoveryStatus(session);

    expect(status).toEqual({
      hasRecovery: true,
      maskedEmail: "se***@example.com",
    });
    const { url, init, tagValue } = lastCall();
    expect(url).toContain("/api/auth/check-recovery");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      pubkey: session.pubkey,
    });
    expect(tagValue("action")).toBe("check_recovery");
    expect(tagValue("method")).toBe("POST");
    expect(tagValue("path")).toBe("/api/auth/check-recovery");
    expect(tagValue("pubkey")).toBe(session.pubkey);
  });

  it("maps a missing record to hasRecovery false", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ hasRecovery: false }));
    const status = await checkRecoveryStatus(session);
    expect(status).toEqual({ hasRecovery: false, maskedEmail: null });
  });

  it("throws the server error message on failure", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "boom" }, false, 500));
    await expect(checkRecoveryStatus(session)).rejects.toThrow("boom");
  });
});

describe("sendRecoveryVerificationCode", () => {
  it("binds the email in the signed proof", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true }));

    await sendRecoveryVerificationCode(session, "seller@example.com");

    const { url, init, tagValue } = lastCall();
    expect(url).toContain("/api/auth/send-recovery-verification");
    expect(JSON.parse(init.body as string)).toEqual({
      email: "seller@example.com",
      pubkey: session.pubkey,
    });
    expect(tagValue("action")).toBe("send_recovery_verification");
    expect(tagValue("email")).toBe("seller@example.com");
  });

  it("throws the server error message on failure", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: "Invalid email address" }, false, 400)
    );
    await expect(
      sendRecoveryVerificationCode(session, "seller@example.com")
    ).rejects.toThrow("Invalid email address");
  });
});

describe("confirmRecoverySetup", () => {
  it("sends the nsec in the body but never in the signed proof", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ success: true, recoveryKey: "RK-123" })
    );

    const result = await confirmRecoverySetup(
      session,
      "seller@example.com",
      "123456"
    );

    expect(result).toEqual({ recoveryKey: "RK-123" });
    const { url, init, signedEvent, tagValue } = lastCall();
    expect(url).toContain("/api/auth/setup-recovery");
    expect(JSON.parse(init.body as string)).toEqual({
      pubkey: session.pubkey,
      email: "seller@example.com",
      nsec: "nsec1test",
      verificationCode: "123456",
      authType: "nsec",
    });
    expect(tagValue("action")).toBe("setup_recovery");
    expect(tagValue("email")).toBe("seller@example.com");
    expect(tagValue("authType")).toBe("nsec");
    expect(tagValue("verificationCode")).toBe("123456");
    expect(JSON.stringify(signedEvent.tags)).not.toContain("nsec1test");
  });

  it("uses the session auth method as the auth type", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ success: true, recoveryKey: "RK-1" })
    );
    const emailSession = { ...session, authMethod: "email" } as SellerSession;
    await confirmRecoverySetup(emailSession, "seller@example.com", "123456");
    const { tagValue } = lastCall();
    expect(tagValue("authType")).toBe("email");
  });

  it("throws the server error message on failure", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: "Invalid verification code" }, false, 400)
    );
    await expect(
      confirmRecoverySetup(session, "seller@example.com", "000000")
    ).rejects.toThrow("Invalid verification code");
  });
});
