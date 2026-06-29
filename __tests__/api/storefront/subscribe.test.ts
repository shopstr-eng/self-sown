/** @jest-environment node */

import handler from "@/pages/api/storefront/subscribe";
import {
  fetchShopProfileByPubkeyFromDb,
  saveSubscriberEmailCapture,
  getEmailFlows,
  getFlowEnrollments,
  enrollInFlow,
  scheduleStepExecutions,
  cancelEnrollment,
} from "@/utils/db/db-service";
import { applyRateLimit } from "@/utils/rate-limit";
import { isPubkeyProEntitled } from "@/utils/pro/membership";
import { parseSellerShopProfileEvent } from "@milk-market/domain";

jest.mock("@/utils/db/db-service", () => ({
  fetchShopProfileByPubkeyFromDb: jest.fn(),
  saveSubscriberEmailCapture: jest.fn(),
  getEmailFlows: jest.fn(),
  getFlowEnrollments: jest.fn(),
  enrollInFlow: jest.fn(),
  scheduleStepExecutions: jest.fn(),
  cancelEnrollment: jest.fn(),
}));
jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: jest.fn(() => true),
}));
jest.mock("@/utils/pro/membership", () => ({
  isPubkeyProEntitled: jest.fn(),
}));
jest.mock("@milk-market/domain", () => ({
  parseSellerShopProfileEvent: jest.fn(),
}));

const mocked = {
  fetchShopProfileByPubkeyFromDb: fetchShopProfileByPubkeyFromDb as jest.Mock,
  saveSubscriberEmailCapture: saveSubscriberEmailCapture as jest.Mock,
  getEmailFlows: getEmailFlows as jest.Mock,
  getFlowEnrollments: getFlowEnrollments as jest.Mock,
  enrollInFlow: enrollInFlow as jest.Mock,
  scheduleStepExecutions: scheduleStepExecutions as jest.Mock,
  cancelEnrollment: cancelEnrollment as jest.Mock,
  applyRateLimit: applyRateLimit as jest.Mock,
  isPubkeyProEntitled: isPubkeyProEntitled as jest.Mock,
  parseSellerShopProfileEvent: parseSellerShopProfileEvent as jest.Mock,
};

const PUBKEY = "a".repeat(64);
const EMAIL = "buyer@example.com";

function createMockResponse() {
  const response = {
    statusCode: 200,
    body: undefined as unknown,
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

function subscriptionStorefront() {
  return {
    content: {
      storefront: {
        sections: [
          {
            type: "contact_form",
            enabled: true,
            contactFormMode: "subscription",
          },
        ],
        pages: [],
      },
    },
  };
}

function run(body: Record<string, unknown>, method = "POST") {
  const response = createMockResponse();
  return handler({ method, body } as any, response as any).then(() => response);
}

beforeEach(() => {
  jest.clearAllMocks();
  mocked.applyRateLimit.mockResolvedValue(true);
  mocked.fetchShopProfileByPubkeyFromDb.mockResolvedValue({ id: "evt" });
  mocked.parseSellerShopProfileEvent.mockReturnValue(subscriptionStorefront());
  mocked.saveSubscriberEmailCapture.mockResolvedValue(undefined);
  mocked.isPubkeyProEntitled.mockResolvedValue(false);
  mocked.getEmailFlows.mockResolvedValue([]);
  mocked.getFlowEnrollments.mockResolvedValue([]);
  mocked.cancelEnrollment.mockResolvedValue(undefined);
});

describe("storefront subscribe api", () => {
  test("rejects non-POST methods", async () => {
    const res = await run({}, "GET");
    expect(res.statusCode).toBe(405);
    expect(mocked.saveSubscriberEmailCapture).not.toHaveBeenCalled();
  });

  test("requires a valid seller pubkey", async () => {
    const res = await run({ sellerPubkey: "nope", email: EMAIL });
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: "Invalid seller" });
  });

  test("requires an email", async () => {
    const res = await run({ sellerPubkey: PUBKEY, email: "   " });
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: "Email is required" });
    expect(mocked.saveSubscriberEmailCapture).not.toHaveBeenCalled();
  });

  test("rejects malformed email addresses", async () => {
    const res = await run({ sellerPubkey: PUBKEY, email: "not-an-email" });
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: "Invalid email address" });
  });

  test("rejects sellers without an enabled subscription form", async () => {
    mocked.parseSellerShopProfileEvent.mockReturnValue({
      content: { storefront: { sections: [], pages: [] } },
    });
    const res = await run({ sellerPubkey: PUBKEY, email: EMAIL });
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({
      error: "This seller is not accepting subscriptions",
    });
    expect(mocked.saveSubscriberEmailCapture).not.toHaveBeenCalled();
  });

  test("accepts a subscription form enabled on a custom builder page", async () => {
    mocked.parseSellerShopProfileEvent.mockReturnValue({
      content: {
        storefront: {
          sections: [],
          pages: [
            {
              sections: [
                {
                  type: "contact_form",
                  enabled: true,
                  contactFormMode: "subscription",
                },
              ],
            },
          ],
        },
      },
    });
    const res = await run({ sellerPubkey: PUBKEY, email: EMAIL });
    expect(res.statusCode).toBe(200);
    expect(mocked.saveSubscriberEmailCapture).toHaveBeenCalledWith(
      PUBKEY,
      EMAIL,
      null
    );
  });

  test("saves the subscriber when the seller has no welcome series", async () => {
    mocked.isPubkeyProEntitled.mockResolvedValue(false);
    const res = await run({ sellerPubkey: PUBKEY, email: EMAIL, phone: "123" });
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(mocked.saveSubscriberEmailCapture).toHaveBeenCalledWith(
      PUBKEY,
      EMAIL,
      "123"
    );
    expect(mocked.enrollInFlow).not.toHaveBeenCalled();
  });

  test("does not enroll when there is no active welcome series flow", async () => {
    mocked.isPubkeyProEntitled.mockResolvedValue(true);
    mocked.getEmailFlows.mockResolvedValue([
      { id: 7, flow_type: "welcome_series", status: "paused" },
      { id: 8, flow_type: "abandoned_cart", status: "active" },
    ]);
    const res = await run({ sellerPubkey: PUBKEY, email: EMAIL });
    expect(res.statusCode).toBe(200);
    expect(mocked.enrollInFlow).not.toHaveBeenCalled();
  });

  test("enrolls and schedules steps when an active welcome series exists", async () => {
    mocked.isPubkeyProEntitled.mockResolvedValue(true);
    mocked.getEmailFlows.mockResolvedValue([
      {
        id: 42,
        flow_type: "welcome_series",
        status: "active",
        from_name: "Fresh Farm",
      },
    ]);
    mocked.getFlowEnrollments.mockResolvedValue([]);
    mocked.enrollInFlow.mockResolvedValue({ id: 99 });
    mocked.scheduleStepExecutions.mockResolvedValue(undefined);

    const res = await run({ sellerPubkey: PUBKEY, email: EMAIL });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(mocked.enrollInFlow).toHaveBeenCalledWith({
      flow_id: 42,
      recipient_email: EMAIL,
      recipient_pubkey: null,
      enrollment_data: { shop_name: "Fresh Farm" },
    });
    expect(mocked.scheduleStepExecutions).toHaveBeenCalledWith(99, 42);
    expect(mocked.cancelEnrollment).not.toHaveBeenCalled();
  });

  test("skips enrollment when the contact is already actively enrolled", async () => {
    mocked.isPubkeyProEntitled.mockResolvedValue(true);
    mocked.getEmailFlows.mockResolvedValue([
      { id: 42, flow_type: "welcome_series", status: "active" },
    ]);
    mocked.getFlowEnrollments.mockResolvedValue([
      { recipient_email: EMAIL.toUpperCase(), status: "active" },
    ]);

    const res = await run({ sellerPubkey: PUBKEY, email: EMAIL });

    expect(res.statusCode).toBe(200);
    expect(mocked.enrollInFlow).not.toHaveBeenCalled();
    expect(mocked.scheduleStepExecutions).not.toHaveBeenCalled();
  });

  test("cancels the enrollment when step scheduling throws", async () => {
    mocked.isPubkeyProEntitled.mockResolvedValue(true);
    mocked.getEmailFlows.mockResolvedValue([
      { id: 42, flow_type: "welcome_series", status: "active" },
    ]);
    mocked.getFlowEnrollments.mockResolvedValue([]);
    mocked.enrollInFlow.mockResolvedValue({ id: 99 });
    mocked.scheduleStepExecutions.mockRejectedValue(new Error("schedule boom"));

    const res = await run({ sellerPubkey: PUBKEY, email: EMAIL });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(mocked.cancelEnrollment).toHaveBeenCalledWith(99);
  });

  test("does not attempt rollback when the enrollment itself throws", async () => {
    mocked.isPubkeyProEntitled.mockResolvedValue(true);
    mocked.getEmailFlows.mockResolvedValue([
      { id: 42, flow_type: "welcome_series", status: "active" },
    ]);
    mocked.getFlowEnrollments.mockResolvedValue([]);
    mocked.enrollInFlow.mockRejectedValue(new Error("enroll boom"));

    const res = await run({ sellerPubkey: PUBKEY, email: EMAIL });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(mocked.scheduleStepExecutions).not.toHaveBeenCalled();
    expect(mocked.cancelEnrollment).not.toHaveBeenCalled();
  });

  test("still succeeds when the whole welcome-series check throws", async () => {
    mocked.isPubkeyProEntitled.mockRejectedValue(new Error("entitlement boom"));

    const res = await run({ sellerPubkey: PUBKEY, email: EMAIL });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(mocked.saveSubscriberEmailCapture).toHaveBeenCalled();
  });

  test("returns 500 when saving the subscriber fails", async () => {
    mocked.saveSubscriberEmailCapture.mockRejectedValue(new Error("db down"));
    const res = await run({ sellerPubkey: PUBKEY, email: EMAIL });
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: "Failed to subscribe" });
  });
});
