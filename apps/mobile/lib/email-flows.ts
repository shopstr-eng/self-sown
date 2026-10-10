import type { SellerSession } from "@self-sown/domain";

import { getApiBaseUrl } from "./api-base-url";
import { createNip98AuthorizationHeader } from "./nip98";

// Mirrors the web email-flow contracts in pages/settings/email-flows.tsx and
// pages/api/email/flows/*. Reads and simple mutations authorize with the
// seller_pubkey param (server checks ownership + Pro entitlement); the
// endpoints that send real email (send-test, send-to-contacts, click-stats)
// require NIP-98 proofs, same as the web dashboard.
const FLOWS_PATH = "/api/email/flows";

export const FLOW_TYPES = [
  "welcome_series",
  "abandoned_cart",
  "post_purchase",
  "winback",
  "one_time",
] as const;

export type FlowType = (typeof FLOW_TYPES)[number];

export const FLOW_TYPE_LABELS: Record<FlowType, string> = {
  welcome_series: "Welcome Series",
  abandoned_cart: "Abandoned Cart",
  post_purchase: "Post-Purchase",
  winback: "Win-Back",
  one_time: "One-Time Email",
};

export interface EmailFlow {
  id: number;
  seller_pubkey: string;
  name: string;
  flow_type: string;
  status: string;
  from_name: string | null;
  reply_to: string | null;
  created_at: string;
  updated_at: string;
}

export interface FlowStep {
  id?: number;
  step_order: number;
  subject: string;
  body_html: string;
  delay_hours: number;
}

export interface FlowClickStat {
  total: number;
  lastClicked: string | null;
}

export interface FlowContact {
  email: string;
  discountCode: string;
  discountPercentage: number;
  source: "popup" | "subscription";
  alreadyReceived: boolean;
}

async function readErrorMessage(response: Response, fallback: string) {
  try {
    const body = (await response.json()) as { error?: string };
    return body.error ?? fallback;
  } catch {
    return fallback;
  }
}

function flowUrl(flowId: number, suffix = ""): string {
  return `${getApiBaseUrl()}${FLOWS_PATH}/${flowId}${suffix}`;
}

export function formatDelayHours(hours: number): string {
  if (hours === 0) return "Immediately";
  if (hours < 24) return `${hours} hour${hours !== 1 ? "s" : ""} after`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  if (remainingHours === 0) return `${days} day${days !== 1 ? "s" : ""} after`;
  return `${days}d ${remainingHours}h after`;
}

export async function listEmailFlows(
  session: SellerSession
): Promise<EmailFlow[]> {
  const response = await fetch(
    `${getApiBaseUrl()}${FLOWS_PATH}?seller_pubkey=${session.pubkey}`
  );
  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, "Email flows could not be loaded.")
    );
  }
  const data = (await response.json()) as { flows?: EmailFlow[] };
  return Array.isArray(data.flows) ? data.flows : [];
}

// Click/engagement stats are a Pro feature and NIP-98 authed so only the owner
// reads their own data.
export async function getFlowClickStats(
  session: SellerSession
): Promise<Record<number, FlowClickStat>> {
  const url = `${getApiBaseUrl()}${FLOWS_PATH}/click-stats`;
  const response = await fetch(url, {
    headers: {
      Authorization: await createNip98AuthorizationHeader(session, url, "GET"),
    },
  });
  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, "Click stats could not be loaded.")
    );
  }
  const data = (await response.json()) as {
    stats?: Record<number, FlowClickStat>;
  };
  return data.stats ?? {};
}

export async function createEmailFlow(
  session: SellerSession,
  name: string,
  flowType: FlowType
): Promise<EmailFlow> {
  const response = await fetch(`${getApiBaseUrl()}${FLOWS_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      seller_pubkey: session.pubkey,
      name: name.trim(),
      flow_type: flowType,
      use_defaults: true,
    }),
  });
  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, "The flow could not be created.")
    );
  }
  const data = (await response.json()) as { flow: EmailFlow };
  return data.flow;
}

export async function toggleEmailFlow(
  session: SellerSession,
  flowId: number
): Promise<EmailFlow> {
  const response = await fetch(flowUrl(flowId, "/toggle"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ seller_pubkey: session.pubkey }),
  });
  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, "The flow status could not be changed.")
    );
  }
  const data = (await response.json()) as { flow: EmailFlow };
  return data.flow;
}

export async function deleteEmailFlow(
  session: SellerSession,
  flowId: number
): Promise<void> {
  const response = await fetch(
    `${flowUrl(flowId)}?seller_pubkey=${session.pubkey}`,
    { method: "DELETE" }
  );
  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, "The flow could not be deleted.")
    );
  }
}

export async function updateEmailFlowSettings(
  session: SellerSession,
  flowId: number,
  settings: { fromName: string; replyTo: string }
): Promise<void> {
  const response = await fetch(flowUrl(flowId), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      seller_pubkey: session.pubkey,
      from_name: settings.fromName.trim() || null,
      reply_to: settings.replyTo.trim() || null,
    }),
  });
  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, "The flow settings could not be saved.")
    );
  }
}

export async function listFlowSteps(
  session: SellerSession,
  flowId: number
): Promise<FlowStep[]> {
  const response = await fetch(
    `${flowUrl(flowId, "/steps")}?seller_pubkey=${session.pubkey}`
  );
  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, "Flow steps could not be loaded.")
    );
  }
  const data = (await response.json()) as { steps?: FlowStep[] };
  return Array.isArray(data.steps) ? data.steps : [];
}

export async function saveFlowStep(
  session: SellerSession,
  flowId: number,
  step: FlowStep
): Promise<void> {
  const payload = {
    seller_pubkey: session.pubkey,
    subject: step.subject,
    body_html: step.body_html,
    delay_hours: step.delay_hours,
    step_order: step.step_order,
  };
  const isExisting = typeof step.id === "number";
  const response = await fetch(
    isExisting ? flowUrl(flowId, `/steps/${step.id}`) : flowUrl(flowId, "/steps"),
    {
      method: isExisting ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }
  );
  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, "The step could not be saved.")
    );
  }
}

export async function deleteFlowStep(
  session: SellerSession,
  flowId: number,
  stepId: number
): Promise<void> {
  const response = await fetch(
    `${flowUrl(flowId, `/steps/${stepId}`)}?seller_pubkey=${session.pubkey}`,
    { method: "DELETE" }
  );
  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, "The step could not be deleted.")
    );
  }
}

// Sends a test render of a step from the seller's own authenticated domain, so
// the server requires a NIP-98 proof bound to the exact request body.
export async function sendFlowTestEmail(
  session: SellerSession,
  flowId: number,
  params: { targetEmail: string; subject: string; bodyHtml: string }
): Promise<void> {
  const url = flowUrl(flowId, "/send-test");
  const body = JSON.stringify({
    seller_pubkey: session.pubkey,
    target_email: params.targetEmail,
    subject: params.subject,
    body_html: params.bodyHtml,
  });
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: await createNip98AuthorizationHeader(
        session,
        url,
        "POST",
        body
      ),
    },
    body,
  });
  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, "The test email could not be sent.")
    );
  }
}

export async function listFlowContacts(
  session: SellerSession,
  flowId: number
): Promise<FlowContact[]> {
  const url = flowUrl(flowId, "/send-to-contacts");
  const response = await fetch(url, {
    headers: {
      Authorization: await createNip98AuthorizationHeader(session, url, "GET"),
    },
  });
  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, "Contacts could not be loaded.")
    );
  }
  const data = (await response.json()) as { contacts?: FlowContact[] };
  return Array.isArray(data.contacts) ? data.contacts : [];
}

export async function sendFlowToContacts(
  session: SellerSession,
  flowId: number,
  emails: string[]
): Promise<{ enrolled: number; skipped: number }> {
  const url = flowUrl(flowId, "/send-to-contacts");
  const body = JSON.stringify({ emails });
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: await createNip98AuthorizationHeader(
        session,
        url,
        "POST",
        body
      ),
    },
    body,
  });
  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, "The flow could not be sent.")
    );
  }
  const data = (await response.json()) as {
    enrolled?: number;
    skipped?: number;
  };
  return { enrolled: data.enrolled ?? 0, skipped: data.skipped ?? 0 };
}
