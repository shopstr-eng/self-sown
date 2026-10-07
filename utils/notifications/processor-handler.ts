import { timingSafeEqual } from "node:crypto";
import type { NextApiRequest, NextApiResponse } from "next";
export function createNotificationProcessorHandler(deps: {
  secret: () => string;
  enabled: () => boolean;
  process: () => Promise<unknown>;
}) {
  return async (req: NextApiRequest, res: NextApiResponse) => {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ error: "Method not allowed" });
    }
    const secret = deps.secret();
    const supplied = req.headers.authorization;
    const expected = `Bearer ${secret}`;
    if (
      secret.length < 32 ||
      typeof supplied !== "string" ||
      supplied.length > 4096 ||
      Buffer.byteLength(supplied) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
    )
      return res.status(401).json({ error: "Unauthorized" });
    if (!deps.enabled()) return res.status(200).json({ enabled: false });
    try {
      return res
        .status(200)
        .json({ enabled: true, result: await deps.process() });
    } catch {
      return res
        .status(503)
        .json({ error: "Notification processing unavailable" });
    }
  };
}
