// Regenerate the App Store provisioning profile for com.selfsown.mobile with
// the Associated Domains capability enabled (app.config.ts declares
// applinks:self-sown.com and the existing profile predates it).
import { createSign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const KEYS = "/home/runner/workspace/apps/mobile/keys";
const KEY_ID = "L6BVCZ3K8J";
const ISSUER_ID = "b97421c6-8af2-4499-9f22-380ff90a165c";
const BUNDLE_IDENTIFIER = "com.selfsown.mobile";

function jwt() {
  const b64url = (buf) => Buffer.from(buf).toString("base64url");
  const header = b64url(
    JSON.stringify({ alg: "ES256", kid: KEY_ID, typ: "JWT" })
  );
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(
    JSON.stringify({
      iss: ISSUER_ID,
      iat: now,
      exp: now + 1100,
      aud: "appstoreconnect-v1",
    })
  );
  const signer = createSign("SHA256");
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(
    {
      key: readFileSync(`${KEYS}/asc-key.p8`, "utf8"),
      dsaEncoding: "ieee-p1363",
    },
    undefined
  );
  return `${header}.${payload}.${Buffer.from(signature).toString("base64url")}`;
}

async function api(method, path, body) {
  const response = await fetch(`https://api.appstoreconnect.apple.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${jwt()}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) {
    // 409 on capability creation just means it already exists.
    if (response.status === 409) return { conflict: true };
    throw new Error(
      `${method} ${path} -> ${response.status}: ${text.slice(0, 400)}`
    );
  }
  return text ? JSON.parse(text) : {};
}

// 1. Bundle ID resource
const bundleIds = await api(
  "GET",
  `/v1/bundleIds?filter[identifier]=${BUNDLE_IDENTIFIER}`
);
const bundleId = bundleIds.data?.[0]?.id;
if (!bundleId) throw new Error("bundle id not found in ASC");
console.log("bundleId:", bundleId);

// 2. Enable Associated Domains (409 = already on)
const capability = await api("POST", "/v1/bundleIdCapabilities", {
  data: {
    type: "bundleIdCapabilities",
    attributes: { capabilityType: "ASSOCIATED_DOMAINS" },
    relationships: { bundleId: { data: { type: "bundleIds", id: bundleId } } },
  },
});
console.log(
  "associated domains:",
  capability.conflict ? "already enabled" : "enabled"
);

// 3. Match the local distribution cert by content (serial formats differ)
const localCert = readFileSync(`${KEYS}/dist-cert.der`);
const certs = await api("GET", "/v1/certificates?limit=50");
const cert = (certs.data ?? []).find((entry) =>
  Buffer.from(entry.attributes.certificateContent, "base64").equals(localCert)
);
if (!cert)
  throw new Error("no ASC distribution certificate matches keys/dist-cert.der");
console.log("certificate:", cert.id, cert.attributes.displayName);

// 4. Fresh App Store profile including the new capability
const profile = await api("POST", "/v1/profiles", {
  data: {
    type: "profiles",
    attributes: {
      name: `Self-sown Vendor App Store ad-${Date.now()}`,
      profileType: "IOS_APP_STORE",
    },
    relationships: {
      bundleId: { data: { type: "bundleIds", id: bundleId } },
      certificates: { data: [{ type: "certificates", id: cert.id }] },
    },
  },
});
const content = profile.data?.attributes?.profileContent;
if (!content) throw new Error("profile creation returned no content");
writeFileSync(
  `${KEYS}/profile.mobileprovision`,
  Buffer.from(content, "base64")
);
console.log("profile written:", profile.data.attributes.name, profile.data.id);

// 5. Confirm the entitlement is inside the new profile (plist grep)
const raw = Buffer.from(content, "base64").toString("latin1");
console.log(
  "profile includes associated-domains:",
  raw.includes("com.apple.developer.associated-domains")
);
