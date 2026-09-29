import { main, parseArgs } from "../cli";

interface FetchCall {
  url: string;
  init: { method?: string; headers?: Record<string, string>; body?: string };
}

function makeResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (key: string) => headers[key.toLowerCase()] ?? null },
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

function makeHarness(
  options: {
    responder?: (call: FetchCall) => ReturnType<typeof makeResponse>;
    env?: Record<string, string>;
    config?: string;
  } = {}
) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const calls: FetchCall[] = [];
  const writes: { path: string; contents: string }[] = [];
  const fetchImpl = (async (url: unknown, init: FetchCall["init"]) => {
    const call: FetchCall = { url: String(url), init };
    calls.push(call);
    const respond =
      options.responder ?? (() => makeResponse(200, { ok: true }));
    return respond(call);
  }) as unknown as typeof fetch;
  const io = {
    fetchImpl,
    env: options.env ?? {},
    homeDir: "/home/test",
    stdout: (text: string) => {
      stdout.push(text);
    },
    stderr: (text: string) => {
      stderr.push(text);
    },
    readConfig: () => options.config,
    writeConfig: (path: string, contents: string) => {
      writes.push({ path, contents });
    },
  };
  return { io, stdout, stderr, calls, writes };
}

describe("parseArgs", () => {
  it("splits positionals, --flag value, --flag=value, and boolean flags", () => {
    expect(
      parseArgs([
        "search",
        "raw",
        "milk",
        "--limit",
        "5",
        "--offset=10",
        "--save",
      ])
    ).toEqual({
      positionals: ["search", "raw", "milk"],
      flags: { limit: "5", offset: "10", save: true },
    });
  });
});

describe("onboard", () => {
  it("posts a free shopping-audience key request and prints the key", async () => {
    const { io, stdout, calls } = makeHarness({
      responder: () =>
        makeResponse(201, {
          apiKey: "ss_abc123",
          pubkey: "p",
          npub: "npub1x",
          audience: "shopping",
          permissions: "read",
        }),
    });
    const exit = await main(["onboard", "--name", "tester"], io);
    expect(exit).toBe(0);
    expect(calls[0]?.url).toBe("https://self-sown.com/api/mcp/onboard");
    expect(calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(calls[0]?.init.body ?? "{}")).toEqual({
      name: "tester",
      audience: "shopping",
    });
    expect(calls[0]?.init.headers?.Authorization).toBeUndefined();
    expect(JSON.parse(stdout[0] ?? "{}").apiKey).toBe("ss_abc123");
  });

  it("--save persists the key to the config file", async () => {
    const { io, writes } = makeHarness({
      responder: () => makeResponse(201, { apiKey: "ss_secret" }),
    });
    const exit = await main(["onboard", "--name", "tester", "--save"], io);
    expect(exit).toBe(0);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe("/home/test/.config/selfsown/config.json");
    expect(JSON.parse(writes[0]?.contents ?? "{}").apiKey).toBe("ss_secret");
  });

  it("requires --name", async () => {
    const { io, calls } = makeHarness();
    const exit = await main(["onboard"], io);
    expect(exit).toBe(2);
    expect(calls).toHaveLength(0);
  });
});

describe("search", () => {
  it("hits the public catalog without auth and maps flags to params", async () => {
    const { io, calls } = makeHarness();
    const exit = await main(
      ["search", "raw", "milk", "--limit", "5", "--category", "dairy"],
      io
    );
    expect(exit).toBe(0);
    const url = new URL(calls[0]?.url ?? "");
    expect(url.pathname).toBe("/api/ucp/catalog/search");
    expect(url.searchParams.get("q")).toBe("raw milk");
    expect(url.searchParams.get("limit")).toBe("5");
    expect(url.searchParams.get("category")).toBe("dairy");
    expect(calls[0]?.init.headers?.Authorization).toBeUndefined();
  });

  it("rejects an empty query", async () => {
    const { io, calls, stderr } = makeHarness();
    const exit = await main(["search"], io);
    expect(exit).toBe(2);
    expect(stderr.join(" ")).toContain("query");
    expect(calls).toHaveLength(0);
  });
});

describe("product", () => {
  it("looks up by positional id", async () => {
    const { io, calls } = makeHarness();
    const exit = await main(["product", "prod_1"], io);
    expect(exit).toBe(0);
    const url = new URL(calls[0]?.url ?? "");
    expect(url.pathname).toBe("/api/ucp/catalog/lookup");
    expect(url.searchParams.get("id")).toBe("prod_1");
  });

  it("rejects --slug without --pubkey", async () => {
    const { io, calls } = makeHarness();
    const exit = await main(["product", "--slug", "milk"], io);
    expect(exit).toBe(2);
    expect(calls).toHaveLength(0);
  });
});

describe("checkout", () => {
  it("fails with a usage error when no API key is available", async () => {
    const { io, calls, stderr } = makeHarness({ env: {} });
    const exit = await main(["checkout", "create", "--product", "p1"], io);
    expect(exit).toBe(2);
    expect(stderr.join(" ")).toContain("onboard");
    expect(calls).toHaveLength(0);
  });

  it("sends the Bearer key and the mapped request body", async () => {
    const { io, calls } = makeHarness({
      env: { SELF_SOWN_API_KEY: "ss_k" },
    });
    const exit = await main(
      [
        "checkout",
        "create",
        "--product",
        "p1",
        "--quantity",
        "2",
        "--email",
        "a@b.c",
        "--discount-code",
        "SAVE",
        "--shipping-address",
        '{"zip":"12345"}',
      ],
      io
    );
    expect(exit).toBe(0);
    expect(calls[0]?.url).toBe(
      "https://self-sown.com/api/ucp/checkout/sessions"
    );
    expect(calls[0]?.init.headers?.Authorization).toBe("Bearer ss_k");
    expect(JSON.parse(calls[0]?.init.body ?? "{}")).toEqual({
      productId: "p1",
      quantity: 2,
      buyerEmail: "a@b.c",
      discountCode: "SAVE",
      shippingAddress: { zip: "12345" },
    });
  });

  it("treats a blank numeric flag as a usage error, never zero", async () => {
    const { io, calls } = makeHarness({
      env: { SELF_SOWN_API_KEY: "ss_k" },
    });
    const exit = await main(
      ["checkout", "create", "--product", "p1", "--quantity="],
      io
    );
    expect(exit).toBe(2);
    expect(calls).toHaveLength(0);
  });

  it("status reads the session with auth", async () => {
    const { io, calls } = makeHarness({
      env: { SELF_SOWN_API_KEY: "ss_k" },
    });
    const exit = await main(["checkout", "status", "cs_123"], io);
    expect(exit).toBe(0);
    expect(calls[0]?.url).toBe(
      "https://self-sown.com/api/ucp/checkout/sessions/cs_123"
    );
    expect(calls[0]?.init.method).toBe("GET");
    expect(calls[0]?.init.headers?.Authorization).toBe("Bearer ss_k");
  });

  it("complete posts to the idempotent completion endpoint with no body", async () => {
    const { io, calls } = makeHarness({
      env: { SELF_SOWN_API_KEY: "ss_k" },
    });
    const exit = await main(["checkout", "complete", "cs_123"], io);
    expect(exit).toBe(0);
    expect(calls[0]?.url).toBe(
      "https://self-sown.com/api/ucp/checkout/sessions/cs_123/complete"
    );
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.body).toBeUndefined();
  });

  it("rejects a bare --quantity instead of silently defaulting", async () => {
    const { io, calls } = makeHarness({ env: { SELF_SOWN_API_KEY: "ss_k" } });
    const exit = await main(
      ["checkout", "create", "--product", "p1", "--quantity"],
      io
    );
    expect(exit).toBe(2);
    expect(calls).toHaveLength(0);
  });

  it("sends --bulk-units as a number, not a string", async () => {
    const { io, calls } = makeHarness({ env: { SELF_SOWN_API_KEY: "ss_k" } });
    const exit = await main(
      ["checkout", "create", "--product", "p1", "--bulk-units", "3"],
      io
    );
    expect(exit).toBe(0);
    expect(JSON.parse(calls[0]?.init.body ?? "{}").selectedBulkUnits).toBe(3);
  });

  it("boolean flags never swallow the next positional", async () => {
    const { io, calls } = makeHarness({ env: { SELF_SOWN_API_KEY: "ss_k" } });
    const exit = await main(["checkout", "--raw", "status", "cs_9"], io);
    expect(exit).toBe(0);
    expect(calls[0]?.url).toContain("/api/ucp/checkout/sessions/cs_9");
  });
});

describe("saved-config origin binding", () => {
  const savedConfig = JSON.stringify({
    apiKey: "ss_saved",
    baseUrl: "https://private-mint.example",
  });

  it("sends a saved key only to the origin it was minted on", async () => {
    const { io, calls } = makeHarness({ config: savedConfig });
    const exit = await main(["checkout", "list"], io);
    expect(exit).toBe(0);
    expect(calls[0]?.url).toBe(
      "https://private-mint.example/api/ucp/checkout/sessions"
    );
    expect(calls[0]?.init.headers?.Authorization).toBe("Bearer ss_saved");
  });

  it("refuses to send a saved key to a different --base-url", async () => {
    const { io, calls, stderr } = makeHarness({ config: savedConfig });
    const exit = await main(
      ["checkout", "list", "--base-url", "https://self-sown.com"],
      io
    );
    expect(exit).toBe(2);
    expect(stderr.join(" ")).toContain("private-mint.example");
    expect(calls).toHaveLength(0);
  });

  it("an explicit --api-key may target any host", async () => {
    const { io, calls } = makeHarness({ config: savedConfig });
    const exit = await main(
      [
        "checkout",
        "list",
        "--api-key",
        "ss_other",
        "--base-url",
        "https://self-sown.com",
      ],
      io
    );
    expect(exit).toBe(0);
    expect(calls[0]?.url).toBe(
      "https://self-sown.com/api/ucp/checkout/sessions"
    );
    expect(calls[0]?.init.headers?.Authorization).toBe("Bearer ss_other");
  });

  it("public commands ignore the saved key and its origin", async () => {
    const { io, calls } = makeHarness({ config: savedConfig });
    const exit = await main(
      ["search", "milk", "--base-url", "https://other.example"],
      io
    );
    expect(exit).toBe(0);
    expect(calls[0]?.url).toContain(
      "https://other.example/api/ucp/catalog/search"
    );
    expect(calls[0]?.init.headers?.Authorization).toBeUndefined();
  });

  it("onboard targets --base-url even with a saved key elsewhere", async () => {
    const { io, calls, writes } = makeHarness({
      config: savedConfig,
      responder: () => makeResponse(201, { apiKey: "ss_new" }),
    });
    const exit = await main(
      [
        "onboard",
        "--name",
        "agent",
        "--base-url",
        "https://other.example",
        "--save",
      ],
      io
    );
    expect(exit).toBe(0);
    expect(calls[0]?.url).toBe("https://other.example/api/mcp/onboard");
    expect(JSON.parse(writes[0]?.contents ?? "{}")).toEqual({
      apiKey: "ss_new",
      baseUrl: "https://other.example",
    });
  });
});

describe("error handling", () => {
  it("surfaces 429 retry hints and exits 1", async () => {
    const { io, stderr } = makeHarness({
      responder: () =>
        makeResponse(429, { error: "rate limited", retryAfterSeconds: 42 }),
    });
    const exit = await main(["search", "milk"], io);
    expect(exit).toBe(1);
    const payload = JSON.parse(stderr[0] ?? "{}");
    expect(payload.error).toBe("rate limited");
    expect(payload.retryAfterSeconds).toBe(42);
    expect(payload.status).toBe(429);
  });

  it("rejects unknown commands with a usage error", async () => {
    const { io } = makeHarness();
    expect(await main(["frobnicate"], io)).toBe(2);
  });

  it("rejects a non-http base URL", async () => {
    const { io, calls } = makeHarness();
    const exit = await main(["search", "milk", "--base-url", "ftp://x"], io);
    expect(exit).toBe(2);
    expect(calls).toHaveLength(0);
  });
});
