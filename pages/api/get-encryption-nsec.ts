import { NextApiRequest, NextApiResponse } from "next";

export default function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const encryptionNsec = process.env["ENCRYPTION_NSEC"];

  if (!encryptionNsec) {
    return res.status(500).json({ error: "Encryption key not configured" });
  }

  // Validate that it's a proper nsec format
  if (!encryptionNsec.startsWith("nsec")) {
    return res.status(500).json({ error: "Invalid encryption key format" });
  }

  res.status(200).json({ value: encryptionNsec });
}
