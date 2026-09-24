// Temporary status server for the dev workflow: binds the preview port
// immediately on cold starts so the workflow's 300s port check passes while
// the (multi-minute, memory-gated) production build runs. dev-server.sh
// updates .next-dev-status to flip the message; this server is replaced by
// the real standalone server the moment a build succeeds.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const PORT = 5000;

const MESSAGES = {
  building: {
    title: "Building the app…",
    body: "A cold production build is running (this takes a few minutes on this container). The page refreshes itself.",
  },
  failed: {
    title: "Build failed — retrying automatically",
    body: "The build was killed (out of memory). It retries every few minutes and swaps in automatically when one succeeds. Details are in the workflow logs.",
  },
  broken: {
    title: "Build failed — code error",
    body: "The build failed with a compile error (not memory). Check the workflow logs, fix the error, and restart the workflow.",
  },
};

createServer((req, res) => {
  let key = "building";
  try {
    key = readFileSync(".next-dev-status", "utf8").trim() || "building";
  } catch {}
  const msg = MESSAGES[key] ?? MESSAGES.building;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><head><meta http-equiv="refresh" content="15">
<title>${msg.title}</title>
<style>body{font-family:ui-monospace,monospace;background:#111;color:#eee;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
div{max-width:34rem;padding:2rem;border:3px solid #eee;box-shadow:8px 8px 0 #555}h1{font-size:1.25rem;margin:0 0 .75rem}p{margin:0;line-height:1.5;color:#bbb}</style>
</head><body><div><h1>${msg.title}</h1><p>${msg.body}</p></div></body></html>`);
}).listen(PORT, "0.0.0.0", () => {
  console.log(`[dev-server] placeholder status page on :${PORT}`);
});
