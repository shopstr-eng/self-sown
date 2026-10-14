/** @jest-environment node */

// The recovery endpoints must require a kind-27235 signed proof of pubkey
// ownership before touching the database or sending email. These tests mock
// the proof verifier to assert each endpoint (a) calls it with the correct
// expected proof shape and (b) refuses the request when verification fails.

const applyRateLimitMock = jest.fn();
const recoverySetupVerifyLimiterMock = jest.fn();
const verifySignedHttpRequestProofMock = jest.fn();
const extractSignedEventFromRequestMock = jest.fn();
const sendEmailMock = jest.fn();
const pgQueryMock = jest.fn();
const pgConnectMock = jest.fn();
const pgEndMock = jest.fn();

jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: (...args: unknown[]) => applyRateLimitMock(...args),
}));

jest.mock("@/utils/auth/rate-limit", () => ({
  recoverySetupVerifyLimiter: (...args: unknown[]) =>
    recoverySetupVerifyLimiterMock(...args),
}));

jest.mock("@/utils/nostr/request-auth", () => ({
  ...jest.requireActual("@/utils/nostr/request-auth"),
  verifySignedHttpRequestProof: (...args: unknown[]) =>
    verifySignedHttpRequestProofMock(...args),
  extractSignedEventFromRequest: (...args: unknown[]) =>
    extractSignedEventFromRequestMock(...args),
}));

jest.mock("@/utils/email/email-service", () => ({
  sendEmail: (...args: unknown[]) => sendEmailMock(...args),
}));

jest.mock("pg", () => ({
  Client: jest.fn().mockImplementation(() => ({
    connect: pgConnectMock,
    query: pgQueryMock,
    end: pgEndMock,
  })),
}));

import checkRecoveryHandler from "@/pages/api/auth/check-recovery";
import sendVerificationHandler from "@/pages/api/auth/send-recovery-verification";
import setupRecoveryHandler from "@/pages/api/auth/setup-recovery";

function createResponse() {
  return {
    statusCode: 200,
    jsonBody: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.jsonBody = payload;
      return this;
    },
  };
}

function createRequest(body: Record<string, unknown>) {
  return { method: "POST", headers: {}, body };
}

const PUBKEY = "b".repeat(64);
const EMAIL = "seller@example.com";

function expectedProofs() {
  return verifySignedHttpRequestProofMock.mock.calls.map(
    (call) => call[1] as Record<string, unknown>
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  applyRateLimitMock.mockResolvedValue(true);
  recoverySetupVerifyLimiterMock.mockResolvedValue(true);
  extractSignedEventFromRequestMock.mockReturnValue({ id: "evt" });
  verifySignedHttpRequestProofMock.mockReturnValue({ ok: true, status: 200 });
  pgConnectMock.mockResolvedValue(undefined);
  pgEndMock.mockResolvedValue(undefined);
  sendEmailMock.mockResolvedValue(undefined);
  pgQueryMock.mockResolvedValue({ rows: [] });
});

describe("check-recovery proof enforcement", () => {
  it("verifies a check_recovery proof before querying", async () => {
    const res = createResponse();
    await checkRecoveryHandler(
      createRequest({ pubkey: PUBKEY }) as never,
      res as never
    );

    expect(verifySignedHttpRequestProofMock).toHaveBeenCalledTimes(1);
    expect(expectedProofs()[0]).toEqual({
      action: "check_recovery",
      method: "POST",
      path: "/api/auth/check-recovery",
      pubkey: PUBKEY,
    });
    expect(res.statusCode).toBe(200);
  });

  it("rejects with 401 when the proof fails and never queries", async () => {
    verifySignedHttpRequestProofMock.mockReturnValue({
      ok: false,
      status: 401,
      error: "Invalid signed request proof or pubkey mismatch.",
    });
    const res = createResponse();
    await checkRecoveryHandler(
      createRequest({ pubkey: PUBKEY }) as never,
      res as never
    );

    expect(res.statusCode).toBe(401);
    expect(res.jsonBody).toEqual({
      error: "Invalid signed request proof or pubkey mismatch.",
    });
    expect(pgConnectMock).not.toHaveBeenCalled();
  });
});

describe("send-recovery-verification proof enforcement", () => {
  it("binds the email in the expected proof", async () => {
    const res = createResponse();
    await sendVerificationHandler(
      createRequest({ pubkey: PUBKEY, email: EMAIL }) as never,
      res as never
    );

    expect(expectedProofs()[0]).toEqual({
      action: "send_recovery_verification",
      method: "POST",
      path: "/api/auth/send-recovery-verification",
      pubkey: PUBKEY,
      fields: { email: EMAIL },
    });
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
  });

  it("rejects when the proof fails and sends no email", async () => {
    verifySignedHttpRequestProofMock.mockReturnValue({
      ok: false,
      status: 401,
      error: "Signed request proof does not match this operation.",
    });
    const res = createResponse();
    await sendVerificationHandler(
      createRequest({ pubkey: PUBKEY, email: EMAIL }) as never,
      res as never
    );

    expect(res.statusCode).toBe(401);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(pgConnectMock).not.toHaveBeenCalled();
  });
});

describe("setup-recovery proof enforcement", () => {
  const body = {
    pubkey: PUBKEY,
    email: EMAIL,
    nsec: "nsec1secret",
    verificationCode: "123456",
    authType: "nsec",
  };

  it("binds email, authType, and verificationCode — never the nsec", async () => {
    pgQueryMock.mockResolvedValueOnce({
      rows: [
        {
          id: 1,
          verified_email: EMAIL,
          code: "123456",
          expires_at: new Date(Date.now() + 60000),
          used: false,
        },
      ],
    });
    const res = createResponse();
    await setupRecoveryHandler(createRequest(body) as never, res as never);

    const proof = expectedProofs()[0] as { fields: Record<string, string> };
    expect(proof).toMatchObject({
      action: "setup_recovery",
      method: "POST",
      path: "/api/auth/setup-recovery",
      pubkey: PUBKEY,
    });
    expect(proof.fields).toEqual({
      email: EMAIL,
      authType: "nsec",
      verificationCode: "123456",
    });
    expect(JSON.stringify(proof)).not.toContain("nsec1secret");
    expect(res.statusCode).toBe(200);
    expect((res.jsonBody as { recoveryKey?: string }).recoveryKey).toBeTruthy();
  });

  it("rejects when the proof fails and stores nothing", async () => {
    verifySignedHttpRequestProofMock.mockReturnValue({
      ok: false,
      status: 401,
      error:
        "A signed Nostr request proof is required to prove pubkey ownership.",
    });
    const res = createResponse();
    await setupRecoveryHandler(createRequest(body) as never, res as never);

    expect(res.statusCode).toBe(401);
    expect(pgConnectMock).not.toHaveBeenCalled();
  });

  it("still rejects invalid auth types before proof verification", async () => {
    const res = createResponse();
    await setupRecoveryHandler(
      createRequest({ ...body, authType: "carrier-pigeon" }) as never,
      res as never
    );

    expect(res.statusCode).toBe(400);
    expect(verifySignedHttpRequestProofMock).not.toHaveBeenCalled();
  });
});
