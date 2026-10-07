// One-time iOS signing setup for CI/non-interactive EAS builds.
// Creates: distribution certificate, bundle ID (with push capability),
// App Store provisioning profile — via the App Store Connect API —
// then assembles keys/dist-cert.p12 + credentials.json for EAS local credentials.
// Requires env: APP_STORE_CONNECT_KEY_ID, APP_STORE_CONNECT_ISSUER_ID,
// and keys/asc-key.p8 on disk.
// Re-run safe: reuses a cert whose private key we still hold (keys/dist-key.pem);
// only deletes certs/profiles it can prove are orphans of a failed run
// (no local key match) after logging them loudly.
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const KEYS_DIR = path.resolve(process.cwd(), "keys");
const ASC_KEY = path.join(KEYS_DIR, "asc-key.p8");
const DIST_KEY = path.join(KEYS_DIR, "dist-key.pem");
const BUNDLE_ID = "com.selfsown.mobile";
const BUNDLE_NAME = "Self-sown Vendor";
const PROFILE_NAME = `${BUNDLE_NAME} App Store`;

const jwt = () => {
  const key = fs.readFileSync(ASC_KEY, "utf8");
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const data =
    b64({
      alg: "ES256",
      kid: process.env.APP_STORE_CONNECT_KEY_ID,
      typ: "JWT",
    }) +
    "." +
    b64({
      iss: process.env.APP_STORE_CONNECT_ISSUER_ID,
      iat: now,
      exp: now + 1100,
      aud: "appstoreconnect-v1",
    });
  const sig = crypto
    .sign("sha256", Buffer.from(data), { key, dsaEncoding: "ieee-p1363" })
    .toString("base64url");
  return `${data}.${sig}`;
};

const api = async (method, route, body) => {
  const res = await fetch(`https://api.appstoreconnect.apple.com${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${jwt()}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 204) return {};
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `${method} ${route} -> ${res.status}: ${JSON.stringify(json.errors ?? json)}`
    );
  }
  return json;
};

const openssl = (args, opts = {}) =>
  execFileSync("openssl", args, { encoding: "utf8", ...opts });

const modulus = (args) => {
  try {
    return openssl(args).trim();
  } catch {
    return null;
  }
};

// 1. Resolve the distribution certificate: reuse if the local key matches,
//    otherwise delete orphans left by failed runs, then create fresh.
const existingCerts =
  (
    await api(
      "GET",
      "/v1/certificates?filter[certificateType]=IOS_DISTRIBUTION&limit=10"
    )
  ).data ?? [];

let certId = null;
const localMod = fs.existsSync(DIST_KEY)
  ? modulus(["rsa", "-in", DIST_KEY, "-noout", "-modulus"])
  : null;

for (const cert of existingCerts) {
  fs.writeFileSync(
    path.join(KEYS_DIR, "existing-cert.pem"),
    Buffer.from(cert.attributes.certificateContent, "base64")
  );
  const certMod = modulus([
    "x509",
    "-inform",
    "DER",
    "-in",
    path.join(KEYS_DIR, "existing-cert.pem"),
    "-noout",
    "-modulus",
  ]);
  if (localMod && certMod && localMod === certMod) {
    certId = cert.id;
    fs.copyFileSync(
      path.join(KEYS_DIR, "existing-cert.pem"),
      path.join(KEYS_DIR, "dist-cert.pem")
    );
    console.log("reusing existing certificate (local key matches):", certId);
  } else {
    console.log(
      `deleting orphaned distribution certificate ${cert.id} (created by a failed run; no local private key matches)`
    );
    await api("DELETE", `/v1/certificates/${cert.id}`);
  }
}

if (!certId) {
  openssl(["genrsa", "-out", DIST_KEY, "2048"]);
  execFileSync("chmod", ["600", DIST_KEY]);
  const csr = openssl([
    "req",
    "-new",
    "-key",
    DIST_KEY,
    "-subj",
    `/CN=${BUNDLE_NAME} Distribution`,
    "-outform",
    "PEM",
  ]);
  const cert = await api("POST", "/v1/certificates", {
    data: {
      type: "certificates",
      attributes: { certificateType: "IOS_DISTRIBUTION", csrContent: csr },
    },
  });
  certId = cert.data.id;
  // certificateContent is base64 DER — store DER, convert to PEM via openssl
  fs.writeFileSync(
    path.join(KEYS_DIR, "dist-cert.der"),
    Buffer.from(cert.data.attributes.certificateContent, "base64")
  );
  openssl([
    "x509",
    "-inform",
    "DER",
    "-in",
    path.join(KEYS_DIR, "dist-cert.der"),
    "-out",
    path.join(KEYS_DIR, "dist-cert.pem"),
  ]);
  console.log("distribution certificate created:", certId);
}
fs.rmSync(path.join(KEYS_DIR, "existing-cert.pem"), { force: true });

// 2. Delete stale profiles for this app (they reference dead certs)
const profiles =
  (
    await api(
      "GET",
      `/v1/profiles?filter[name]=${encodeURIComponent(PROFILE_NAME)}&limit=20`
    )
  ).data ?? [];
for (const p of profiles) {
  console.log("deleting stale provisioning profile:", p.id);
  await api("DELETE", `/v1/profiles/${p.id}`);
}

// 3. Bundle ID (reuse if already registered)
const existingBid = await api(
  "GET",
  `/v1/bundleIds?filter[identifier]=${encodeURIComponent(BUNDLE_ID)}`
);
let bundleId;
if (existingBid.data.length > 0) {
  bundleId = existingBid.data[0].id;
  console.log("bundle ID already registered:", bundleId);
} else {
  const bid = await api("POST", "/v1/bundleIds", {
    data: {
      type: "bundleIds",
      attributes: { identifier: BUNDLE_ID, name: BUNDLE_NAME, platform: "IOS" },
    },
  });
  bundleId = bid.data.id;
  console.log("bundle ID registered:", bundleId);
}

// 4. Push Notifications capability (expo-notifications adds aps-environment)
try {
  await api("POST", "/v1/bundleIdCapabilities", {
    data: {
      type: "bundleIdCapabilities",
      attributes: { capabilityType: "PUSH_NOTIFICATIONS" },
      relationships: {
        bundleId: { data: { type: "bundleIds", id: bundleId } },
      },
    },
  });
  console.log("push capability enabled");
} catch (e) {
  console.log(
    "push capability:",
    e.message,
    "(continuing — may already be enabled)"
  );
}

// 5. App Store provisioning profile
const profile = await api("POST", "/v1/profiles", {
  data: {
    type: "profiles",
    attributes: { name: PROFILE_NAME, profileType: "IOS_APP_STORE" },
    relationships: {
      bundleId: { data: { type: "bundleIds", id: bundleId } },
      certificates: { data: [{ type: "certificates", id: certId }] },
    },
  },
});
fs.writeFileSync(
  path.join(KEYS_DIR, "profile.mobileprovision"),
  Buffer.from(profile.data.attributes.profileContent, "base64")
);
console.log("provisioning profile created:", profile.data.id);

// 6. .p12 + credentials.json for EAS local credentials
// The legacy PBE/MAC algorithms are required: OpenSSL 3 defaults (AES-256,
// SHA-256 MAC) produce a p12 that macOS keychain import on the EAS worker
// rejects with "could not verify the PKCS#12 MAC".
const p12Password = crypto.randomBytes(12).toString("hex");
openssl([
  "pkcs12",
  "-export",
  "-out",
  path.join(KEYS_DIR, "dist-cert.p12"),
  "-inkey",
  DIST_KEY,
  "-in",
  path.join(KEYS_DIR, "dist-cert.pem"),
  "-certpbe",
  "PBE-SHA1-3DES",
  "-keypbe",
  "PBE-SHA1-3DES",
  "-macalg",
  "SHA1",
  "-password",
  `pass:${p12Password}`,
]);
fs.writeFileSync(
  path.resolve(process.cwd(), "credentials.json"),
  JSON.stringify(
    {
      ios: {
        [BUNDLE_ID]: {
          provisioningProfilePath: "keys/profile.mobileprovision",
          distributionCertificate: {
            path: "keys/dist-cert.p12",
            password: p12Password,
          },
        },
      },
    },
    null,
    2
  )
);
console.log("credentials.json assembled — EAS local credentials ready");
