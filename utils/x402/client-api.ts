// Browser-side helpers for the x402 invoice-authority settings endpoint.
// Same signed kind-27235 proof pattern as utils/shipping/client-api.ts.

import {
  MCP_SIGNED_EVENT_HEADER,
  buildMcpRequestProofTemplate,
  type McpRequestProof,
} from "@/utils/mcp/request-proof";
import { NostrEventTemplate } from "@/utils/nostr/nostr-manager";

export interface X402AuthorityStatus {
  provider: "lnbits";
  url: string;
  updatedAt: string;
}

type Signer = { sign: (t: NostrEventTemplate) => Promise<{ kind: number }> };

function authorityProof(
  pubkey: string,
  method: "GET" | "POST" | "DELETE"
): McpRequestProof {
  return {
    pubkey,
    method,
    path: "/api/x402/authority",
    action: "x402_authority",
  };
}

async function signedHeader(
  signer: Signer,
  proof: McpRequestProof
): Promise<string> {
  const template = buildMcpRequestProofTemplate(proof);
  const signed = await signer.sign(template);
  return JSON.stringify(signed);
}

export async function fetchX402Authority(
  signer: Signer,
  pubkey: string
): Promise<X402AuthorityStatus | null> {
  const header = await signedHeader(signer, authorityProof(pubkey, "GET"));
  const res = await fetch("/api/x402/authority", {
    headers: { [MCP_SIGNED_EVENT_HEADER]: header },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || "Failed to load");
  return (data?.authority ?? null) as X402AuthorityStatus | null;
}

export async function saveX402Authority(
  signer: Signer,
  pubkey: string,
  config: { url: string; apiKey: string }
): Promise<X402AuthorityStatus | null> {
  const header = await signedHeader(signer, authorityProof(pubkey, "POST"));
  const res = await fetch("/api/x402/authority", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [MCP_SIGNED_EVENT_HEADER]: header,
    },
    body: JSON.stringify({ provider: "lnbits", ...config }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || "Failed to save");
  return (data?.authority ?? null) as X402AuthorityStatus | null;
}

export async function deleteX402Authority(
  signer: Signer,
  pubkey: string
): Promise<void> {
  const header = await signedHeader(signer, authorityProof(pubkey, "DELETE"));
  const res = await fetch("/api/x402/authority", {
    method: "DELETE",
    headers: { [MCP_SIGNED_EVENT_HEADER]: header },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || "Failed to disconnect");
}
