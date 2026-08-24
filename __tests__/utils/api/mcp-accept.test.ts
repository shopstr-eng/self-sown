import {
  applyMcpAcceptHeader,
  normalizeMcpAcceptHeader,
} from "@/utils/api/mcp-accept";

describe("normalizeMcpAcceptHeader", () => {
  it.each([
    undefined,
    "*/*",
    "application/json",
    "text/event-stream",
    "text/html",
    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  ])(
    "defaults an insufficient Accept header (%s) to the full streamable set",
    (accept) => {
      expect(normalizeMcpAcceptHeader(accept as string | undefined)).toBe(
        "application/json, text/event-stream"
      );
    }
  );

  it("passes spec-compliant headers through unchanged", () => {
    const ok = "application/json, text/event-stream";
    expect(normalizeMcpAcceptHeader(ok)).toBe(ok);
  });

  it("is case-insensitive", () => {
    const mixed = "Application/JSON, Text/Event-Stream";
    expect(normalizeMcpAcceptHeader(mixed)).toBe(mixed);
  });

  it("requires BOTH concrete types — a lone */* is not enough (the SDK 406s it)", () => {
    expect(normalizeMcpAcceptHeader("application/json, */*")).toBe(
      "application/json, text/event-stream"
    );
  });
});

describe("applyMcpAcceptHeader", () => {
  // The MCP SDK's hono bridge reads req.rawHeaders, not req.headers — both
  // must be updated or the normalization never reaches the transport.
  function fakeReq(accept?: string) {
    return {
      headers: accept ? { accept } : {},
      rawHeaders: accept ? ["Host", "x", "Accept", accept] : ["Host", "x"],
    } as any;
  }

  it("replaces the existing rawHeaders entry (case-insensitively)", () => {
    const req = fakeReq("application/json");
    applyMcpAcceptHeader(req);
    expect(req.rawHeaders).toEqual([
      "Host",
      "x",
      "Accept",
      "application/json, text/event-stream",
    ]);
    expect(req.headers.accept).toBe("application/json, text/event-stream");
  });

  it("appends a rawHeaders entry when Accept is absent", () => {
    const req = fakeReq();
    applyMcpAcceptHeader(req);
    expect(req.rawHeaders).toEqual([
      "Host",
      "x",
      "Accept",
      "application/json, text/event-stream",
    ]);
  });

  it("leaves a spec-compliant header untouched", () => {
    const ok = "application/json, text/event-stream";
    const req = fakeReq(ok);
    applyMcpAcceptHeader(req);
    expect(req.rawHeaders).toEqual(["Host", "x", "Accept", ok]);
  });
});
