// Browser-side helpers for signing and calling the seller-facing
// /api/square/oauth/* endpoints. Each requires a NIP-98–style signed kind-27235
// proof event (see utils/mcp/request-proof). The buyer-facing seller-status and
// create-payment endpoints are unauthenticated and live in square-checkout-api.

import {
  MCP_SIGNED_EVENT_HEADER,
  buildMcpRequestProofTemplate,
  buildSquareCatalogImportProof,
  buildSquareOAuthDisconnectProof,
  buildSquareOAuthStartProof,
  buildSquareOAuthStatusProof,
  type McpRequestProof,
} from "@/utils/mcp/request-proof";
import { NostrEventTemplate } from "@/utils/nostr/nostr-manager";
import type { SquareCatalogItem } from "@/utils/migrations/square-to-nip99";

export interface SquareConnectionStatus {
  configured: boolean;
  connected: boolean;
  environment?: "sandbox" | "production";
  merchantId?: string | null;
  locationId?: string | null;
  currency?: string | null;
  connectedAt?: string | null;
}

type Signer = { sign: (t: NostrEventTemplate) => Promise<{ kind: number }> };

async function signedHeader(
  signer: Signer,
  proof: McpRequestProof
): Promise<string> {
  const template = buildMcpRequestProofTemplate(proof);
  const signed = await signer.sign(template);
  return JSON.stringify(signed);
}

export async function fetchSquareConnectionStatus(
  signer: Signer,
  pubkey: string
): Promise<SquareConnectionStatus> {
  const header = await signedHeader(
    signer,
    buildSquareOAuthStatusProof(pubkey)
  );
  const res = await fetch(
    `/api/square/oauth/status?pubkey=${encodeURIComponent(pubkey)}`,
    { headers: { [MCP_SIGNED_EVENT_HEADER]: header } }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || "Failed");
  return data as SquareConnectionStatus;
}

// Returns the Square authorize URL the browser should navigate to in order to
// connect the seller's own Square account.
export async function startSquareOAuth(
  signer: Signer,
  pubkey: string
): Promise<string> {
  const template = buildMcpRequestProofTemplate(
    buildSquareOAuthStartProof(pubkey)
  );
  const signedEvent = await signer.sign(template);
  const res = await fetch("/api/square/oauth/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pubkey, signedEvent }),
  });
  const data = await res.json();
  if (!res.ok || !data?.success) throw new Error(data?.error || "Failed");
  return data.authorizeUrl as string;
}

export async function disconnectSquare(
  signer: Signer,
  pubkey: string
): Promise<void> {
  const template = buildMcpRequestProofTemplate(
    buildSquareOAuthDisconnectProof(pubkey)
  );
  const signedEvent = await signer.sign(template);
  const res = await fetch("/api/square/oauth/disconnect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pubkey, signedEvent }),
  });
  const data = await res.json();
  if (!res.ok || !data?.success) throw new Error(data?.error || "Failed");
}

// Fetch the seller's Square catalog (items + variations + image URLs) for the
// import modal. Requires a signed proof bound to the seller's pubkey.
export async function fetchSquareCatalogForImport(
  signer: Signer,
  pubkey: string
): Promise<SquareCatalogItem[]> {
  const header = await signedHeader(
    signer,
    buildSquareCatalogImportProof(pubkey)
  );
  const res = await fetch(
    `/api/square/catalog?pubkey=${encodeURIComponent(pubkey)}`,
    { headers: { [MCP_SIGNED_EVENT_HEADER]: header } }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || "Failed");
  return (data.items || []) as SquareCatalogItem[];
}

// Exchange the OAuth code+state returned by Square for a stored connection.
// Called by the /square-oauth-redirect page; no signed event needed (the
// single-use state binds the callback to the initiating pubkey).
export async function completeSquareOAuth(
  code: string,
  state: string
): Promise<void> {
  const res = await fetch("/api/square/oauth/callback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, state }),
  });
  const data = await res.json();
  if (!res.ok || !data?.success) throw new Error(data?.error || "Failed");
}
