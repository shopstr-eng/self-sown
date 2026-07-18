/**
 * Guards against drift between the MCP set_email_popup tool zod schema
 * (emailPopupToolSchema in mcp/tools/write-tools.ts) and the domain
 * StorefrontEmailPopup type (packages/domain/src/storefront.ts).
 *
 * The email popup config has NO sanitizer (unlike sections), so the only
 * place a field can be silently lost on an agent save is the tool boundary:
 * zod strips unknown keys, and a field missing from the schema simply can't
 * be set through MCP. This mirrors the sibling
 * storefront-full-section-schema-parity test, anchored on the
 * compiler-checked STOREFRONT_EMAIL_POPUP_FIELDS lists instead of a
 * sanitizer (adding a field to the domain type without updating those lists
 * is a compile error in the domain package).
 */

// write-tools.ts pulls in the whole MCP surface at module scope; stub the
// heavy transitive imports (DB, signing, email) — the schema itself is a
// plain zod object with no dependencies on any of these.
jest.mock("@/utils/db/db-service", () => ({}));
jest.mock("@/utils/db/inventory-service", () => ({ setStock: jest.fn() }));
jest.mock("@/utils/mcp/auth", () => ({ getAgentSigner: jest.fn() }));
jest.mock("@/utils/mcp/nostr-signing", () => ({}));
jest.mock("@/utils/mcp/request-proof", () => ({}));
jest.mock("@/utils/nostr/request-auth", () => ({}));
jest.mock("@/utils/lightning/direct-lnurl", () => ({
  derivePaymentPreference: jest.fn(),
}));
jest.mock("@/utils/email/flow-email-templates", () => ({
  getDefaultFlowSteps: jest.fn(),
}));
jest.mock("@/mcp/tools/order-status-auth", () => ({}));
jest.mock("@/mcp/tools/register-tool", () => ({ registerTool: jest.fn() }));
jest.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: class {},
}));
jest.mock("@milk-market/nostr", () => ({
  createSellerActionAuthEventTemplate: jest.fn(),
}));

import { z } from "zod";

import { emailPopupToolSchema } from "@/mcp/tools/write-tools";
import {
  STOREFRONT_EMAIL_POPUP_FIELDS,
  POPUP_STYLE_FIELDS,
  POPUP_FLOW_STEP_FIELDS,
  POPUP_FLOW_ANSWER_FIELDS,
  StorefrontEmailPopup,
} from "@milk-market/domain";

// A fully-populated popup config: every StorefrontEmailPopup field set,
// with values valid in the zod schema. If a new field is added to the
// domain type, the compiler-checked field lists force an update there, and
// the "keeps every domain field" assertions below force this fixture and
// the tool schema to follow.
const FULL_EMAIL_POPUP: Required<StorefrontEmailPopup> = {
  enabled: true,
  displayMode: "fullscreen",
  discountPercentage: 10,
  shippingDiscountType: "percent",
  shippingDiscountValue: 50,
  headline: "Get 10% Off Your First Order",
  subtext: "Join the herd for fresh updates",
  collectPhone: true,
  requirePhone: false,
  buttonText: "Get My Discount",
  successMessage: "Check your inbox!",
  style: {
    backgroundColor: "#ffffff",
    textColor: "#111111",
    accentColor: "#4a7c59",
    buttonColor: "#222222",
    buttonTextColor: "#ffffff",
    backgroundImage: "https://example.com/bg.jpg",
    overlayOpacity: 0.4,
    useCustomFonts: true,
  },
  flowSteps: [
    {
      id: "step-1",
      question: "What brings you here?",
      answers: [
        { id: "a-1", label: "Raw milk", nextStepId: "step-2" },
        { id: "a-2", label: "Just browsing" },
      ],
    },
    {
      id: "step-2",
      question: "How often do you buy?",
      answers: [{ id: "a-3", label: "Weekly" }],
    },
  ],
};

const popupSchema = z.object(emailPopupToolSchema);

describe("MCP set_email_popup schema vs domain StorefrontEmailPopup type", () => {
  test("every StorefrontEmailPopup field exists in the tool schema", () => {
    const schemaKeys = new Set(Object.keys(emailPopupToolSchema));
    const missing = STOREFRONT_EMAIL_POPUP_FIELDS.filter(
      (field) => !schemaKeys.has(field)
    );
    expect(missing).toEqual([]);
  });

  test("nested style schema covers every PopupStyle field", () => {
    const styleSchema = emailPopupToolSchema.style as z.ZodOptional<
      z.ZodObject<z.ZodRawShape>
    >;
    const styleKeys = new Set(Object.keys(styleSchema.unwrap().shape));
    const missing = POPUP_STYLE_FIELDS.filter((field) => !styleKeys.has(field));
    expect(missing).toEqual([]);
  });

  test("nested flowSteps schema covers every PopupFlowStep/PopupFlowAnswer field", () => {
    const flowStepsSchema = emailPopupToolSchema.flowSteps as z.ZodOptional<
      z.ZodArray<z.ZodObject<z.ZodRawShape>>
    >;
    const stepShape = flowStepsSchema.unwrap().element.shape;
    const stepKeys = new Set(Object.keys(stepShape));
    expect(
      POPUP_FLOW_STEP_FIELDS.filter((field) => !stepKeys.has(field))
    ).toEqual([]);

    const answersSchema = stepShape.answers as z.ZodArray<
      z.ZodObject<z.ZodRawShape>
    >;
    const answerKeys = new Set(Object.keys(answersSchema.element.shape));
    expect(
      POPUP_FLOW_ANSWER_FIELDS.filter((field) => !answerKeys.has(field))
    ).toEqual([]);
  });

  test("a fully-populated popup config round-trips the tool boundary unchanged", () => {
    // Zod strips unknown keys, so any field it doesn't know about (at any
    // nesting level — style, flowSteps answers, etc.) disappears here.
    const parsed = popupSchema.parse(FULL_EMAIL_POPUP);
    expect(parsed).toEqual(FULL_EMAIL_POPUP);
  });
});
