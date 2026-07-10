import { NextApiRequest, NextApiResponse } from "next";
import { applyRateLimit } from "@/utils/rate-limit";
import { verifyNip98Request } from "@/utils/nostr/nip98-auth";
import {
  parseEncryptedContent,
  decryptAgreementFile,
} from "@/utils/encryption/server-file-encryption";

// Encrypted agreement blobs are larger than the source PDF; allow room for them.
export const config = {
  api: {
    bodyParser: {
      sizeLimit: "25mb",
    },
  },
};

const RATE_LIMIT = { limit: 60, windowMs: 60 * 1000 };

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!(await applyRateLimit(req, res, "encryption-decrypt-file", RATE_LIMIT)))
    return;

  const auth = await verifyNip98Request(req, "POST", req.body);
  if (!auth.ok) {
    return res.status(401).json({ error: auth.error });
  }

  const { encryptedContent, encryptionNpub } = req.body || {};

  if (
    typeof encryptedContent !== "string" ||
    !encryptedContent ||
    typeof encryptionNpub !== "string" ||
    !encryptionNpub
  ) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    const { chunks } = parseEncryptedContent(encryptedContent);
    const base64 = decryptAgreementFile(chunks, encryptionNpub);
    return res.status(200).json({ base64 });
  } catch (error) {
    console.error("Error decrypting agreement file:", error);
    return res.status(500).json({ error: "Failed to decrypt file" });
  }
}
