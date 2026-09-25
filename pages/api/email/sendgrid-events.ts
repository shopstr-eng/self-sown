import type { NextApiRequest, NextApiResponse } from "next";
import { applyRateLimit } from "@/utils/rate-limit";
import {
  processSendGridEvents,
  verifySendGridEventSignature,
} from "@/utils/email/sendgrid-events";

// SendGrid Event Webhook receiver: records asynchronous bounce/dropped/
// spamreport events as per-seller 'suppressed' unsubscribes so future
// broadcasts stop re-emailing addresses SendGrid accepted-then-bounced.
// Auth is SendGrid's signed-request scheme (Ed25519 over timestamp+body) —
// enable "Signed Event Webhook Requests" in SendGrid and set
// SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY to its verification key.
export const config = {
  api: {
    bodyParser: false,
  },
};

// bodyParser is disabled for signature verification, which also removes
// Next.js's body-size limit — so cap the stream ourselves BEFORE any
// verification work. Event batches are small (each event is a few hundred
// bytes); 512 KB is generous headroom, and anything larger is rejected
// without buffering it into memory.
const MAX_BODY_BYTES = 512 * 1024;

class PayloadTooLargeError extends Error {}

async function getRawBody(req: NextApiRequest): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new PayloadTooLargeError("Payload too large"));
        return;
      }
      chunks.push(new Uint8Array(chunk));
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  if (
    !(await applyRateLimit(req, res, "email-sendgrid-events", {
      limit: 300,
      windowMs: 60_000,
    }))
  )
    return;

  // Fail closed: with no verification key configured there is no way to tell
  // a real SendGrid event from a forged one, and a forged "bounce" batch
  // would let anyone silently wipe a seller's email audience.
  const publicKey = process.env.SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY;
  if (!publicKey) {
    console.error(
      "SendGrid events: SENDGRID_EVENT_WEBHOOK_PUBLIC_KEY is not configured"
    );
    return res.status(401).json({ error: "Unauthorized" });
  }

  let rawBody: Buffer;
  try {
    rawBody = await getRawBody(req);
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      return res.status(413).json({ error: "Payload too large" });
    }
    throw error;
  }
  const signature = req.headers["x-twilio-email-event-webhook-signature"];
  const timestamp = req.headers["x-twilio-email-event-webhook-timestamp"];
  if (
    typeof signature !== "string" ||
    typeof timestamp !== "string" ||
    !verifySendGridEventSignature(publicKey, signature, timestamp, rawBody)
  ) {
    return res.status(401).json({ error: "Invalid signature" });
  }

  let events: unknown;
  try {
    events = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return res.status(400).json({ error: "Invalid JSON" });
  }

  const result = await processSendGridEvents(events);
  // Always 200 once verified: per-event suppression is best-effort (the cron
  // suppression-list sync re-covers any missed write), and a non-2xx makes
  // SendGrid re-post the whole batch.
  return res.status(200).json({ ok: true, ...result });
}
