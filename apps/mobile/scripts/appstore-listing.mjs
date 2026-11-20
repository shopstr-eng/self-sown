// Apply (or check) the App Store listing for com.selfsown.mobile from a single
// committed source of truth. The listing — description, keywords, support /
// marketing URLs, copyright, primary category, content rights, age rating and
// price — was originally filled with ad-hoc App Store Connect API calls, so a
// future version bump or app re-create had to re-derive every value by hand.
// This module holds the canonical copy (LISTING) and the API calls to apply it,
// driven by the same ES256 key as the other ASC scripts.
//
// Commands:
//   node scripts/appstore-listing.mjs check   # report drift vs the live listing
//   node scripts/appstore-listing.mjs apply   # write the canonical values
//
// `check` exits 1 when the live listing differs (usable as a CI gate).
//
// Env: APP_STORE_CONNECT_KEY_ID, APP_STORE_CONNECT_ISSUER_ID and the ES256 key
// (ASC_KEY_PATH, default apps/mobile/keys/asc-key.p8, or
// APP_STORE_CONNECT_PRIVATE_KEY). ASC_API_BASE_URL overrides the Apple endpoint
// (used by tests); ASC_APP_ID overrides app lookup, otherwise the app is
// resolved by bundle id.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const BUNDLE_ID = process.env.ASC_BUNDLE_ID ?? "com.selfsown.mobile";
export const DEFAULT_LOCALE = "en-US";
const API_BASE = (process.env.ASC_API_BASE_URL ?? "https://api.appstoreconnect.apple.com").replace(/\/$/, "");
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_KEY_PATH = path.resolve(SCRIPT_DIR, "..", "keys", "asc-key.p8");

// ---------------------------------------------------------------------------
// Canonical listing. This is the single source of truth: change it here, run
// `apply`, and the live listing follows. Keep it in step with
// docs/app-store-listing.md (the human-readable record).

export const LISTING = {
  app: {
    name: "Self-sown",
    subtitle: "Local food marketplace & POS",
    privacyPolicyUrl: "https://self-sown.com/privacy",
    // FOOD_AND_DRINK — the app is a marketplace + point of sale for food producers.
    primaryCategory: "FOOD_AND_DRINK",
    // The marketplace surfaces listings created by third-party sellers.
    contentRightsDeclaration: "USES_THIRD_PARTY_CONTENT",
  },
  version: {
    copyright: "2026 Self-sown",
    supportUrl: "https://self-sown.com/contact",
    marketingUrl: "https://self-sown.com",
    keywords: "farm,food,marketplace,farmer,produce,meat,eggs,honey,pos,tap to pay,local,sell",
    description: [
      "Self-sown is a marketplace and point-of-sale app for local food producers and artisan makers. Sell farm-fresh food - produce, meat, eggs, dairy, baked goods, honey, and preserves - directly to buyers, and take in-person card payments with Tap to Pay on iPhone.",
      "",
      "SELL",
      "- Create rich product listings with photos, pricing, and shipping options.",
      "- Take payments your way: Tap to Pay on iPhone for contactless cards and wallets, Lightning, Cashu ecash, cards (Stripe or Square), or cash.",
      "- Manage orders, inventory, and fulfillment in one place.",
      "- Run a custom storefront on your own domain, publish blog posts, and send email campaigns.",
      "- Get paid directly - payouts settle to your connected Stripe or Square account.",
      "",
      "SHOP",
      "- Browse a live marketplace of local producers.",
      "- Buy with Bitcoin (Lightning, Cashu), card, or cash, with guest checkout supported.",
      "- Track orders and message sellers directly, end to end encrypted.",
      "",
      "WHO IT'S FOR",
      "Farmers, ranchers, homesteaders, market vendors, bakers, beekeepers, and local artisan producers who want to sell directly - without platform gatekeeping.",
      "",
      "Built on the open Nostr protocol: you own your identity and your customers, and your store works with the tools and agents you choose.",
      "",
      "Self-sown is free to start. A Pro membership adds a custom domain, email flows, and agent access.",
    ].join("\n"),
  },
  // Age-rating questionnaire. With only messaging, social media and
  // user-generated content set, Apple rates the app 4+.
  ageRating: {
    advertising: false,
    alcoholTobaccoOrDrugUseOrReferences: "NONE",
    contests: "NONE",
    datingAndRelationships: false,
    gambling: false,
    gamblingSimulated: "NONE",
    gunsOrOtherWeapons: "NONE",
    healthOrWellnessTopics: false,
    lootBox: false,
    medicalOrTreatmentInformation: "NONE",
    messagingAndChat: true,
    parentalControls: false,
    profanityOrCrudeHumor: "NONE",
    sexualContentGraphicAndNudity: "NONE",
    sexualContentOrNudity: "NONE",
    sharedLocation: false,
    socialMedia: true,
    socialMediaAgeRestricted: false,
    horrorOrFearThemes: "NONE",
    matureOrSuggestiveThemes: "NONE",
    unrestrictedWebAccess: false,
    userGeneratedContent: true,
    violenceCartoonOrFantasy: "NONE",
    violenceRealisticProlongedGraphicOrSadistic: "NONE",
    violenceRealistic: "NONE",
    ageAssurance: false,
    ageRatingOverride: "NONE",
    ageRatingOverrideV2: "NONE",
    koreaAgeRatingOverride: "NONE",
  },
  // The app is free to download everywhere; the base territory is the US.
  pricing: { free: true, baseTerritory: "USA" },
};

// ---------------------------------------------------------------------------
// App Store Connect client (same ES256 contract as the sibling ASC scripts).

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
    const data =
      b64({ alg: "ES256", kid: keyId, typ: "JWT" }) +
      "." +
      b64({ iss: issuerId, iat: now, exp: now + 1100, aud: "appstoreconnect-v1" });
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
      throw new Error(`${method} ${route} -> ${res.status}: ${detail}`);
    }
    return json;
  };

  return { request };
}

// ---------------------------------------------------------------------------
// Resolution.

async function resolveApp(client, appIdArg) {
  if (appIdArg) {
    const res = await client.request("GET", `/v1/apps/${appIdArg}`);
    const app = res.data;
    if (!app) throw new Error(`no App Store Connect app with id ${appIdArg}`);
    return { id: app.id, bundleId: app.attributes?.bundleId, attributes: app.attributes };
  }
  const res = await client.request(
    "GET",
    `/v1/apps?filter[bundleId]=${encodeURIComponent(BUNDLE_ID)}&limit=1`
  );
  const app = res.data?.[0];
  if (!app) throw new Error(`no App Store Connect app with bundle id ${BUNDLE_ID}`);
  return { id: app.id, bundleId: app.attributes.bundleId, attributes: app.attributes };
}

async function resolveAppInfo(client, appId) {
  const res = await client.request("GET", `/v1/apps/${appId}/appInfos`);
  const info = (res.data ?? []).find(
    (i) => i.attributes?.state !== "READY_FOR_DISTRIBUTION" && i.attributes?.state !== "REMOVED_FROM_SALE"
  ) ?? res.data?.[0];
  if (!info) throw new Error("app has no appInfo");
  return info;
}

async function resolveVersion(client, appId, versionString) {
  const res = await client.request(
    "GET",
    `/v1/apps/${appId}/appStoreVersions?filter[platform]=IOS&limit=20&fields[appStoreVersions]=versionString,appStoreState,platform,copyright`
  );
  const versions = res.data ?? [];
  if (versionString) {
    const found = versions.find((v) => v.attributes.versionString === versionString);
    if (!found) throw new Error(`no iOS version ${versionString} on the app`);
    return found;
  }
  // Newest first; prefer the editable (not-yet-released) version.
  const editable = versions.find(
    (v) => v.attributes.appStoreState !== "READY_FOR_SALE"
  );
  const chosen = editable ?? versions[0];
  if (!chosen) throw new Error("the app has no iOS version");
  return chosen;
}

async function resolveLocalization(client, collectionPath, locale) {
  const res = await client.request("GET", `${collectionPath}?limit=200`);
  const list = res.data ?? [];
  // Prefer the requested locale; fall back to the app's primary locale.
  return list.find((l) => l.attributes?.locale === locale) ?? null;
}

async function fetchCategory(client, infoId) {
  const res = await client.request(
    "GET",
    `/v1/appInfos/${infoId}/primaryCategory`
  );
  return res.data?.id ?? null;
}

async function fetchAgeRating(client, infoId) {
  const res = await client.request(
    "GET",
    `/v1/appInfos/${infoId}/ageRatingDeclaration`
  );
  return res.data ?? null;
}

export function priceDrift(price, now = Date.now()) {
  const policy = LISTING.pricing;
  if (!price.exists) return [{ field: "pricing", detail: "no price schedule" }];
  const out = [];
  if (price.baseTerritory !== policy.baseTerritory) {
    out.push({
      field: "pricing.baseTerritory",
      from: price.baseTerritory,
      to: policy.baseTerritory,
    });
  }
  // Consider every manual price that is effective now or scheduled in the
  // future; an expired period (endDate in the past) is history and is ignored.
  const parsed = (d) => (d ? Date.parse(d) : null);
  const relevant = price.prices.filter((p) => {
    const end = parsed(p.endDate);
    return end === null || end > now;
  });
  if (!relevant.length) {
    out.push({ field: "pricing", detail: "no current or scheduled price" });
  }
  const paid = relevant.filter((p) => p.customerPrice !== "0.0");
  if (paid.length) {
    out.push({ field: "pricing", from: paid.map((p) => p.customerPrice).join(","), to: "free" });
  }
  return out;
}

async function fetchPrice(client, appId) {
  const sched = await client.request(
    "GET",
    `/v1/apps/${appId}/appPriceSchedule?include=baseTerritory`
  );
  const schedule = sched.data;
  if (!schedule) return { exists: false, baseTerritory: null, prices: [] };
  const baseTerritory = schedule.relationships?.baseTerritory?.data?.id ?? null;
  const manual = await client.request(
    "GET",
    `/v1/appPriceSchedules/${schedule.id}/manualPrices?include=appPricePoint&limit=200`
  );
  const points = new Map(
    (manual.included ?? []).map((p) => [p.id, p.attributes?.customerPrice ?? null])
  );
  const prices = (manual.data ?? []).map((p) => {
    const pricePoint = p.relationships?.appPricePoint?.data?.id ?? null;
    return {
      id: p.id,
      startDate: p.attributes?.startDate ?? null,
      endDate: p.attributes?.endDate ?? null,
      pricePoint,
      customerPrice: pricePoint ? points.get(pricePoint) ?? null : null,
    };
  });
  return { exists: true, baseTerritory, prices, scheduleId: schedule.id };
}

// ---------------------------------------------------------------------------
// Diffing. Every canonical field is compared to its live value so `apply` only
// writes what changed (and `check` reports exactly what would change).

function diffAppInfoLocalization(live) {
  const out = [];
  const { name, subtitle, privacyPolicyUrl } = LISTING.app;
  if (!live) return [{ field: "appInfoLocalization", detail: "missing" }];
  for (const [field, want] of Object.entries({ name, subtitle, privacyPolicyUrl })) {
    if ((live.attributes?.[field] ?? null) !== want) {
      out.push({ field: `app.${field}`, from: live.attributes?.[field] ?? null, to: want });
    }
  }
  return out;
}

function diffVersionLocalization(live) {
  if (!live) return [{ field: "versionLocalization", detail: "missing" }];
  const out = [];
  const wanted = {
    description: LISTING.version.description,
    keywords: LISTING.version.keywords,
    supportUrl: LISTING.version.supportUrl,
    marketingUrl: LISTING.version.marketingUrl,
  };
  for (const [field, want] of Object.entries(wanted)) {
    if ((live.attributes?.[field] ?? null) !== want) {
      out.push({ field: `version.${field}`, from: live.attributes?.[field] ?? null, to: want });
    }
  }
  return out;
}

function diffCategory(liveCategory) {
  return liveCategory === LISTING.app.primaryCategory
    ? []
    : [{ field: "app.primaryCategory", from: liveCategory, to: LISTING.app.primaryCategory }];
}

function diffContentRights(live) {
  return live === LISTING.app.contentRightsDeclaration
    ? []
    : [{ field: "app.contentRightsDeclaration", from: live ?? null, to: LISTING.app.contentRightsDeclaration }];
}

function diffCopyright(live) {
  return live === LISTING.version.copyright
    ? []
    : [{ field: "version.copyright", from: live ?? null, to: LISTING.version.copyright }];
}

export function diffAgeRating(declaration) {
  const live = declaration?.attributes ?? {};
  const out = [];
  for (const [field, want] of Object.entries(LISTING.ageRating)) {
    if (field in live && live[field] !== want) {
      out.push({ field: `ageRating.${field}`, from: live[field], to: want });
    }
  }
  return out;
}

// Aggregate the full drift list for a resolved app/version.
async function collectDrift(client, appId, app, info, version, locale) {
  const infoLoc = await resolveLocalization(
    client,
    `/v1/appInfos/${info.id}/appInfoLocalizations`,
    locale
  );
  const versionLoc = await resolveLocalization(
    client,
    `/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations`,
    locale
  );
  const category = await fetchCategory(client, info.id);
  const age = await fetchAgeRating(client, info.id);
  const price = await fetchPrice(client, appId);

  const drift = [
    ...diffAppInfoLocalization(infoLoc),
    ...diffCategory(category),
    ...diffAgeRating(age),
    ...diffContentRights(app?.attributes?.contentRightsDeclaration),
    ...diffVersionLocalization(versionLoc),
    ...diffCopyright(version.attributes?.copyright),
    ...(LISTING.pricing.free ? priceDrift(price) : []),
  ];
  return { drift, info, infoLoc, version, versionLoc, age, price, category };
}

// ---------------------------------------------------------------------------
// Commands.

function formatDrift(drift) {
  return drift
    .map((d) => {
      if (d.detail) return `  - ${d.field}: ${d.detail}`;
      const from = d.from === null || d.from === undefined ? "<unset>" : String(d.from);
      return `  - ${d.field}: ${JSON.stringify(from)} -> ${JSON.stringify(d.to)}`;
    })
    .join("\n");
}

export async function cmdCheck(client, opts) {
  const app = await resolveApp(client, opts.app);
  const info = await resolveAppInfo(client, app.id);
  const version = await resolveVersion(client, app.id, opts.version);
  const { drift } = await collectDrift(client, app.id, app, info, version, opts.locale);
  console.log(`App ${app.id} (${app.bundleId ?? BUNDLE_ID}), version ${version.attributes.versionString}`);
  if (!drift.length) {
    console.log("Listing is in sync with the canonical copy.");
    return 0;
  }
  console.log("\nLive listing differs from the canonical copy in App Store Connect:");
  console.log(formatDrift(drift));
  console.log("\nRun `apply` to bring the listing in sync.");
  return 1;
}

export async function cmdApply(client, opts) {
  const app = await resolveApp(client, opts.app);
  const info = await resolveAppInfo(client, app.id);
  const version = await resolveVersion(client, app.id, opts.version);
  const locale = opts.locale;
  const state = await collectDrift(client, app.id, app, info, version, locale);
  if (!state.drift.length) {
    console.log("Listing already matches the canonical copy; nothing to write.");
    return 0;
  }

  // One request per field group; ASC rejects unknown/unchanged-only bodies with
  // an empty attributes object, so only send groups that actually differ.
  const { infoLoc, versionLoc } = state;
  const { name, subtitle, privacyPolicyUrl } = LISTING.app;
  const infoAttrs = {};
  if (!infoLoc || (infoLoc.attributes?.name ?? null) !== name) infoAttrs.name = name;
  if (!infoLoc || (infoLoc.attributes?.subtitle ?? null) !== subtitle) infoAttrs.subtitle = subtitle;
  if (!infoLoc || (infoLoc.attributes?.privacyPolicyUrl ?? null) !== privacyPolicyUrl) {
    infoAttrs.privacyPolicyUrl = privacyPolicyUrl;
  }
  if (Object.keys(infoAttrs).length) {
    if (infoLoc) {
      await client.request("PATCH", `/v1/appInfoLocalizations/${infoLoc.id}`, {
        data: { type: "appInfoLocalizations", id: infoLoc.id, attributes: infoAttrs },
      });
      console.log("updated app info localization:", Object.keys(infoAttrs).join(", "));
    } else {
      await client.request("POST", "/v1/appInfoLocalizations", {
        data: {
          type: "appInfoLocalizations",
          attributes: { locale, ...infoAttrs },
          relationships: { appInfo: { data: { type: "appInfos", id: info.id } } },
        },
      });
      console.log(`created app info localization (${locale})`);
    }
  }

  if (diffCategory(state.category).length) {
    await client.request("PATCH", `/v1/appInfos/${info.id}`, {
      data: {
        type: "appInfos",
        id: info.id,
        relationships: {
          primaryCategory: {
            data: { type: "appCategories", id: LISTING.app.primaryCategory },
          },
        },
      },
    });
    console.log("set primary category:", LISTING.app.primaryCategory);
  }

  if (state.age && diffAgeRating(state.age).length) {
    await client.request("PATCH", `/v1/ageRatingDeclarations/${state.age.id}`, {
      data: {
        type: "ageRatingDeclarations",
        id: state.age.id,
        attributes: { ...LISTING.ageRating },
      },
    });
    console.log("updated age rating declaration");
  }

  const liveRights = app.attributes?.contentRightsDeclaration;
  if (liveRights !== LISTING.app.contentRightsDeclaration) {
    await client.request("PATCH", `/v1/apps/${app.id}`, {
      data: {
        type: "apps",
        id: app.id,
        attributes: { contentRightsDeclaration: LISTING.app.contentRightsDeclaration },
      },
    });
    console.log("set content rights:", LISTING.app.contentRightsDeclaration);
  }

  const versionAttrs = {
    description: LISTING.version.description,
    keywords: LISTING.version.keywords,
    supportUrl: LISTING.version.supportUrl,
    marketingUrl: LISTING.version.marketingUrl,
  };
  const missingVersionFields = !versionLoc
    ? Object.keys(versionAttrs)
    : Object.entries(versionAttrs)
        .filter(([field, want]) => (versionLoc.attributes?.[field] ?? null) !== want)
        .map(([field]) => field);
  if (missingVersionFields.length) {
    if (versionLoc) {
      const attrs = {};
      for (const field of missingVersionFields) attrs[field] = versionAttrs[field];
      await client.request("PATCH", `/v1/appStoreVersionLocalizations/${versionLoc.id}`, {
        data: { type: "appStoreVersionLocalizations", id: versionLoc.id, attributes: attrs },
      });
      console.log("updated version localization:", missingVersionFields.join(", "));
    } else {
      await client.request("POST", "/v1/appStoreVersionLocalizations", {
        data: {
          type: "appStoreVersionLocalizations",
          attributes: { locale, ...versionAttrs },
          relationships: {
            appStoreVersion: { data: { type: "appStoreVersions", id: version.id } },
          },
        },
      });
      console.log(`created version localization (${locale})`);
    }
  }

  if (version.attributes?.copyright !== LISTING.version.copyright) {
    await client.request("PATCH", `/v1/appStoreVersions/${version.id}`, {
      data: {
        type: "appStoreVersions",
        id: version.id,
        attributes: { copyright: LISTING.version.copyright },
      },
    });
    console.log("set copyright:", LISTING.version.copyright);
  }

  if (LISTING.pricing.free && priceDrift(state.price).length) {
    // Apple's API allows CREATE and GET on appPriceSchedules only, so an app
    // that already has a (non-free) schedule cannot be changed through it.
    if (state.price.exists) {
      throw new Error(
        "The app's price schedule is not free everywhere (base territory or a current/scheduled price is not free). " +
          "The App Store Connect API cannot change an existing price schedule — set the price in App Store Connect, then re-run `apply`."
      );
    }
    await setFreePrice(client, app.id, LISTING.pricing.baseTerritory);
    console.log("set price: free");
  }

  console.log("\nDone. Run `check` to confirm the listing matches the canonical copy.");
  return 0;
}

// Create the free price schedule (Apple's CreateAppPriceSchedule accepts the
// linked appPrices in the same request via a temporary id in `included`).
async function setFreePrice(client, appId, baseTerritory) {
  const points = await client.request(
    "GET",
    `/v1/apps/${appId}/appPricePoints?filter[territory]=${baseTerritory}&limit=200&fields[appPricePoints]=customerPrice`
  );
  const free = (points.data ?? []).find((p) => p.attributes?.customerPrice === "0.0");
  if (!free) {
    throw new Error(`no free price point found for ${baseTerritory}`);
  }
  // Apple requires inline-created resource ids to use the literal `${local-id}`
  // form, or the request fails ENTITY_ERROR.INCLUDED.INVALID_ID.
  const tempId = "${free}";
  await client.request("POST", "/v1/appPriceSchedules", {
    data: {
      type: "appPriceSchedules",
      relationships: {
        app: { data: { type: "apps", id: appId } },
        baseTerritory: { data: { type: "territories", id: baseTerritory } },
        manualPrices: { data: [{ type: "appPrices", id: tempId }] },
      },
    },
    included: [
      {
        type: "appPrices",
        id: tempId,
        attributes: { startDate: null },
        relationships: {
          appPricePoint: { data: { type: "appPricePoints", id: free.id } },
        },
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// CLI.

function parseArgs(argv) {
  const opts = { command: argv[0], locale: DEFAULT_LOCALE };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") continue;
    else if (arg === "--app") opts.app = argv[++i];
    else if (arg === "--version") opts.version = argv[++i];
    else if (arg === "--locale") opts.locale = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

const COMMANDS = { check: cmdCheck, apply: cmdApply };

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const run = COMMANDS[opts.command];
  if (!run) {
    console.error(
      `usage: appstore-listing.mjs <${Object.keys(COMMANDS).join("|")}> [--app <id>] [--version <x>] [--locale <l>]`
    );
    process.exit(2);
  }
  const client = createClient();
  const code = await run(client, opts);
  process.exit(code ?? 0);
}

// Only run the CLI when executed directly (so tests can import the exports).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`\n\u2717 ${error.message}\n`);
    process.exit(1);
  });
}
