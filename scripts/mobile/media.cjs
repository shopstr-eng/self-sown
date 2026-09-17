// Loopback-only Blossom fixture. The production app never imports this server.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { verifyEvent } = require("nostr-tools");
if (
  process.env.MILK_MOBILE_LOCAL_FIXTURES !== "1" ||
  !process.env.MILK_MOBILE_FIXTURE_DIR
)
  throw new Error("Explicit local fixtures required");
const directory = process.env.MILK_MOBILE_FIXTURE_DIR;
const media = path.join(directory, "media");
fs.mkdirSync(media, { recursive: true });
http
  .createServer(async (req, res) => {
    const send = (status, data) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    };
    if (req.method === "GET" && /^\/[a-f0-9]{64}\.png$/.test(req.url)) {
      const file = path.join(media, req.url.slice(1));
      if (!fs.existsSync(file)) return send(404, { error: "Not found" });
      res.writeHead(200, { "Content-Type": "image/png" });
      fs.createReadStream(file).pipe(res);
      return;
    }
    if (req.method !== "PUT" || req.url !== "/upload")
      return send(404, { error: "Not found" });
    try {
      const chunks = [];
      let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 10 * 1024 * 1024) return send(413, { error: "Too large" });
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      const hash = createHash("sha256").update(bytes).digest("hex");
      const event = JSON.parse(
        Buffer.from(
          (req.headers.authorization || "").replace(/^Nostr /, ""),
          "base64"
        ).toString()
      );
      const tag = (key) => event.tags.find((row) => row[0] === key)?.[1];
      if (
        !verifyEvent(event) ||
        event.kind !== 24242 ||
        tag("t") !== "upload" ||
        tag("x") !== hash ||
        Number(tag("size")) !== bytes.length ||
        Number(tag("expiration")) <= Date.now() / 1000 ||
        req.headers["x-sha-256"] !== hash
      )
        return send(401, { error: "Invalid signed upload" });
      const controlsPath = path.join(directory, "media-controls.json");
      const controls = fs.existsSync(controlsPath)
        ? JSON.parse(fs.readFileSync(controlsPath, "utf8"))
        : {};
      fs.appendFileSync(
        path.join(directory, "media.jsonl"),
        JSON.stringify({
          valid: true,
          sha256: hash,
          size: bytes.length,
          failed: !!controls.failUploads,
        }) + "\n"
      );
      if (controls.failUploads)
        return send(503, { error: "Fixture upload unavailable" });
      fs.writeFileSync(path.join(media, `${hash}.png`), bytes);
      send(200, {
        url: `http://127.0.0.1:5012/${hash}.png`,
        sha256: hash,
        size: bytes.length,
        type: "image/png",
      });
    } catch {
      send(400, { error: "Invalid upload request" });
    }
  })
  .listen(5012, "127.0.0.1", () =>
    console.log("Local signed-upload fixture on 5012")
  );
