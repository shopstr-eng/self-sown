/** @jest-environment node */

// Unit coverage for the UCP discovery profile builder (utils/ucp/discovery.ts).
// The profile is the entry point an agentic/shopping client reads, so its shape
// matters: it must advertise the supported version(s), both REST + MCP
// transports per capability, the checkout complete endpoint, and it must scope
// correctly to either the whole marketplace or a single seller.

import { buildUcpDiscoveryProfile } from "@/utils/ucp/discovery";
import {
  UCP_CATALOG_CAPABILITY,
  UCP_CHECKOUT_CAPABILITY,
  UCP_VERSION,
} from "@/utils/ucp/types";

const BASE = "https://milk.market";

describe("buildUcpDiscoveryProfile — platform scope", () => {
  const profile = buildUcpDiscoveryProfile({ baseUrl: `${BASE}/` });

  it("is marketplace-scoped with no seller block", () => {
    expect(profile.scope).toBe("marketplace");
    expect(profile.seller).toBeUndefined();
    expect(profile.name).toBe("Milk Market");
  });

  it("advertises the version and supported_versions", () => {
    expect(profile.ucp_version).toBe(UCP_VERSION);
    expect(profile.supported_versions).toEqual([UCP_VERSION]);
  });

  it("trims the trailing slash off the base url in endpoints", () => {
    const catalog = profile.capabilities.find(
      (c) => c.name === UCP_CATALOG_CAPABILITY
    ) as Record<string, any>;
    expect(catalog.endpoints.search).toBe(`${BASE}/api/ucp/catalog/search`);
  });

  it("exposes catalog + checkout capabilities", () => {
    const names = profile.capabilities.map((c) => c.name);
    expect(names).toContain(UCP_CATALOG_CAPABILITY);
    expect(names).toContain(UCP_CHECKOUT_CAPABILITY);
  });

  it("offers REST + MCP transports on each capability", () => {
    for (const cap of profile.capabilities as Array<Record<string, any>>) {
      const types = (cap.transports || []).map((t: any) => t.type);
      expect(types).toEqual(["rest", "mcp"]);
      const mcp = cap.transports.find((t: any) => t.type === "mcp");
      expect(mcp.endpoint).toBe(`${BASE}/api/mcp`);
      expect(mcp.manifest).toBe(`${BASE}/.well-known/agent.json`);
    }
  });

  it("advertises the checkout complete_session endpoint", () => {
    const checkout = profile.capabilities.find(
      (c) => c.name === UCP_CHECKOUT_CAPABILITY
    ) as Record<string, any>;
    expect(checkout.endpoints.complete_session).toBe(
      `${BASE}/api/ucp/checkout/sessions/{id}/complete`
    );
    const rest = checkout.transports.find((t: any) => t.type === "rest");
    expect(rest.endpoints.complete_session).toBe(
      `${BASE}/api/ucp/checkout/sessions/{id}/complete`
    );
  });
});

describe("buildUcpDiscoveryProfile — seller scope", () => {
  const seller = {
    pubkey: "abc123",
    npub: "npub1abc",
    name: "Sunny Farm",
    slug: "sunny-farm",
  };
  const profile = buildUcpDiscoveryProfile({
    baseUrl: "https://sunny.example",
    seller,
  });

  it("is seller-scoped and names the seller", () => {
    expect(profile.scope).toBe("seller");
    expect(profile.name).toBe("Sunny Farm");
    expect(profile.seller).toMatchObject({
      pubkey: "abc123",
      npub: "npub1abc",
      name: "Sunny Farm",
      url: "https://sunny.example",
    });
  });

  it("still advertises supported_versions and both transports", () => {
    expect(profile.supported_versions).toEqual([UCP_VERSION]);
    const checkout = profile.capabilities.find(
      (c) => c.name === UCP_CHECKOUT_CAPABILITY
    ) as Record<string, any>;
    expect((checkout.transports || []).map((t: any) => t.type)).toEqual([
      "rest",
      "mcp",
    ]);
    expect(checkout.endpoints.complete_session).toBe(
      "https://sunny.example/api/ucp/checkout/sessions/{id}/complete"
    );
  });
});
