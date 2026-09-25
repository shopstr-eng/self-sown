/** @jest-environment node */

// Pins the drip-sequence (flow) send path's dead-address handling: a
// recipient-level SendGrid rejection (HTTP 400 blaming the `to` address, or a
// suppression-list hit) must DURABLY suppress the address into the seller's
// email_unsubscribes list so future flow steps stop re-attempting it —
// mirroring the blog/one-time broadcast path. Sender/account-level failures
// (403 lapsed domain auth, 400 on the from field, 5xx) must NEVER suppress
// anyone, because they fail every recipient identically.
// Only the SendGrid client boundary and the DB/service dependencies are
// mocked; the real classification helpers from email-service run.

import handler from "@/pages/api/email/flows/process";
import {
  getPendingExecutions,
  markExecutionSent,
  markExecutionFailed,
  fetchShopProfileByPubkeyFromDb,
  unsubscribeSellerEmail,
  isSellerEmailUnsubscribedStrict,
} from "@/utils/db/db-service";
import { resolveSellerSenderEmail } from "@/utils/db/email-sender-domains";
import { applyRateLimit } from "@/utils/rate-limit";
import { isPubkeyProEntitled } from "@/utils/pro/membership";

const mockSend: jest.Mock = jest.fn();

jest.mock("@/utils/db/db-service", () => ({
  getDbPool: jest.fn(),
  getPendingExecutions: jest.fn(),
  markExecutionSent: jest.fn(),
  markExecutionFailed: jest.fn(),
  fetchShopProfileByPubkeyFromDb: jest.fn(),
  unsubscribeSellerEmail: jest.fn(),
  isSellerEmailUnsubscribedStrict: jest.fn(),
}));
jest.mock("@/utils/email/sendgrid-client", () => ({
  getUncachableSendGridClient: jest.fn(async () => ({
    client: { send: (...args: unknown[]) => mockSend(...args) },
    fromEmail: "platform@selfsown.com",
  })),
}));
jest.mock("@/utils/db/email-sender-domains", () => ({
  resolveSellerSenderEmail: jest.fn(),
}));
jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: jest.fn(() => true),
}));
jest.mock("@/utils/pro/membership", () => ({
  isPubkeyProEntitled: jest.fn(async () => true),
}));
jest.mock("@/utils/email/flow-email-templates", () => ({
  renderFlowEmail: jest.fn((subject: string, html: string) => ({
    subject,
    html,
  })),
}));
jest.mock("@/utils/email/flow-link-tracking", () => ({
  rewriteFlowEmailLinks: jest.fn((html: string) => html),
}));
jest.mock("@/utils/email/flow-open-tracking", () => ({
  appendOpenPixel: jest.fn((html: string) => html),
}));

const mocked = {
  getPendingExecutions: getPendingExecutions as jest.Mock,
  markExecutionSent: markExecutionSent as jest.Mock,
  markExecutionFailed: markExecutionFailed as jest.Mock,
  fetchShopProfileByPubkeyFromDb: fetchShopProfileByPubkeyFromDb as jest.Mock,
  unsubscribeSellerEmail: unsubscribeSellerEmail as jest.Mock,
  isSellerEmailUnsubscribedStrict: isSellerEmailUnsubscribedStrict as jest.Mock,
  resolveSellerSenderEmail: resolveSellerSenderEmail as jest.Mock,
  applyRateLimit: applyRateLimit as jest.Mock,
  isPubkeyProEntitled: isPubkeyProEntitled as jest.Mock,
};

const PUBKEY = "a".repeat(64);
const SECRET = "flow-secret";

function execution(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    enrollment_id: 10,
    step_id: 20,
    status: "pending",
    scheduled_for: new Date().toISOString(),
    recipient_email: "buyer@example.com",
    recipient_pubkey: null,
    enrollment_data: {},
    subject: "Hello",
    body_html: "<p>hi</p>",
    flow_id: 30,
    seller_pubkey: PUBKEY,
    flow_type: "welcome",
    from_name: "Shop",
    reply_to: null,
    ...overrides,
  };
}

function sgError(
  status: number,
  errors?: Array<{ field?: string; message?: string }>
) {
  const err: any = new Error(`SendGrid ${status}`);
  err.code = status;
  err.response = {
    statusCode: status,
    body: errors ? { errors } : { errors: [] },
  };
  return err;
}

function createMockResponse() {
  const response = {
    statusCode: 200,
    body: undefined as any,
    status(code: number) {
      response.statusCode = code;
      return response;
    },
    json(payload: unknown) {
      response.body = payload;
      return response;
    },
  };
  return response;
}

function run(body: unknown = {}) {
  const req = {
    method: "POST",
    headers: { "x-flow-processor-secret": SECRET },
    body,
  } as any;
  const res = createMockResponse();
  return handler(req, res as any).then(() => res);
}

const ORIGINAL_SECRET = process.env.FLOW_PROCESSOR_SECRET;

beforeAll(() => {
  process.env.FLOW_PROCESSOR_SECRET = SECRET;
});

afterAll(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.FLOW_PROCESSOR_SECRET;
  else process.env.FLOW_PROCESSOR_SECRET = ORIGINAL_SECRET;
});

beforeEach(() => {
  jest.clearAllMocks();
  mocked.applyRateLimit.mockReturnValue(true);
  mocked.isPubkeyProEntitled.mockResolvedValue(true);
  mocked.getPendingExecutions.mockResolvedValue([execution()]);
  mocked.fetchShopProfileByPubkeyFromDb.mockResolvedValue(null);
  mocked.resolveSellerSenderEmail.mockResolvedValue(null);
  mocked.unsubscribeSellerEmail.mockResolvedValue(true);
  mocked.isSellerEmailUnsubscribedStrict.mockResolvedValue(false);
  mocked.markExecutionSent.mockResolvedValue(undefined);
  mocked.markExecutionFailed.mockResolvedValue(undefined);
  mockSend.mockResolvedValue(undefined);
});

it("marks the execution sent on a successful send and stamps the seller_pubkey custom arg for webhook attribution", async () => {
  const res = await run();
  expect(res.statusCode).toBe(200);
  expect(res.body).toMatchObject({ processed: 1, sent: 1, failed: 0 });
  expect(mocked.markExecutionSent).toHaveBeenCalledWith(1);
  expect(mocked.unsubscribeSellerEmail).not.toHaveBeenCalled();
  expect(mockSend).toHaveBeenCalledTimes(1);
  expect(mockSend.mock.calls[0][0].customArgs).toEqual({
    seller_pubkey: PUBKEY,
  });
});

it("durably suppresses the address when SendGrid rejects the recipient address (400 on the to field)", async () => {
  mockSend.mockRejectedValue(
    sgError(400, [
      {
        field: "personalizations.0.to.0.email",
        message: "Does not contain a valid address.",
      },
    ])
  );
  const res = await run();
  expect(res.statusCode).toBe(200);
  expect(res.body).toMatchObject({ processed: 1, sent: 0, failed: 1 });
  expect(mocked.unsubscribeSellerEmail).toHaveBeenCalledWith(
    PUBKEY,
    "buyer@example.com",
    "suppressed"
  );
  expect(mocked.markExecutionFailed).toHaveBeenCalledWith(
    1,
    expect.stringContaining("400")
  );
});

it("durably suppresses on a suppression-list rejection naming the to address", async () => {
  mockSend.mockRejectedValue(
    sgError(400, [
      { message: "The to address is on the suppression list." },
    ])
  );
  await run();
  expect(mocked.unsubscribeSellerEmail).toHaveBeenCalledWith(
    PUBKEY,
    "buyer@example.com",
    "suppressed"
  );
});

it("does NOT suppress on a sender-level 400 (from field) — it would hit every recipient identically", async () => {
  mockSend.mockRejectedValue(
    sgError(400, [
      {
        field: "from.email",
        message: "The from address does not match a verified sender.",
      },
    ])
  );
  const res = await run();
  expect(res.body).toMatchObject({ sent: 0, failed: 1 });
  expect(mocked.unsubscribeSellerEmail).not.toHaveBeenCalled();
});

it.each([500, 429])(
  "does NOT suppress on ambiguous/retryable %i failures",
  async (status) => {
    mockSend.mockRejectedValue(sgError(status, [{ field: "to", message: "x" }]));
    await run();
    expect(mocked.unsubscribeSellerEmail).not.toHaveBeenCalled();
  }
);

it("still falls back to the global sender on an unverified-sender rejection, and does not treat that as a dead address", async () => {
  mocked.resolveSellerSenderEmail.mockResolvedValue("shop@verified.example");
  mockSend
    .mockRejectedValueOnce(
      sgError(403, [
        { message: "The from address does not match a verified Sender Identity." },
      ])
    )
    .mockResolvedValueOnce(undefined);
  const res = await run();
  expect(res.body).toMatchObject({ sent: 1, failed: 0 });
  expect(mockSend).toHaveBeenCalledTimes(2);
  expect(mockSend.mock.calls[1][0].from).toEqual({
    email: "platform@selfsown.com",
    name: "Shop",
  });
  expect(mocked.unsubscribeSellerEmail).not.toHaveBeenCalled();
  expect(mocked.markExecutionSent).toHaveBeenCalledWith(1);
});

it("suppresses when the custom-sender send 403s and the global-sender RETRY hits a recipient-level reject", async () => {
  mocked.resolveSellerSenderEmail.mockResolvedValue("shop@verified.example");
  mockSend
    .mockRejectedValueOnce(
      sgError(403, [
        { message: "The from address does not match a verified Sender Identity." },
      ])
    )
    .mockRejectedValueOnce(
      sgError(400, [
        {
          field: "personalizations.0.to.0.email",
          message: "Does not contain a valid address.",
        },
      ])
    );
  const res = await run();
  expect(res.body).toMatchObject({ sent: 0, failed: 1 });
  expect(mocked.unsubscribeSellerEmail).toHaveBeenCalledWith(
    PUBKEY,
    "buyer@example.com",
    "suppressed"
  );
});

it("skips an execution whose recipient is already on the seller's suppression list — SendGrid is never called", async () => {
  mocked.isSellerEmailUnsubscribedStrict.mockResolvedValue(true);
  const res = await run();
  expect(res.statusCode).toBe(200);
  expect(res.body).toMatchObject({ processed: 1, sent: 0, failed: 0 });
  expect(res.body.results[0].status).toBe("skipped");
  expect(mockSend).not.toHaveBeenCalled();
  expect(mocked.markExecutionSent).not.toHaveBeenCalled();
  // Leaves the pending queue so it isn't re-attempted forever.
  expect(mocked.markExecutionFailed).toHaveBeenCalledWith(
    1,
    expect.stringContaining("unsubscribed")
  );
});

it("fails CLOSED when the suppression check itself errors (null) — no send on a guess", async () => {
  mocked.isSellerEmailUnsubscribedStrict.mockResolvedValue(null);
  const res = await run();
  expect(res.body).toMatchObject({ processed: 1, sent: 0, failed: 1 });
  expect(mockSend).not.toHaveBeenCalled();
  expect(mocked.markExecutionFailed).toHaveBeenCalledWith(
    1,
    expect.stringContaining("Suppression check failed")
  );
});

it("a recipient-level reject on one step suppresses the address for a LATER step in the same batch", async () => {
  // Two due steps for the same dead address (e.g. a multi-step sequence).
  mocked.getPendingExecutions.mockResolvedValue([
    execution({ id: 1, step_id: 20 }),
    execution({ id: 2, step_id: 21 }),
  ]);
  // The check reflects the suppression recorded by step 1's failure.
  mocked.isSellerEmailUnsubscribedStrict
    .mockResolvedValueOnce(false) // step 1: not yet suppressed
    .mockResolvedValueOnce(true); // step 2: suppressed by step 1's reject
  mockSend.mockRejectedValueOnce(
    sgError(400, [
      {
        field: "personalizations.0.to.0.email",
        message: "Does not contain a valid address.",
      },
    ])
  );
  const res = await run();
  expect(res.body).toMatchObject({ processed: 2, sent: 0, failed: 1 });
  expect(res.body.results).toEqual([
    { execution_id: 1, status: "failed", error: expect.any(String) },
    { execution_id: 2, status: "skipped" },
  ]);
  // SendGrid was attempted exactly once — the second step never left our side.
  expect(mockSend).toHaveBeenCalledTimes(1);
  expect(mocked.unsubscribeSellerEmail).toHaveBeenCalledTimes(1);
  expect(mocked.unsubscribeSellerEmail).toHaveBeenCalledWith(
    PUBKEY,
    "buyer@example.com",
    "suppressed"
  );
});

it("a suppression recorded by the bounce webhook before this batch (async bounce path) skips the send", async () => {
  // Webhook already wrote the suppression row; the flow processor must honor
  // it without any SendGrid round-trip.
  mocked.isSellerEmailUnsubscribedStrict.mockResolvedValue(true);
  const res = await run();
  expect(mockSend).not.toHaveBeenCalled();
  expect(res.body.results[0].status).toBe("skipped");
});

it("a suppressed recipient does not block other recipients in the batch", async () => {
  mocked.getPendingExecutions.mockResolvedValue([
    execution({ id: 1, recipient_email: "dead@example.com" }),
    execution({ id: 2, recipient_email: "live@example.com" }),
  ]);
  mocked.isSellerEmailUnsubscribedStrict.mockImplementation(
    async (_pk: string, email: string) => email === "dead@example.com"
  );
  const res = await run();
  expect(res.body).toMatchObject({ processed: 2, sent: 1, failed: 0 });
  expect(res.body.results).toEqual([
    { execution_id: 1, status: "skipped" },
    { execution_id: 2, status: "sent" },
  ]);
  expect(mockSend).toHaveBeenCalledTimes(1);
  expect(mockSend.mock.calls[0][0].to).toBe("live@example.com");
});

it("still fails the execution when the suppression write itself fails (best-effort)", async () => {
  mocked.unsubscribeSellerEmail.mockResolvedValue(false);
  mockSend.mockRejectedValue(
    sgError(400, [
      {
        field: "personalizations.0.to.0.email",
        message: "Does not contain a valid address.",
      },
    ])
  );
  const res = await run();
  expect(res.body).toMatchObject({ sent: 0, failed: 1 });
  expect(mocked.markExecutionFailed).toHaveBeenCalledWith(
    1,
    expect.stringContaining("400")
  );
});
