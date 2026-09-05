/**
 * contained-relay: every relay session is deadline-bounded (DNS + connect +
 * response), socket errors are contained (never uncaught), and connections
 * are DNS-pinned to vetted public addresses unless explicitly operator-trusted.
 */

const FAKE_EVENT = { id: "c".repeat(64), kind: 10002, pubkey: "d".repeat(64) };

// jest.mock hoists above all declarations, so the fake class must live
// INSIDE the factory and be retrieved via requireMock afterwards.
jest.mock("ws", () => {
  type Handler = (...args: any[]) => void;
  const FAKE = { id: "c".repeat(64), kind: 10002, pubkey: "d".repeat(64) };
  class FakeWebSocket {
    static scenario:
      | "eose"
      | "silent"
      | "error"
      | "ok"
      | "nack"
      | "flood"
      | "oversize"
      | "junkflood"
      | "byteflood"
      | "pubjunk" = "eose";
    static lastOptions: any;
    static closeCount = 0;
    private handlers: Record<string, Handler[]> = {};
    constructor(_url: string, options?: any) {
      FakeWebSocket.lastOptions = options;
      if (FakeWebSocket.scenario === "silent") return; // never opens
      setTimeout(() => {
        if (FakeWebSocket.scenario === "error")
          this.emit("error", new Error("boom"));
        else this.emit("open");
      }, 0);
    }
    on(ev: string, cb: Handler) {
      (this.handlers[ev] ||= []).push(cb);
      return this;
    }
    private emit(ev: string, ...args: any[]) {
      for (const cb of this.handlers[ev] || []) cb(...args);
    }
    send(frame: string) {
      const msg = JSON.parse(frame);
      setTimeout(() => {
        if (msg[0] === "REQ") {
          if (FakeWebSocket.scenario === "eose") {
            this.emit(
              "message",
              Buffer.from(JSON.stringify(["EVENT", msg[1], FAKE]))
            );
            this.emit("message", Buffer.from(JSON.stringify(["EOSE", msg[1]])));
          } else if (FakeWebSocket.scenario === "flood") {
            for (let i = 0; i < 20; i++)
              this.emit(
                "message",
                Buffer.from(
                  JSON.stringify(["EVENT", msg[1], { ...FAKE, id: `${i}` }])
                )
              );
            this.emit("message", Buffer.from(JSON.stringify(["EOSE", msg[1]])));
          } else if (FakeWebSocket.scenario === "oversize") {
            this.emit(
              "message",
              Buffer.from(
                JSON.stringify([
                  "EVENT",
                  msg[1],
                  { ...FAKE, content: "y".repeat(70 * 1024) },
                ])
              )
            );
            this.emit("message", Buffer.from(JSON.stringify(["EOSE", msg[1]])));
          } else if (FakeWebSocket.scenario === "junkflood") {
            // 100 valid-JSON junk frames, then the real event — early budget
            // close must drop the session before the EVENT is processed.
            for (let i = 0; i < 100; i++)
              this.emit(
                "message",
                Buffer.from(JSON.stringify(["NOTICE", `spam ${i}`]))
              );
            this.emit(
              "message",
              Buffer.from(JSON.stringify(["EVENT", msg[1], FAKE]))
            );
          } else if (FakeWebSocket.scenario === "byteflood") {
            // 10 frames of 30KB — each under the per-frame cap, over the
            // cumulative byte budget in aggregate.
            for (let i = 0; i < 10; i++)
              this.emit(
                "message",
                Buffer.from(JSON.stringify(["NOTICE", "x".repeat(30 * 1024)]))
              );
            this.emit(
              "message",
              Buffer.from(JSON.stringify(["EVENT", msg[1], FAKE]))
            );
          }
        } else if (msg[0] === "EVENT") {
          if (FakeWebSocket.scenario === "pubjunk") {
            for (let i = 0; i < 100; i++)
              this.emit(
                "message",
                Buffer.from(JSON.stringify(["NOTICE", `spam ${i}`]))
              );
            this.emit(
              "message",
              Buffer.from(JSON.stringify(["OK", msg[1].id, true, ""]))
            );
          } else if (FakeWebSocket.scenario === "ok") {
            this.emit(
              "message",
              Buffer.from(JSON.stringify(["OK", msg[1].id, true, ""]))
            );
          } else if (FakeWebSocket.scenario === "nack") {
            this.emit(
              "message",
              Buffer.from(JSON.stringify(["OK", msg[1].id, false, "blocked"]))
            );
          }
        }
      }, 0);
    }
    close() {
      FakeWebSocket.closeCount++;
    }
  }
  return { __esModule: true, default: FakeWebSocket };
});
const FakeWebSocket = (jest.requireMock("ws") as any).default;

import {
  queryRelayEvents,
  publishEventToRelay,
} from "@/utils/nostr/contained-relay";

const FILTER = { kinds: [10002], authors: ["a".repeat(64)] };
const EVENT = { id: "b".repeat(64), kind: 1059 };

describe("contained-relay", () => {
  beforeEach(() => {
    FakeWebSocket.scenario = "eose";
    FakeWebSocket.lastOptions = undefined;
  });

  it("collects events until EOSE", async () => {
    await expect(
      queryRelayEvents("wss://relay.example", FILTER, { timeoutMs: 1000 })
    ).resolves.toEqual([FAKE_EVENT]);
  });

  it("caps the event stream locally and closes once the limit is reached", async () => {
    FakeWebSocket.scenario = "flood"; // 20 EVENTs for a limit:5 query
    const before = FakeWebSocket.closeCount;
    const events = await queryRelayEvents("wss://relay.example", FILTER, {
      timeoutMs: 1000,
    });
    expect(events.length).toBeLessThanOrEqual(5);
    expect(FakeWebSocket.closeCount).toBeGreaterThan(before);
  });

  it("drops an oversized frame and closes (bounded memory per session)", async () => {
    FakeWebSocket.scenario = "oversize";
    const before = FakeWebSocket.closeCount;
    await expect(
      queryRelayEvents("wss://relay.example", FILTER, { timeoutMs: 1000 })
    ).resolves.toEqual([]);
    expect(FakeWebSocket.closeCount).toBeGreaterThan(before);
    // and the frame-size bound is handed to the ws layer as well
    expect(FakeWebSocket.lastOptions.maxPayload).toBe(64 * 1024);
  });

  it("closes on a flood of valid junk frames before the real EVENT arrives", async () => {
    FakeWebSocket.scenario = "junkflood"; // 100 NOTICEs, then the real event
    const before = FakeWebSocket.closeCount;
    await expect(
      queryRelayEvents("wss://relay.example", FILTER, { timeoutMs: 1000 })
    ).resolves.toEqual([]); // EVENT never processed — budget closed first
    expect(FakeWebSocket.closeCount).toBeGreaterThan(before);
  });

  it("closes on a cumulative byte flood of individually-legal frames", async () => {
    FakeWebSocket.scenario = "byteflood"; // 10 × 30KB NOTICEs, then the event
    await expect(
      queryRelayEvents("wss://relay.example", FILTER, { timeoutMs: 1000 })
    ).resolves.toEqual([]);
  });

  it("publish fails closed on a junk flood even when an OK follows", async () => {
    FakeWebSocket.scenario = "pubjunk"; // 100 NOTICEs, then OK(true)
    await expect(
      publishEventToRelay("wss://relay.example", EVENT, { timeoutMs: 1000 })
    ).resolves.toBe(false);
  });

  it("a relay that never opens resolves empty at the deadline", async () => {
    FakeWebSocket.scenario = "silent";
    const start = Date.now();
    await expect(
      queryRelayEvents("wss://silent.example", FILTER, { timeoutMs: 50 })
    ).resolves.toEqual([]);
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it("a socket error resolves empty instead of throwing", async () => {
    FakeWebSocket.scenario = "error";
    await expect(
      queryRelayEvents("wss://bad.example", FILTER, { timeoutMs: 1000 })
    ).resolves.toEqual([]);
  });

  it("publish resolves true on OK ack, false on rejection ack", async () => {
    FakeWebSocket.scenario = "ok";
    await expect(
      publishEventToRelay("wss://relay.example", EVENT, { timeoutMs: 1000 })
    ).resolves.toBe(true);
    FakeWebSocket.scenario = "nack";
    await expect(
      publishEventToRelay("wss://relay.example", EVENT, { timeoutMs: 1000 })
    ).resolves.toBe(false);
  });

  it("publish is deadline-bounded when no OK arrives", async () => {
    FakeWebSocket.scenario = "eose"; // opens and accepts the frame, never OKs
    await expect(
      publishEventToRelay("wss://relay.example", EVENT, { timeoutMs: 50 })
    ).resolves.toBe(false);
  });

  it("pins connections through the public-only lookup unless allowPrivate", async () => {
    await queryRelayEvents("wss://relay.example", FILTER, { timeoutMs: 100 });
    expect(typeof FakeWebSocket.lastOptions.lookup).toBe("function");
    await queryRelayEvents("ws://127.0.0.1:14777", FILTER, {
      timeoutMs: 100,
      allowPrivate: true,
    });
    expect(FakeWebSocket.lastOptions.lookup).toBeUndefined();
  });

  it("the pinned lookup rejects private and allows public addresses (both callback shapes)", async () => {
    await queryRelayEvents("wss://relay.example", FILTER, { timeoutMs: 100 });
    const lookup = FakeWebSocket.lastOptions.lookup;
    const blocked = await new Promise<any[]>((r) =>
      lookup("127.0.0.1", {}, (...a: any[]) => r(a))
    );
    expect(blocked[0]).toBeInstanceOf(Error);
    const allowed = await new Promise<any[]>((r) =>
      lookup("8.8.8.8", {}, (...a: any[]) => r(a))
    );
    expect(allowed[0]).toBeNull();
    expect(allowed[1]).toBe("8.8.8.8");
    const all = await new Promise<any[]>((r) =>
      lookup("8.8.8.8", { all: true }, (...a: any[]) => r(a))
    );
    expect(all[0]).toBeNull();
    expect(Array.isArray(all[1])).toBe(true);
  });
});
