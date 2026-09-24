// Unit-pins the failure classification of sendEmailStrictFromDetailed —
// the flag the blog broadcast uses to decide whether a rejected address is
// DURABLY SUPPRESSED (email_unsubscribes) or merely released for a retry.
// The classification is safety-critical in both directions:
//   - a false POSITIVE (recipientReject on a sender/account-level failure)
//     would wipe a seller's whole audience when e.g. their domain
//     authentication lapses and SendGrid 403s every recipient identically;
//   - a false NEGATIVE (missing a genuinely dead address) re-burns SendGrid
//     quota and sender reputation on every broadcast retry.
// Only the SendGrid client boundary is mocked.

const mockSend: jest.Mock = jest.fn();

jest.mock("@/utils/email/sendgrid-client", () => ({
  getUncachableSendGridClient: async () => ({
    client: { send: (...args: unknown[]) => mockSend(...args) },
    fromEmail: "platform@selfsown.com",
  }),
}));

import { sendEmailStrictFromDetailed } from "@/utils/email/email-service";

const PARAMS = {
  to: "someone@example.com",
  subject: "s",
  html: "<p>h</p>",
  fromEmail: "shop@verified.example",
};

function sgError(status: number, errors?: Array<{ field?: string; message?: string }>) {
  const err: any = new Error(`SendGrid ${status}`);
  err.code = status;
  err.response = {
    statusCode: status,
    body: errors ? { errors } : { errors: [] },
  };
  return err;
}

beforeEach(() => {
  mockSend.mockReset();
  mockSend.mockResolvedValue(undefined);
});

it("accepts a successful send", async () => {
  await expect(sendEmailStrictFromDetailed(PARAMS)).resolves.toEqual({
    ok: true,
    definiteReject: false,
    recipientReject: false,
  });
});

it("400 blaming the to field is a recipient-level reject", async () => {
  mockSend.mockRejectedValue(
    sgError(400, [
      {
        field: "personalizations.0.to.0.email",
        message: "Does not contain a valid address.",
      },
    ])
  );
  await expect(sendEmailStrictFromDetailed(PARAMS)).resolves.toEqual({
    ok: false,
    definiteReject: true,
    recipientReject: true,
  });
});

it("400 reporting a suppression-list hit is a recipient-level reject", async () => {
  mockSend.mockRejectedValue(
    sgError(400, [{ message: "The to address is on the suppression list." }])
  );
  const result = await sendEmailStrictFromDetailed(PARAMS);
  expect(result.ok).toBe(false);
  expect(result.definiteReject).toBe(true);
  expect(result.recipientReject).toBe(true);
});

it("400 blaming the FROM field is definite but NOT recipient-level (sender problem fails everyone identically)", async () => {
  mockSend.mockRejectedValue(
    sgError(400, [
      {
        field: "from.email",
        message: "The from address does not match a verified sender.",
      },
    ])
  );
  const result = await sendEmailStrictFromDetailed(PARAMS);
  expect(result.ok).toBe(false);
  expect(result.definiteReject).toBe(true);
  expect(result.recipientReject).toBe(false);
});

it("400 on the FROM field with 'invalid email' wording is still NOT recipient-level (that wording is used for the sender too)", async () => {
  mockSend.mockRejectedValue(
    sgError(400, [
      { field: "from.email", message: "Invalid email address in the from field." },
    ])
  );
  const result = await sendEmailStrictFromDetailed(PARAMS);
  expect(result.definiteReject).toBe(true);
  expect(result.recipientReject).toBe(false);
});

it("400 on a non-to personalization field (subject) is NOT recipient-level", async () => {
  mockSend.mockRejectedValue(
    sgError(400, [
      {
        field: "personalizations.0.subject",
        message: "The subject is invalid.",
      },
    ])
  );
  const result = await sendEmailStrictFromDetailed(PARAMS);
  expect(result.definiteReject).toBe(true);
  expect(result.recipientReject).toBe(false);
});

it("400 with a suppression-list message that does NOT name the recipient is NOT recipient-level (ambiguous wording never suppresses)", async () => {
  mockSend.mockRejectedValue(
    sgError(400, [{ message: "Address is on a suppression list." }])
  );
  const result = await sendEmailStrictFromDetailed(PARAMS);
  expect(result.definiteReject).toBe(true);
  expect(result.recipientReject).toBe(false);
});

it("403 (lapsed domain auth) is definite but NOT recipient-level — it would hit every recipient", async () => {
  mockSend.mockRejectedValue(
    sgError(403, [{ message: "The from address does not match a verified Sender Identity." }])
  );
  const result = await sendEmailStrictFromDetailed(PARAMS);
  expect(result.definiteReject).toBe(true);
  expect(result.recipientReject).toBe(false);
});

it.each([408, 429])("retryable %i is neither definite nor recipient-level", async (status) => {
  mockSend.mockRejectedValue(sgError(status, [{ field: "to", message: "x" }]));
  const result = await sendEmailStrictFromDetailed(PARAMS);
  expect(result).toEqual({
    ok: false,
    definiteReject: false,
    recipientReject: false,
  });
});

it("500 is ambiguous (SendGrid may have accepted it)", async () => {
  mockSend.mockRejectedValue(sgError(500, [{ field: "to", message: "x" }]));
  const result = await sendEmailStrictFromDetailed(PARAMS);
  expect(result).toEqual({
    ok: false,
    definiteReject: false,
    recipientReject: false,
  });
});

it("a thrown network error with no status is ambiguous", async () => {
  mockSend.mockRejectedValue(new Error("socket hang up"));
  const result = await sendEmailStrictFromDetailed(PARAMS);
  expect(result).toEqual({
    ok: false,
    definiteReject: false,
    recipientReject: false,
  });
});

it("400 with an unparseable body is definite but NOT recipient-level (conservative)", async () => {
  const err: any = new Error("bad request");
  err.code = 400;
  err.response = { statusCode: 400, body: "not json" };
  mockSend.mockRejectedValue(err);
  const result = await sendEmailStrictFromDetailed(PARAMS);
  expect(result).toEqual({
    ok: false,
    definiteReject: true,
    recipientReject: false,
  });
});
