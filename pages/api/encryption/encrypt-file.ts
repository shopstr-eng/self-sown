import { NextApiRequest, NextApiResponse } from "next";
import { applyRateLimit } from "@/utils/rate-limit";
import { verifyNip98Request } from "@/utils/nostr/nip98-auth";
import { encryptAgreementFile } from "@/utils/encryption/server-file-encryption";

// Base64 file payloads inflate ~33%; allow generous room for agreement PDFs.
export const config = {
  api: {
    bodyParser: {
      sizeLimit: "25mb",
    },
  },
};

const RATE_LIMIT = { limit: 30, windowMs: 60 * 1000 };

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!(await applyRateLimit(req, res, "encryption-encrypt-file", RATE_LIMIT)))
    return;

  const auth = await verifyNip98Request(req, "POST", req.body);
  if (!auth.ok) {
    return res.status(401).json({ error: auth.error });
  }

  const { fileBase64, encryptionNpub, originalFileName, originalSize } =
    req.body || {};

  if (
    typeof fileBase64 !== "string" ||
    !fileBase64 ||
    typeof encryptionNpub !== "string" ||
    !encryptionNpub
  ) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    const encryptedData = encryptAgreementFile(
      fileBase64,
      encryptionNpub,
      typeof originalFileName === "string" ? originalFileName : "agreement.pdf",
      typeof originalSize === "number" ? originalSize : 0
    );
    return res.status(200).json({ encryptedData });
  } catch (error) {
    console.error("Error encrypting agreement file:", error);
    return res.status(500).json({ error: "Failed to encrypt file" });
  }
}
