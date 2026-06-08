#!/usr/bin/env node
// Generates a stable Ed25519 keypair for Web Bot Auth and prints the value to
// store in the WEB_BOT_AUTH_ED25519_PRIVATE_KEY secret. Run once, then add the
// printed base64 PKCS#8 string as a secret so the published signature directory
// stays stable across restarts and across horizontally-scaled instances.
//
//   node scripts/generate-web-bot-auth-key.mjs
//
// Keep the private key secret. Only the derived public key (shown below for
// reference) is ever published at /.well-known/http-message-signatures-directory.

import { generateKeyPairSync } from "node:crypto";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");

const pkcs8Der = privateKey.export({ format: "der", type: "pkcs8" });
const base64Pkcs8 = Buffer.from(pkcs8Der).toString("base64");

const publicJwk = publicKey.export({ format: "jwk" });

console.log("# Add this as a secret (do NOT commit it):");
console.log(`WEB_BOT_AUTH_ED25519_PRIVATE_KEY=${base64Pkcs8}`);
console.log("");
console.log("# Public JWK that will be published (for reference only):");
console.log(JSON.stringify(publicJwk, null, 2));
