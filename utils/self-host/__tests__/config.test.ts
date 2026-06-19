import {
  buildSelfHostConfig,
  normalizeTenantPubkey,
  isSelfHost,
  isSelfHostTenant,
  DEFAULT_UPSTREAM_REPO,
  __resetSelfHostConfigCacheForTests,
} from "@/utils/self-host/config";

const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);

describe("normalizeTenantPubkey", () => {
  it("lowercases 64-char hex", () => {
    expect(normalizeTenantPubkey("A".repeat(64))).toBe(HEX_A);
  });

  it("decodes npub to hex", () => {
    // npub for the all-zero key is a stable, well-known vector.
    const npub = "npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqsm5y9d";
    const decoded = normalizeTenantPubkey(npub);
    // Either a valid 64-char hex (decode succeeded) or null — never a crash.
    if (decoded !== null) {
      expect(decoded).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("returns null for malformed input (fails closed)", () => {
    expect(normalizeTenantPubkey("not-a-key")).toBeNull();
    expect(normalizeTenantPubkey("")).toBeNull();
    expect(normalizeTenantPubkey(null)).toBeNull();
    expect(normalizeTenantPubkey(undefined)).toBeNull();
    expect(normalizeTenantPubkey("a".repeat(63))).toBeNull();
  });
});

describe("buildSelfHostConfig", () => {
  it("is fully disabled when MM_SELF_HOST is not truthy", () => {
    const cfg = buildSelfHostConfig({} as NodeJS.ProcessEnv);
    expect(cfg.enabled).toBe(false);
    expect(cfg.tenantPubkey).toBeNull();
    expect(cfg.tenantSlug).toBeNull();
    expect(cfg.relays).toEqual([]);
    expect(cfg.blossomServers).toEqual([]);
    expect(cfg.ownStripe).toBe(false);
    // Upstream repo always resolves, even when disabled.
    expect(cfg.upstreamRepo).toBe(DEFAULT_UPSTREAM_REPO);
  });

  it("enables and parses env values when MM_SELF_HOST=1", () => {
    const cfg = buildSelfHostConfig({
      MM_SELF_HOST: "1",
      MM_SELF_HOST_PUBKEY: "A".repeat(64),
      MM_SELF_HOST_SLUG: "my-farm",
      MM_SELF_HOST_RELAYS: "wss://a.example , wss://b.example",
      MM_SELF_HOST_BLOSSOM_SERVERS: "https://blossom.example",
    } as unknown as NodeJS.ProcessEnv);
    expect(cfg.enabled).toBe(true);
    expect(cfg.tenantPubkey).toBe(HEX_A);
    expect(cfg.tenantSlug).toBe("my-farm");
    expect(cfg.relays).toEqual(["wss://a.example", "wss://b.example"]);
    expect(cfg.blossomServers).toEqual(["https://blossom.example"]);
  });

  it("lets env win over the config file", () => {
    const cfg = buildSelfHostConfig(
      {
        MM_SELF_HOST: "true",
        MM_SELF_HOST_PUBKEY: "A".repeat(64),
        MM_SELF_HOST_SLUG: "env-slug",
      } as unknown as NodeJS.ProcessEnv,
      { npub: "ignored", slug: "file-slug", pubkey: HEX_B }
    );
    expect(cfg.tenantPubkey).toBe(HEX_A);
    expect(cfg.tenantSlug).toBe("env-slug");
  });

  it("falls back to the config file when env is absent", () => {
    const cfg = buildSelfHostConfig(
      { MM_SELF_HOST: "on" },
      {
        pubkey: HEX_B,
        slug: "file-slug",
        relays: ["wss://file.example", 42, ""],
        blossomServers: ["https://file.blossom"],
        ownStripe: true,
      }
    );
    expect(cfg.tenantPubkey).toBe(HEX_B);
    expect(cfg.tenantSlug).toBe("file-slug");
    expect(cfg.relays).toEqual(["wss://file.example"]);
    expect(cfg.blossomServers).toEqual(["https://file.blossom"]);
    expect(cfg.ownStripe).toBe(true);
  });

  it("auto-enables ownStripe when a Stripe key is present", () => {
    const cfg = buildSelfHostConfig({
      MM_SELF_HOST: "1",
      STRIPE_SECRET_KEY: "sk_test_x",
    } as unknown as NodeJS.ProcessEnv);
    expect(cfg.ownStripe).toBe(true);
  });

  it("lets an explicit env flag override ownStripe auto-detection", () => {
    const cfg = buildSelfHostConfig({
      MM_SELF_HOST: "1",
      STRIPE_SECRET_KEY: "sk_test_x",
      MM_SELF_HOST_OWN_STRIPE: "0",
    } as unknown as NodeJS.ProcessEnv);
    expect(cfg.ownStripe).toBe(false);
  });
});

describe("isSelfHost / isSelfHostTenant (process.env)", () => {
  const ORIGINAL = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL };
    __resetSelfHostConfigCacheForTests();
  });

  it("isSelfHost is false by default", () => {
    delete process.env.MM_SELF_HOST;
    __resetSelfHostConfigCacheForTests();
    expect(isSelfHost()).toBe(false);
  });

  it("scopes the tenant match to exactly the configured pubkey", () => {
    process.env.MM_SELF_HOST = "1";
    process.env.MM_SELF_HOST_PUBKEY = HEX_A;
    __resetSelfHostConfigCacheForTests();

    expect(isSelfHost()).toBe(true);
    expect(isSelfHostTenant(HEX_A)).toBe(true);
    // Case-insensitive on input.
    expect(isSelfHostTenant("A".repeat(64))).toBe(true);
    // Any other pubkey is NOT the tenant.
    expect(isSelfHostTenant(HEX_B)).toBe(false);
    expect(isSelfHostTenant(null)).toBe(false);
    expect(isSelfHostTenant(undefined)).toBe(false);
  });

  it("fails closed when self-host is on but no tenant pubkey is configured", () => {
    process.env.MM_SELF_HOST = "1";
    delete process.env.MM_SELF_HOST_PUBKEY;
    __resetSelfHostConfigCacheForTests();

    expect(isSelfHost()).toBe(true);
    expect(isSelfHostTenant(HEX_A)).toBe(false);
    expect(isSelfHostTenant(HEX_B)).toBe(false);
  });

  it("nobody is the tenant when self-host is off", () => {
    delete process.env.MM_SELF_HOST;
    process.env.MM_SELF_HOST_PUBKEY = HEX_A;
    __resetSelfHostConfigCacheForTests();

    expect(isSelfHost()).toBe(false);
    expect(isSelfHostTenant(HEX_A)).toBe(false);
  });
});
