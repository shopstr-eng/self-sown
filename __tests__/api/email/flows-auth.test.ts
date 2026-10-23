const verifyNip98RequestMock = jest.fn();
const requireProEntitlementMock = jest.fn();
const db = {
  getEmailFlows: jest.fn(),
  getEmailFlow: jest.fn(),
  createEmailFlow: jest.fn(),
  createFlowStep: jest.fn(),
  getFlowSteps: jest.fn(),
  updateFlowStep: jest.fn(),
  deleteFlowStep: jest.fn(),
  reorderFlowSteps: jest.fn(),
  updateEmailFlow: jest.fn(),
  deleteEmailFlow: jest.fn(),
};

jest.mock("@/utils/db/db-service", () => ({
  getEmailFlows: (...args: unknown[]) => db.getEmailFlows(...args),
  getEmailFlow: (...args: unknown[]) => db.getEmailFlow(...args),
  createEmailFlow: (...args: unknown[]) => db.createEmailFlow(...args),
  createFlowStep: (...args: unknown[]) => db.createFlowStep(...args),
  getFlowSteps: (...args: unknown[]) => db.getFlowSteps(...args),
  updateFlowStep: (...args: unknown[]) => db.updateFlowStep(...args),
  deleteFlowStep: (...args: unknown[]) => db.deleteFlowStep(...args),
  reorderFlowSteps: (...args: unknown[]) => db.reorderFlowSteps(...args),
  updateEmailFlow: (...args: unknown[]) => db.updateEmailFlow(...args),
  deleteEmailFlow: (...args: unknown[]) => db.deleteEmailFlow(...args),
}));

jest.mock("@/utils/pro/require-pro", () => ({
  requireProEntitlement: (...args: unknown[]) =>
    requireProEntitlementMock(...args),
}));

jest.mock("@/utils/nostr/nip98-auth", () => ({
  verifyNip98Request: (...args: unknown[]) => verifyNip98RequestMock(...args),
}));

import flowsHandler from "@/pages/api/email/flows/index";
import flowByIdHandler from "@/pages/api/email/flows/[flowId]";
import stepsHandler from "@/pages/api/email/flows/[flowId]/steps";
import stepByIdHandler from "@/pages/api/email/flows/[flowId]/steps/[stepId]";
import toggleHandler from "@/pages/api/email/flows/[flowId]/toggle";
import { __resetRateLimitBuckets } from "@/utils/rate-limit";

const owner = "a".repeat(64);
const other = "b".repeat(64);
const ownerFlow = {
  id: 7,
  seller_pubkey: owner,
  name: "Welcome",
  flow_type: "welcome_series",
  status: "active",
  from_name: "Shop",
  reply_to: null,
};

function createRequest(opts: {
  method: string;
  body?: unknown;
  query?: Record<string, string>;
  authed?: boolean;
}) {
  return {
    method: opts.method,
    headers:
      opts.authed === false ? {} : { authorization: "Nostr signed-proof" },
    socket: { remoteAddress: "127.0.0.1" },
    body: opts.body,
    query: opts.query ?? {},
  } as any;
}

function createResponse() {
  return {
    statusCode: 200,
    jsonBody: undefined as unknown,
    headers: {} as Record<string, string>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    setHeader(key: string, value: string) {
      this.headers[key] = value;
      return this;
    },
    json(payload: unknown) {
      this.jsonBody = payload;
      return this;
    },
  };
}

describe("email flow routes NIP-98 gating", () => {
  beforeEach(() => {
    __resetRateLimitBuckets();
    jest.clearAllMocks();
    verifyNip98RequestMock.mockResolvedValue({ ok: true, pubkey: owner });
    requireProEntitlementMock.mockResolvedValue(true);
    db.getEmailFlow.mockResolvedValue(ownerFlow);
    db.getEmailFlows.mockResolvedValue([ownerFlow]);
    db.getFlowSteps.mockResolvedValue([]);
    db.createEmailFlow.mockResolvedValue({ ...ownerFlow, id: 8 });
    db.updateEmailFlow.mockResolvedValue(ownerFlow);
  });

  describe("GET /api/email/flows (list)", () => {
    it("rejects unauthenticated requests", async () => {
      verifyNip98RequestMock.mockResolvedValue({
        ok: false,
        error: "Missing NIP-98 authorization header",
      });
      const res = createResponse();
      await flowsHandler(
        createRequest({
          method: "GET",
          query: { seller_pubkey: owner },
          authed: false,
        }),
        res as any
      );
      expect(res.statusCode).toBe(401);
      expect(db.getEmailFlows).not.toHaveBeenCalled();
    });

    it("rejects when the queried pubkey is not the signer", async () => {
      const res = createResponse();
      await flowsHandler(
        createRequest({ method: "GET", query: { seller_pubkey: other } }),
        res as any
      );
      expect(res.statusCode).toBe(403);
      expect(db.getEmailFlows).not.toHaveBeenCalled();
    });

    it("returns only the signer's flows", async () => {
      const res = createResponse();
      await flowsHandler(
        createRequest({ method: "GET", query: { seller_pubkey: owner } }),
        res as any
      );
      expect(res.statusCode).toBe(200);
      expect(db.getEmailFlows).toHaveBeenCalledWith(owner);
      expect((res.jsonBody as any).flows).toHaveLength(1);
    });
  });

  describe("POST /api/email/flows (create)", () => {
    const body = {
      seller_pubkey: owner,
      name: "Winback",
      flow_type: "winback",
      use_defaults: false,
    };

    it("rejects unauthenticated requests", async () => {
      verifyNip98RequestMock.mockResolvedValue({
        ok: false,
        error: "Missing NIP-98 authorization header",
      });
      const res = createResponse();
      await flowsHandler(
        createRequest({ method: "POST", body, authed: false }),
        res as any
      );
      expect(res.statusCode).toBe(401);
      expect(db.createEmailFlow).not.toHaveBeenCalled();
    });

    it("rejects creating a flow under someone else's pubkey", async () => {
      const res = createResponse();
      await flowsHandler(
        createRequest({
          method: "POST",
          body: { ...body, seller_pubkey: other },
        }),
        res as any
      );
      expect(res.statusCode).toBe(403);
      expect(db.createEmailFlow).not.toHaveBeenCalled();
    });

    it("creates the flow owned by the signer", async () => {
      const res = createResponse();
      await flowsHandler(createRequest({ method: "POST", body }), res as any);
      expect(res.statusCode).toBe(201);
      expect(db.createEmailFlow).toHaveBeenCalledWith(
        expect.objectContaining({ seller_pubkey: owner })
      );
    });
  });

  describe("/api/email/flows/[flowId]", () => {
    it("GET rejects unauthenticated requests", async () => {
      verifyNip98RequestMock.mockResolvedValue({
        ok: false,
        error: "Missing NIP-98 authorization header",
      });
      const res = createResponse();
      await flowByIdHandler(
        createRequest({
          method: "GET",
          query: { flowId: "7", seller_pubkey: owner },
          authed: false,
        }),
        res as any
      );
      expect(res.statusCode).toBe(401);
    });

    it("GET rejects reading another seller's flow", async () => {
      db.getEmailFlow.mockResolvedValue({ ...ownerFlow, seller_pubkey: other });
      const res = createResponse();
      await flowByIdHandler(
        createRequest({
          method: "GET",
          query: { flowId: "7", seller_pubkey: owner },
        }),
        res as any
      );
      expect(res.statusCode).toBe(403);
    });

    it("GET returns the owner's flow", async () => {
      const res = createResponse();
      await flowByIdHandler(
        createRequest({
          method: "GET",
          query: { flowId: "7", seller_pubkey: owner },
        }),
        res as any
      );
      expect(res.statusCode).toBe(200);
      expect((res.jsonBody as any).flow.id).toBe(7);
    });

    it("PUT rejects unauthenticated requests", async () => {
      verifyNip98RequestMock.mockResolvedValue({
        ok: false,
        error: "Missing NIP-98 authorization header",
      });
      const res = createResponse();
      await flowByIdHandler(
        createRequest({
          method: "PUT",
          query: { flowId: "7" },
          body: { seller_pubkey: owner, from_name: "X" },
          authed: false,
        }),
        res as any
      );
      expect(res.statusCode).toBe(401);
      expect(db.updateEmailFlow).not.toHaveBeenCalled();
    });

    it("PUT updates the owner's flow", async () => {
      const res = createResponse();
      await flowByIdHandler(
        createRequest({
          method: "PUT",
          query: { flowId: "7" },
          body: { seller_pubkey: owner, from_name: "New Name" },
        }),
        res as any
      );
      expect(res.statusCode).toBe(200);
      expect(db.updateEmailFlow).toHaveBeenCalled();
    });

    it("DELETE rejects unauthenticated requests", async () => {
      verifyNip98RequestMock.mockResolvedValue({
        ok: false,
        error: "Missing NIP-98 authorization header",
      });
      const res = createResponse();
      await flowByIdHandler(
        createRequest({
          method: "DELETE",
          query: { flowId: "7", seller_pubkey: owner },
          authed: false,
        }),
        res as any
      );
      expect(res.statusCode).toBe(401);
      expect(db.deleteEmailFlow).not.toHaveBeenCalled();
    });

    it("DELETE removes the owner's flow", async () => {
      const res = createResponse();
      await flowByIdHandler(
        createRequest({
          method: "DELETE",
          query: { flowId: "7", seller_pubkey: owner },
        }),
        res as any
      );
      expect(res.statusCode).toBe(200);
      expect(db.deleteEmailFlow).toHaveBeenCalledWith(7);
    });
  });

  describe("/api/email/flows/[flowId]/steps", () => {
    it("GET rejects unauthenticated requests", async () => {
      verifyNip98RequestMock.mockResolvedValue({
        ok: false,
        error: "Missing NIP-98 authorization header",
      });
      const res = createResponse();
      await stepsHandler(
        createRequest({
          method: "GET",
          query: { flowId: "7", seller_pubkey: owner },
          authed: false,
        }),
        res as any
      );
      expect(res.statusCode).toBe(401);
      expect(db.getFlowSteps).not.toHaveBeenCalled();
    });

    it("POST rejects writing to another seller's flow", async () => {
      db.getEmailFlow.mockResolvedValue({ ...ownerFlow, seller_pubkey: other });
      const res = createResponse();
      await stepsHandler(
        createRequest({
          method: "POST",
          query: { flowId: "7" },
          body: { seller_pubkey: owner, subject: "s", body_html: "<p>x</p>" },
        }),
        res as any
      );
      expect(res.statusCode).toBe(403);
      expect(db.createFlowStep).not.toHaveBeenCalled();
    });

    it("POST creates a step on the owner's flow", async () => {
      db.createFlowStep.mockResolvedValue({ id: 3, step_order: 1 });
      const res = createResponse();
      await stepsHandler(
        createRequest({
          method: "POST",
          query: { flowId: "7" },
          body: { seller_pubkey: owner, subject: "s", body_html: "<p>x</p>" },
        }),
        res as any
      );
      expect(res.statusCode).toBe(201);
      expect(db.createFlowStep).toHaveBeenCalledWith(
        expect.objectContaining({ flow_id: 7 })
      );
    });
  });

  describe("/api/email/flows/[flowId]/steps/[stepId]", () => {
    it("PUT rejects unauthenticated requests", async () => {
      verifyNip98RequestMock.mockResolvedValue({
        ok: false,
        error: "Missing NIP-98 authorization header",
      });
      const res = createResponse();
      await stepByIdHandler(
        createRequest({
          method: "PUT",
          query: { flowId: "7", stepId: "3" },
          body: { seller_pubkey: owner, subject: "s" },
          authed: false,
        }),
        res as any
      );
      expect(res.statusCode).toBe(401);
      expect(db.updateFlowStep).not.toHaveBeenCalled();
    });

    it("DELETE rejects unauthenticated requests", async () => {
      verifyNip98RequestMock.mockResolvedValue({
        ok: false,
        error: "Missing NIP-98 authorization header",
      });
      const res = createResponse();
      await stepByIdHandler(
        createRequest({
          method: "DELETE",
          query: { flowId: "7", stepId: "3", seller_pubkey: owner },
          authed: false,
        }),
        res as any
      );
      expect(res.statusCode).toBe(401);
      expect(db.deleteFlowStep).not.toHaveBeenCalled();
    });
  });

  describe("/api/email/flows/[flowId]/toggle", () => {
    it("rejects unauthenticated requests", async () => {
      verifyNip98RequestMock.mockResolvedValue({
        ok: false,
        error: "Missing NIP-98 authorization header",
      });
      const res = createResponse();
      await toggleHandler(
        createRequest({
          method: "POST",
          query: { flowId: "7" },
          body: { seller_pubkey: owner },
          authed: false,
        }),
        res as any
      );
      expect(res.statusCode).toBe(401);
      expect(db.updateEmailFlow).not.toHaveBeenCalled();
    });

    it("toggles the owner's flow", async () => {
      const res = createResponse();
      await toggleHandler(
        createRequest({
          method: "POST",
          query: { flowId: "7" },
          body: { seller_pubkey: owner },
        }),
        res as any
      );
      expect(res.statusCode).toBe(200);
      expect(db.updateEmailFlow).toHaveBeenCalledWith(7, {
        status: "paused",
      });
    });
  });
});
