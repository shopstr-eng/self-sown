import { createMcpServer } from "../server";

describe("createMcpServer", () => {
  it("advertises the Self-sown server identity to MCP clients", () => {
    const server = createMcpServer();
    const info = (
      server.server as unknown as { _serverInfo: { name: string } }
    )._serverInfo;
    expect(info.name).toBe("self-sown");
  });
});
