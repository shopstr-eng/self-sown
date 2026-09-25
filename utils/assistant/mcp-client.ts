// Minimal MCP (streamable HTTP) client that talks to this app's own /api/mcp
// endpoint over loopback. The seller assistant is intentionally a REAL MCP
// client — same Bearer-key auth, same tools, same audit trail as any external
// agent — so the assistant can never do anything an external agent couldn't.

interface JsonRpcMessage {
  jsonrpc: string;
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface McpToolResult {
  text: string;
  isError: boolean;
}

// Distinguishable auth failure so the chat route can evict a stale cached raw
// key, rotate once, and retry instead of failing the seller's message.
export class McpAuthError extends Error {}

const PROTOCOL_VERSION = "2025-03-26";
const CALL_TIMEOUT_MS = 20_000;
const CLOSE_TIMEOUT_MS = 5_000;

function baseUrl(): string {
  return `http://localhost:${process.env.PORT || 5000}`;
}

async function parseRpcMessage(res: Response): Promise<JsonRpcMessage> {
  const contentType = res.headers.get("content-type") || "";
  const text = await res.text();
  if (contentType.includes("application/json")) {
    return JSON.parse(text) as JsonRpcMessage;
  }
  // text/event-stream: the response to our request is the last data message.
  let last: JsonRpcMessage | null = null;
  for (const block of text.split("\n\n")) {
    const dataLine = block.split("\n").find((line) => line.startsWith("data:"));
    if (!dataLine) continue;
    try {
      last = JSON.parse(dataLine.slice(5).trim()) as JsonRpcMessage;
    } catch {
      // not JSON — keep scanning
    }
  }
  if (!last) {
    throw new Error(`No JSON-RPC message in MCP response (HTTP ${res.status})`);
  }
  return last;
}

export class McpLoopbackClient {
  private sessionId: string | null = null;
  private nextId = 1;

  // No key = an anonymous MCP session, which the server restricts to public
  // catalog read tools — exactly the buyer-facing assistant's surface.
  constructor(private readonly rawKey?: string) {}

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    if (this.rawKey) headers["Authorization"] = `Bearer ${this.rawKey}`;
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    return headers;
  }

  private async post(body: unknown): Promise<Response> {
    return fetch(`${baseUrl()}/api/mcp`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
  }

  async connect(): Promise<void> {
    const id = this.nextId++;
    const res = await this.post({
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "self-sown-seller-assistant", version: "1.0.0" },
      },
    });
    if (!res.ok) {
      const snippet = (await res.text().catch(() => "")).slice(0, 200);
      if (res.status === 401) {
        throw new McpAuthError(`MCP initialize rejected: ${snippet}`);
      }
      throw new Error(`MCP initialize failed: HTTP ${res.status} ${snippet}`);
    }
    this.sessionId = res.headers.get("mcp-session-id");
    const message = await parseRpcMessage(res);
    if (message.error) {
      throw new Error(
        `MCP initialize error ${message.error.code}: ${message.error.message}`
      );
    }
    // Best-effort initialized notification (202, no JSON-RPC response body).
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" })
      .then((r) => r.text())
      .catch(() => undefined);
  }

  private async call(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const res = await this.post({ jsonrpc: "2.0", id, method, params });
    if (!res.ok) {
      const snippet = (await res.text().catch(() => "")).slice(0, 200);
      if (res.status === 401) {
        throw new McpAuthError(`MCP ${method} rejected: ${snippet}`);
      }
      throw new Error(`MCP ${method} failed: HTTP ${res.status} ${snippet}`);
    }
    const message = await parseRpcMessage(res);
    if (message.error) {
      throw new Error(
        `MCP ${method} error ${message.error.code}: ${message.error.message}`
      );
    }
    return message.result;
  }

  async listTools(): Promise<McpToolDescriptor[]> {
    const result = (await this.call("tools/list", {})) as {
      tools?: McpToolDescriptor[];
    };
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  async callTool(
    name: string,
    args: Record<string, unknown>
  ): Promise<McpToolResult> {
    const result = (await this.call("tools/call", {
      name,
      arguments: args,
    })) as {
      content?: Array<{ type?: string; text?: string }>;
      isError?: boolean;
    };
    const blocks = Array.isArray(result?.content) ? result.content : [];
    const text = blocks
      .map((block) =>
        block?.type === "text" && typeof block.text === "string"
          ? block.text
          : JSON.stringify(block)
      )
      .join("\n");
    return { text, isError: Boolean(result?.isError) };
  }

  async close(): Promise<void> {
    if (!this.sessionId) return;
    try {
      await fetch(`${baseUrl()}/api/mcp`, {
        method: "DELETE",
        headers: this.headers(),
        signal: AbortSignal.timeout(CLOSE_TIMEOUT_MS),
      });
    } catch {
      // best effort — the server sweeps stale sessions on a TTL regardless
    }
    this.sessionId = null;
  }
}
