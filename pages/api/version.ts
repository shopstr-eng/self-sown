import type { NextApiRequest, NextApiResponse } from "next";
import { readFileSync } from "fs";
import path from "path";

// The running process serves exactly one build (the standalone server chdirs
// to its own bundle dir at boot, and a last-good server during a rebuild keeps
// reporting ITS build — so tabs it served never see a false mismatch). Read it
// once and cache it for the process lifetime.
let cachedBuildId: string | null = null;

export default function handler(_req: NextApiRequest, res: NextApiResponse) {
  if (!cachedBuildId) {
    try {
      cachedBuildId = readFileSync(
        path.join(process.cwd(), ".next", "BUILD_ID"),
        "utf8"
      ).trim();
    } catch {
      // `next dev` writes no BUILD_ID — callers treat "dev" as "never prompt".
      cachedBuildId = "dev";
    }
  }
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ buildId: cachedBuildId });
}
