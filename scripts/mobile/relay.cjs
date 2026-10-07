const { WebSocketServer } = require("ws");
const { verifyEvent } = require("nostr-tools");
const fs = require("fs");
const path = require("node:path");
if (
  process.env.MILK_MOBILE_LOCAL_FIXTURES !== "1" ||
  !process.env.MILK_MOBILE_FIXTURE_DIR
)
  throw new Error("Explicit local fixtures required");
const server = new WebSocketServer({ host: "127.0.0.1", port: 5011 });
server.on("connection", (socket) =>
  socket.on("message", (raw) => {
    const message = JSON.parse(raw.toString());
    if (message[0] === "EVENT") {
      const event = message[1];
      const valid = verifyEvent(event);
      fs.appendFileSync(
        path.join(process.env.MILK_MOBILE_FIXTURE_DIR, "relay.jsonl"),
        JSON.stringify({ valid, event }) + "\n"
      );
      socket.send(
        JSON.stringify([
          "OK",
          event.id,
          valid,
          valid ? "" : "invalid signature",
        ])
      );
    } else if (message[0] === "REQ")
      socket.send(JSON.stringify(["EOSE", message[1]]));
  })
);
console.log("Local signature-checking test relay on 5011");
