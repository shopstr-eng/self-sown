import { NextApiRequest, NextApiResponse } from "next";
import { Client } from "pg";
import { applyRateLimit } from "@/utils/rate-limit";

const RATE_LIMIT = { limit: 60, windowMs: 60 * 1000 };

// Column widths from the utm_tracking table (see initializeTables() in
// utils/db/db-service.ts). Values that exceed them are truncated with a
// warning instead of failing the insert with Postgres error 22001.
const UTM_COLUMN_LIMIT = 255;
const IP_COLUMN_LIMIT = 45;

function capColumn(
  value: unknown,
  limit: number,
  field: string
): string | null {
  if (value === undefined || value === null) return null;
  const str = String(value);
  if (str.length <= limit) return str;
  console.warn(
    `UTM tracking: truncating ${field} from ${str.length} to ${limit} chars`
  );
  return str.slice(0, limit);
}

// The edge appends the real client IP as the rightmost x-forwarded-for entry;
// the raw header can be a long comma-separated list that overflows the
// VARCHAR(45) ip_address column.
function clientIp(req: NextApiRequest): string | null {
  const forwarded = req.headers["x-forwarded-for"];
  const raw = Array.isArray(forwarded)
    ? forwarded[forwarded.length - 1]
    : forwarded;
  const ip =
    raw
      ?.split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .pop() || req.socket.remoteAddress;
  return ip ? capColumn(ip, IP_COLUMN_LIMIT, "ip_address") : null;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!(await applyRateLimit(req, res, "utm-tracking", RATE_LIMIT))) return;

  const {
    utm_source,
    utm_medium,
    utm_campaign,
    utm_term,
    utm_content,
    referrer,
    user_agent,
  } = req.body;

  const client = new Client({
    connectionString: process.env["DATABASE_URL"],
  });

  try {
    await client.connect();

    // Insert tracking data, capping every value at its column width so an
    // over-long field can never fail the insert with Postgres error 22001.
    const result = await client.query(
      `INSERT INTO utm_tracking
       (utm_source, utm_medium, utm_campaign, utm_term, utm_content, referrer, user_agent, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        capColumn(utm_source, UTM_COLUMN_LIMIT, "utm_source"),
        capColumn(utm_medium, UTM_COLUMN_LIMIT, "utm_medium"),
        capColumn(utm_campaign, UTM_COLUMN_LIMIT, "utm_campaign"),
        capColumn(utm_term, UTM_COLUMN_LIMIT, "utm_term"),
        capColumn(utm_content, UTM_COLUMN_LIMIT, "utm_content"),
        // referrer/user_agent are TEXT columns (unbounded); just coerce.
        referrer === undefined || referrer === null ? null : String(referrer),
        user_agent === undefined || user_agent === null
          ? null
          : String(user_agent),
        clientIp(req),
      ]
    );

    res.status(200).json({ success: true, id: result.rows[0].id });
  } catch (error) {
    console.error("Database error in UTM tracking:", error);
    res.status(500).json({
      error: "Internal server error",
      details: error instanceof Error ? error.message : String(error),
    });
  } finally {
    await client.end();
  }
}
