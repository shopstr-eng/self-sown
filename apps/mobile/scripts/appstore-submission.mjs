// Drive the App Store Connect submission of the Tap to Pay build: report what a
// version still needs, upload the required screenshots (iPhone 6.9" + iPad 13"),
// attach the Tap to Pay walkthrough video, and submit version 1.0 for review.
//
// The three steps that still require a human (capture device screenshots, publish
// App Privacy in the web UI, film the tap walkthrough) are documented in
// docs/apple-review/README.md; this CLI performs every remaining API action so
// the handoff is: produce assets -> run these commands.
//
// Commands:
//   node scripts/appstore-submission.mjs status
//   node scripts/appstore-submission.mjs screenshots --dir ./appstore-screenshots
//   node scripts/appstore-submission.mjs attachment --file ./tap-walkthrough.mp4
//   node scripts/appstore-submission.mjs submit --version 1.0
//
// Env: APP_STORE_CONNECT_KEY_ID, APP_STORE_CONNECT_ISSUER_ID and the ES256 key
// (ASC_KEY_PATH, default apps/mobile/keys/asc-key.p8, or APP_STORE_CONNECT_PRIVATE_KEY).
// ASC_API_BASE_URL overrides the Apple endpoint (used by tests). ASC_APP_ID
// overrides app lookup; otherwise the app is resolved by BUNDLE_ID.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const BUNDLE_ID = process.env.ASC_BUNDLE_ID ?? "com.selfsown.mobile";
const API_BASE = (process.env.ASC_API_BASE_URL ?? "https://api.appstoreconnect.apple.com").replace(/\/$/, "");
// Resolve the key relative to THIS script (apps/mobile/keys/asc-key.p8), not the
// working directory: pnpm --filter runs the command with cwd=apps/mobile, so a
// cwd-relative path would resolve to apps/mobile/apps/mobile/keys/...
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_KEY_PATH = path.resolve(SCRIPT_DIR, "..", "keys", "asc-key.p8");

// Apple's display types for the two device families this build requires
// (supportsTablet: true -> iPhone Dynamic Island set AND an iPad 13" set).
// Keyed by the ScreenshotDisplayType enum value; `sizes` are the accepted
// portrait dimensions (landscape is accepted reversed).
export const SCREENSHOT_SPECS = {
  APP_IPHONE_67: {
    label: 'iPhone 6.9" (Dynamic Island)',
    sizes: [
      [1290, 2796],
      [1320, 2868],
    ],
  },
  APP_IPAD_PRO_3GEN_129: {
    label: 'iPad 13"',
    sizes: [
      [2048, 2732],
      [2064, 2752],
    ],
  },
};
const REQUIRED_DISPLAY_TYPES = Object.keys(SCREENSHOT_SPECS);

// ---------------------------------------------------------------------------
// Image sizing (reads only the header; no image library in this repo).

function readPngSize(buf) {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buf.length < 24) return null;
  for (let i = 0; i < sig.length; i += 1) if (buf[i] !== sig[i]) return null;
  if (buf.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function readJpegSize(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let offset = 2;
  // SOF markers that carry frame dimensions (exclude DHT/DAC/etc.).
  const sof = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buf[offset + 1];
    // Standalone markers have no length payload.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const len = buf.readUInt16BE(offset + 2);
    if (sof.has(marker)) {
      return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
    }
    offset += 2 + len;
  }
  return null;
}

export function readImageSize(buf) {
  return readPngSize(buf) ?? readJpegSize(buf);
}

function matchesSize(size, [w, h]) {
  if (!size) return false;
  return (
    (size.width === w && size.height === h) ||
    (size.width === h && size.height === w)
  );
}

// Map a captured image to its ScreenshotDisplayType, or throw loudly with the
// accepted dimensions so a wrong export never reaches Apple.
export function classifyScreenshot(buf, fileName) {
  const size = readImageSize(buf);
  if (!size) {
    throw new Error(`${fileName}: not a readable PNG or JPEG`);
  }
  for (const [displayType, spec] of Object.entries(SCREENSHOT_SPECS)) {
    if (spec.sizes.some((s) => matchesSize(size, s))) return displayType;
  }
  const accepted = REQUIRED_DISPLAY_TYPES.map(
    (t) => `${t} (${SCREENSHOT_SPECS[t].sizes.map((s) => s.join("x")).join(" or ")})`
  ).join("; ");
  throw new Error(
    `${fileName}: ${size.width}x${size.height} is not an accepted App Store size. Accepted: ${accepted}`
  );
}

// ---------------------------------------------------------------------------
// App Store Connect client.

// Normalize a PEM that may have lost its line breaks (pasted secrets can arrive
// as one space-joined line) so crypto.sign() can parse it.
export function normalizePem(raw) {
  if (!raw) return raw;
  const text = raw.replace(/\\n/g, "\n").trim();
  const match = text.match(/-----BEGIN ([^-]+)-----\s*([\s\S]*?)\s*-----END \1-----/);
  if (!match) return text;
  const body = match[2].replace(/\s+/g, "");
  const lines = body.match(/.{1,64}/g) ?? [body];
  return `-----BEGIN ${match[1]}-----\n${lines.join("\n")}\n-----END ${match[1]}-----\n`;
}

function loadPrivateKey() {
  if (process.env.APP_STORE_CONNECT_PRIVATE_KEY) {
    return normalizePem(process.env.APP_STORE_CONNECT_PRIVATE_KEY);
  }
  const keyPath = process.env.ASC_KEY_PATH
    ? path.resolve(process.cwd(), process.env.ASC_KEY_PATH)
    : DEFAULT_KEY_PATH;
  if (!fs.existsSync(keyPath)) {
    throw new Error(
      `ASC private key not found at ${keyPath}. Set ASC_KEY_PATH or APP_STORE_CONNECT_PRIVATE_KEY.`
    );
  }
  return normalizePem(fs.readFileSync(keyPath, "utf8"));
}

export function createClient({ fetchImpl = fetch } = {}) {
  const keyId = process.env.APP_STORE_CONNECT_KEY_ID;
  const issuerId = process.env.APP_STORE_CONNECT_ISSUER_ID;
  if (!keyId || !issuerId) {
    throw new Error(
      "APP_STORE_CONNECT_KEY_ID and APP_STORE_CONNECT_ISSUER_ID are required"
    );
  }
  const key = loadPrivateKey();

  const token = () => {
    const now = Math.floor(Date.now() / 1000);
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const header = b64({ alg: "ES256", kid: keyId, typ: "JWT" });
    const payload = b64({
      iss: issuerId,
      iat: now,
      exp: now + 1100,
      aud: "appstoreconnect-v1",
    });
    const data = `${header}.${payload}`;
    // ieee-p1363 (raw r||s), NOT the default DER — Apple returns 401 for DER.
    const sig = crypto
      .sign("sha256", Buffer.from(data), { key, dsaEncoding: "ieee-p1363" })
      .toString("base64url");
    return `${data}.${sig}`;
  };

  const request = async (method, route, body) => {
    const res = await fetchImpl(`${API_BASE}${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${token()}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const json = res.status === 204 ? {} : await res.json().catch(() => ({}));
    if (!res.ok) {
      const detail = JSON.stringify(json.errors ?? json);
      const error = new Error(`${method} ${route} -> ${res.status}: ${detail}`);
      error.status = res.status;
      error.body = json;
      throw error;
    }
    return json;
  };

  // Upload an asset (screenshot/attachment) using Apple's two-phase contract:
  // create the resource, PUT each uploadOperation byte range, mark uploaded.
  const uploadAsset = async ({ createPath, resourceType, createBody, buffer, patchPath }) => {
    const created = await request("POST", createPath, createBody);
    const id = created.data.id;
    const ops = created.data.attributes?.uploadOperations ?? [];
    for (const op of ops) {
      const headers = {};
      for (const h of op.requestHeaders ?? []) headers[h.name] = h.value;
      const start = op.offset ?? 0;
      const chunk = buffer.subarray(start, start + op.length);
      const put = await fetchImpl(op.url, { method: op.method, headers, body: chunk });
      if (!put.ok) {
        throw new Error(`asset PUT failed: ${put.status} ${op.url.slice(0, 80)}`);
      }
    }
    await request("PATCH", patchPath ?? `${createPath}/${id}`, {
      data: { type: resourceType, id, attributes: { uploaded: true } },
    });
    return id;
  };

  return { request, uploadAsset };
}

// ---------------------------------------------------------------------------
// App / version resolution.

async function resolveApp(client, appIdArg) {
  if (appIdArg) return { id: appIdArg, bundleId: BUNDLE_ID };
  const res = await client.request(
    "GET",
    `/v1/apps?filter[bundleId]=${encodeURIComponent(BUNDLE_ID)}&limit=1`
  );
  const app = res.data?.[0];
  if (!app) throw new Error(`no App Store Connect app with bundle id ${BUNDLE_ID}`);
  return { id: app.id, bundleId: app.attributes.bundleId };
}

async function resolveVersion(client, appId, versionString) {
  const res = await client.request(
    "GET",
    `/v1/apps/${appId}/appStoreVersions?filter[platform]=IOS&limit=20&fields[appStoreVersions]=versionString,appStoreState,platform`
  );
  const versions = res.data ?? [];
  const found = versionString
    ? versions.find((v) => v.attributes.versionString === versionString)
    : versions[0];
  if (!found) {
    throw new Error(
      versionString
        ? `no iOS version ${versionString} on the app`
        : "the app has no iOS version"
    );
  }
  return found;
}

async function resolveLocalization(client, versionId) {
  const res = await client.request(
    "GET",
    `/v1/appStoreVersions/${versionId}/appStoreVersionLocalizations?limit=50`
  );
  const loc = res.data?.[0];
  if (!loc) throw new Error("version has no localization");
  return loc;
}

// App Store Connect only allows ONE draft reviewSubmissions per app to be reused,
// and does NOT allow DELETE on reviewSubmissions (403). Enumeration runs that
// created a fresh submission each time exhaust the per-app concurrency limit (5)
// with empty drafts and then no submission can ever be created again. So ALWAYS
// reuse an existing unsubmitted READY_FOR_REVIEW iOS submission, and only create
// one when the app has none.
async function resolveSubmission(client, appId) {
  const list = await client.request(
    "GET",
    `/v1/apps/${appId}/reviewSubmissions?limit=50&fields[reviewSubmissions]=platform,state,submittedDate`
  );
  const reusable = (list.data ?? []).find(
    (s) =>
      s.attributes.platform === "IOS" &&
      !s.attributes.submittedDate &&
      s.attributes.state === "READY_FOR_REVIEW"
  );
  if (reusable) return reusable.id;
  const created = await client.request("POST", "/v1/reviewSubmissions", {
    data: {
      type: "reviewSubmissions",
      attributes: { platform: "IOS" },
      relationships: { app: { data: { type: "apps", id: appId } } },
    },
  });
  return created.data.id;
}

// Resolve which App Store version (if any) each item on the submission stages.
// A reused draft can already hold a DIFFERENT version or another reviewable
// item; treating those as "our version is ready" would submit the wrong content.
async function submissionItems(client, submissionId) {
  const res = await client.request(
    "GET",
    `/v1/reviewSubmissions/${submissionId}/items?limit=50&include=appStoreVersion`
  );
  const out = [];
  for (const item of res.data ?? []) {
    let versionId = item.relationships?.appStoreVersion?.data?.id ?? null;
    if (!versionId) {
      const instance = await client.request(
        "GET",
        "/v1/reviewSubmissionItems/" + item.id + "?include=appStoreVersion"
      );
      versionId = instance.data?.relationships?.appStoreVersion?.data?.id ?? null;
    }
    out.push({ id: item.id, versionId });
  }
  return out;
}

// The app's draft submission + which of its items stage the requested version.
async function inspectDraft(client, appId, versionId) {
  const submissionId = await resolveSubmission(client, appId);
  const items = await submissionItems(client, submissionId);
  return {
    submissionId,
    hasVersion: items.some((i) => i.versionId === versionId),
    others: items.filter((i) => i.versionId !== versionId),
  };
}

function conflictMessage(draft) {
  return (
    `draft submission ${draft.submissionId} already stages other review content ` +
    `(${draft.others.length} item(s) not for this version); refusing to reuse it`
  );
}

async function addVersionItem(client, submissionId, versionId) {
  return client.request("POST", "/v1/reviewSubmissionItems", {
    data: {
      type: "reviewSubmissionItems",
      relationships: {
        reviewSubmission: { data: { type: "reviewSubmissions", id: submissionId } },
        appStoreVersion: { data: { type: "appStoreVersions", id: versionId } },
      },
    },
  });
}

// Enumerate exactly what a version still needs: stage the version on the app's
// draft submission and read the item's associatedErrors. When the version is
// clean the item is created and stays staged (that submission is what `submit`
// sends); when blockers exist nothing is created and we return the checklist.
async function enumerateBlockers(client, appId, versionId) {
  const draft = await inspectDraft(client, appId, versionId);
  if (draft.others.length) return { conflict: conflictMessage(draft) };
  if (draft.hasVersion) {
    console.log("version is already staged on the draft review submission");
    return { blockers: [] };
  }
  try {
    await addVersionItem(client, draft.submissionId, versionId);
    return { blockers: [] };
  } catch (error) {
    const associated = error.body?.errors?.[0]?.meta?.associatedErrors;
    if (associated) {
      // { "<jsonPointer>": [ { code, title, detail } ] }
      const blockers = Object.entries(associated).flatMap(([pointer, errs]) =>
        (errs ?? []).map((e) => ({
          pointer,
          code: e.code,
          title: e.title,
          detail: e.detail,
        }))
      );
      return { blockers };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Commands.

async function cmdStatus(client, opts) {
  const app = await resolveApp(client, opts.app);
  const version = await resolveVersion(client, app.id, opts.version);
  console.log(`App ${app.id} (${app.bundleId})`);
  console.log(
    `Version ${version.attributes.versionString} state=${version.attributes.appStoreState}`
  );

  const loc = await resolveLocalization(client, version.id);
  const sets = await client.request(
    "GET",
    `/v1/appStoreVersionLocalizations/${loc.id}/appScreenshotSets?limit=50`
  );
  console.log("\nScreenshot sets:");
  for (const s of sets.data ?? []) {
    const shots = await client.request(
      "GET",
      `/v1/appScreenshotSets/${s.id}/appScreenshots?limit=50`
    );
    console.log(`  ${s.attributes.screenshotDisplayType}: ${(shots.data ?? []).length}`);
  }
  const present = new Set((sets.data ?? []).map((s) => s.attributes.screenshotDisplayType));
  for (const t of REQUIRED_DISPLAY_TYPES) {
    if (!present.has(t)) console.log(`  ${t}: MISSING`);
  }

  const detail = await client.request(
    "GET",
    `/v1/appStoreVersions/${version.id}/appStoreReviewDetail`
  );
  const attachments = await client.request(
    "GET",
    `/v1/appStoreReviewDetails/${detail.data?.id}/appStoreReviewAttachments?limit=50`
  ).catch(() => ({ data: [] }));
  console.log(
    `\nReview detail: ${detail.data ? "present" : "MISSING"}; attachments: ${(attachments.data ?? []).length}`
  );

  const { blockers, conflict } = await enumerateBlockers(client, app.id, version.id);
  if (conflict) {
    console.log(`\n${conflict}`);
    return 1;
  }
  if (!blockers?.length) {
    console.log("\nNo API-reportable blockers — version is ready to submit.");
    return 0;
  }
  console.log("\nBlockers reported by App Store Connect:");
  for (const b of blockers) console.log(`  - [${b.code}] ${b.title}\n      ${b.detail}`);
  return 0;
}

function listImages(dir) {
  const entries = fs.readdirSync(dir).filter((f) => /\.(png|jpe?g)$/i.test(f));
  if (!entries.length) throw new Error(`no PNG/JPEG screenshots found in ${dir}`);
  return entries.map((f) => ({ file: path.join(dir, f), name: f }));
}

async function cmdScreenshots(client, opts) {
  if (!opts.dir) throw new Error("screenshots requires --dir <directory>");
  const app = await resolveApp(client, opts.app);
  const version = await resolveVersion(client, app.id, opts.version);
  const loc = await resolveLocalization(client, version.id);

  const byType = new Map();
  for (const { file, name } of listImages(opts.dir)) {
    const buf = fs.readFileSync(file);
    // classifyScreenshot throws loudly on a wrong size, before any write.
    const displayType = classifyScreenshot(buf, name);
    if (!byType.has(displayType)) byType.set(displayType, []);
    byType.get(displayType).push({ file, name, buf });
  }
  for (const t of REQUIRED_DISPLAY_TYPES) {
    if (!byType.has(t)) {
      throw new Error(
        `no images for ${SCREENSHOT_SPECS[t].label} (${t}); a build with supportsTablet needs both device sets`
      );
    }
  }

  const existing = await client.request(
    "GET",
    `/v1/appStoreVersionLocalizations/${loc.id}/appScreenshotSets?limit=50`
  );
  const existingByType = new Map(
    (existing.data ?? []).map((s) => [s.attributes.screenshotDisplayType, s])
  );

  // Validate every target set BEFORE writing anything, so a clobber or missing
  // device set never leaves one production set half-uploaded.
  for (const displayType of byType.keys()) {
    const set = existingByType.get(displayType);
    if (!set) continue;
    const shots = await client.request(
      "GET",
      `/v1/appScreenshotSets/${set.id}/appScreenshots?limit=50`
    );
    if ((shots.data ?? []).length && !opts.replace) {
      throw new Error(
        `${displayType} already has ${shots.data.length} screenshot(s); pass --replace to replace them`
      );
    }
  }

  for (const [displayType, images] of byType) {
    let set = existingByType.get(displayType);
    if (set) {
      const shots = await client.request(
        "GET",
        `/v1/appScreenshotSets/${set.id}/appScreenshots?limit=50`
      );
      for (const shot of shots.data ?? []) {
        await client.request("DELETE", `/v1/appScreenshots/${shot.id}`);
      }
    } else {
      const created = await client.request("POST", "/v1/appScreenshotSets", {
        data: {
          type: "appScreenshotSets",
          attributes: { screenshotDisplayType: displayType },
          relationships: {
            appStoreVersionLocalization: {
              data: { type: "appStoreVersionLocalizations", id: loc.id },
            },
          },
        },
      });
      set = created.data;
    }

    for (const img of images) {
      await client.uploadAsset({
        createPath: "/v1/appScreenshots",
        resourceType: "appScreenshots",
        createBody: {
          data: {
            type: "appScreenshots",
            attributes: { fileSize: img.buf.length, fileName: img.name },
            relationships: {
              appScreenshotSet: {
                data: { type: "appScreenshotSets", id: set.id },
              },
            },
          },
        },
        buffer: img.buf,
      });
      console.log(`uploaded ${img.name} -> ${displayType}`);
    }
  }
  console.log("\nScreenshots uploaded. Run `status` to confirm the sets are recognized.");
  return 0;
}

async function cmdAttachment(client, opts) {
  if (!opts.file) throw new Error("attachment requires --file <path>");
  const app = await resolveApp(client, opts.app);
  const version = await resolveVersion(client, app.id, opts.version);
  const detail = await client.request(
    "GET",
    `/v1/appStoreVersions/${version.id}/appStoreReviewDetail`
  );
  const detailId = detail.data?.id;
  if (!detailId) throw new Error("version has no App Review detail to attach to");
  const buf = fs.readFileSync(opts.file);
  const id = await client.uploadAsset({
    createPath: "/v1/appStoreReviewAttachments",
    resourceType: "appStoreReviewAttachments",
    createBody: {
      data: {
        type: "appStoreReviewAttachments",
        attributes: { fileName: path.basename(opts.file), fileSize: buf.length },
        relationships: {
          appStoreReviewDetail: {
            data: { type: "appStoreReviewDetails", id: detailId },
          },
        },
      },
    },
    buffer: buf,
  });
  console.log(`attached ${path.basename(opts.file)} (${id}) to the review detail`);
  return 0;
}

async function cmdSubmit(client, opts) {
  const app = await resolveApp(client, opts.app);
  const version = await resolveVersion(client, app.id, opts.version);
  const draft = await inspectDraft(client, app.id, version.id);
  if (draft.others.length) {
    throw new Error(conflictMessage(draft));
  }
  if (!draft.hasVersion) {
    // Throws (with the blocker checklist in the body) if the version is not
    // ready, so nothing is submitted.
    await addVersionItem(client, draft.submissionId, version.id);
  }
  await client.request("PATCH", `/v1/reviewSubmissions/${draft.submissionId}`, {
    data: {
      type: "reviewSubmissions",
      id: draft.submissionId,
      attributes: { submitted: true },
    },
  });
  console.log(
    `Submitted version ${version.attributes.versionString} for review (submission ${draft.submissionId}).`
  );
  return 0;
}

// ---------------------------------------------------------------------------
// CLI.

function parseArgs(argv) {
  const opts = { command: argv[0] };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") continue;
    else if (arg === "--dir") opts.dir = argv[++i];
    else if (arg === "--file") opts.file = argv[++i];
    else if (arg === "--version") opts.version = argv[++i];
    else if (arg === "--app") opts.app = argv[++i];
    else if (arg === "--replace") opts.replace = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

const COMMANDS = {
  status: cmdStatus,
  screenshots: cmdScreenshots,
  attachment: cmdAttachment,
  submit: cmdSubmit,
};

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const run = COMMANDS[opts.command];
  if (!run) {
    console.error(
      `usage: appstore-submission.mjs <${Object.keys(COMMANDS).join("|")}> [options]`
    );
    process.exit(2);
  }
  const client = createClient();
  const code = await run(client, opts);
  process.exit(code ?? 0);
}

main().catch((error) => {
  console.error(`\n\u2717 ${error.message}\n`);
  process.exit(1);
});
