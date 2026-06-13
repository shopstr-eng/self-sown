import sgMail from "@sendgrid/mail";

interface SendGridCredentials {
  apiKey: string;
  email: string;
}

async function getCredentials(): Promise<SendGridCredentials> {
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY
    ? "repl " + process.env.REPL_IDENTITY
    : process.env.WEB_REPL_RENEWAL
      ? "depl " + process.env.WEB_REPL_RENEWAL
      : null;

  if (!xReplitToken) {
    throw new Error("X_REPLIT_TOKEN not found for repl/depl");
  }

  const response = await fetch(
    "https://" +
      hostname +
      "/api/v2/connection?include_secrets=true&connector_names=sendgrid",
    {
      headers: {
        Accept: "application/json",
        "X-Replit-Token": xReplitToken,
      },
    }
  );
  const data = await response.json();
  const connection = data.items?.[0];

  if (
    !connection ||
    !connection.settings.api_key ||
    !connection.settings.from_email
  ) {
    throw new Error("SendGrid not connected");
  }
  return {
    apiKey: connection.settings.api_key,
    email: connection.settings.from_email,
  };
}

export async function getUncachableSendGridClient() {
  const { apiKey, email } = await getCredentials();
  sgMail.setApiKey(apiKey);
  return {
    client: sgMail,
    fromEmail: email,
  };
}

/**
 * Returns the SendGrid API key for direct REST calls (e.g. the Domain
 * Authentication endpoints under /v3/whitelabel/domains, which the
 * `@sendgrid/mail` client does not cover). Never log the returned value.
 */
export async function getSendGridApiKey(): Promise<string> {
  const { apiKey } = await getCredentials();
  return apiKey;
}
