import { NextApiRequest, NextApiResponse } from "next";
import { Client } from "pg";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

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

    // Create table if it doesn't exist
    await client.query(`
      CREATE TABLE IF NOT EXISTS utm_tracking (
        id SERIAL PRIMARY KEY,
        utm_source VARCHAR(255),
        utm_medium VARCHAR(255),
        utm_campaign VARCHAR(255),
        utm_term VARCHAR(255),
        utm_content VARCHAR(255),
        referrer TEXT,
        user_agent TEXT,
        ip_address VARCHAR(45),
        visited_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Get IP address from request
    const ip_address =
      req.headers["x-forwarded-for"] || req.socket.remoteAddress || null;

    // Insert tracking data
    const result = await client.query(
      `INSERT INTO utm_tracking 
       (utm_source, utm_medium, utm_campaign, utm_term, utm_content, referrer, user_agent, ip_address) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        utm_source,
        utm_medium,
        utm_campaign,
        utm_term,
        utm_content,
        referrer,
        user_agent,
        ip_address,
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
