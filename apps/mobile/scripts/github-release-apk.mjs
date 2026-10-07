// Download a finished EAS preview (APK) build and publish it as a GitHub
// Release asset. Usage:
//   EXPO_TOKEN=... GH_PUSH_TOKEN=... node scripts/github-release-apk.mjs <eas-build-id> [tag]
// The release is created (or reused) on shopstr-eng/self-sown with the APK
// attached — binaries are never committed to the repo.
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const [buildId, tagArg] = process.argv.slice(2);
if (!buildId) {
  console.error("usage: github-release-apk.mjs <eas-build-id> [tag]");
  process.exit(1);
}

const repo = "shopstr-eng/self-sown";
const gh = (route, opts = {}) =>
  fetch(`https://api.github.com${route}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${process.env.GH_PUSH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      ...(opts.headers ?? {}),
    },
  });

// 1. Resolve the build artifact URL from EAS
const build = JSON.parse(
  execFileSync("npx", ["eas-cli", "build:view", buildId, "--json"], {
    encoding: "utf8",
    env: {
      ...process.env,
      EAS_PROJECT_ID: "0b827bc9-9288-4747-b7d3-b811bb384860",
    },
  })
);
if (build.status !== "FINISHED") {
  throw new Error(`build ${buildId} is ${build.status}, not FINISHED`);
}
const artifactUrl = build.artifacts?.buildUrl;
if (!artifactUrl) throw new Error("build has no downloadable artifact");
console.log(
  "build:",
  build.id,
  "| platform:",
  build.platform,
  "| version:",
  build.appVersion
);

// 2. Download the APK (Expo artifact endpoints accept the access token)
const artifactRes = await fetch(artifactUrl, {
  headers: { Authorization: `Bearer ${process.env.EXPO_TOKEN}` },
  redirect: "follow",
});
if (!artifactRes.ok)
  throw new Error(`artifact download failed: ${artifactRes.status}`);
const apkPath = "/tmp/self-sown-vendor.apk";
fs.writeFileSync(apkPath, Buffer.from(await artifactRes.arrayBuffer()));
const apkBytes = fs.statSync(apkPath).size;
console.log(`downloaded APK (${(apkBytes / 1e6).toFixed(1)} MB)`);

// 3. Create or reuse the GitHub release
const tag = tagArg ?? `mobile-v${build.appVersion ?? "0.1.0"}`;
let release = await gh(`/repos/${repo}/releases/tags/${tag}`).then((r) =>
  r.ok ? r.json() : null
);
if (!release) {
  release = await (
    await gh(`/repos/${repo}/releases`, {
      method: "POST",
      body: JSON.stringify({
        tag_name: tag,
        name: `Self-sown Vendor ${build.appVersion ?? "0.1.0"} — Android preview`,
        body: [
          "First preview build of the Self-sown Vendor mobile app (Android APK).",
          "",
          "Install: download the APK below and open it on an Android device (allow installs from unknown sources when prompted).",
          "",
          `- EAS build: https://expo.dev/accounts/shopstr-markets/projects/self-sown-mobile/builds/${build.id}`,
          `- Variant: staging (${build.appVersion}, build ${build.appBuildVersion ?? "?"})`,
        ].join("\n"),
        draft: true,
        prerelease: true,
      }),
    })
  ).json();
  console.log("draft release created:", release.html_url);
} else {
  // Immutable releases: assets only upload while the release is a draft.
  if (!release.draft)
    throw new Error(
      `Release ${tag} is already published and immutable; delete it or pick a new tag.`
    );
  console.log("reusing draft release:", release.html_url);
}

// 4. Upload the APK as a release asset (replace any prior asset of the same name)
const assetName = "self-sown-vendor.apk";
const existing = (release.assets ?? []).find((a) => a.name === assetName);
if (existing) {
  await gh(`/repos/${repo}/releases/assets/${existing.id}`, {
    method: "DELETE",
  });
  console.log("replaced existing asset");
}
const uploadUrl = release.upload_url.replace(
  "{?name,label}",
  `?name=${assetName}`
);
const up = await fetch(uploadUrl, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.GH_PUSH_TOKEN}`,
    "Content-Type": "application/vnd.android.package-archive",
  },
  body: fs.readFileSync(apkPath),
});
if (!up.ok)
  throw new Error(`asset upload failed: ${up.status} ${await up.text()}`);
console.log("APK attached:", (await up.json()).browser_download_url);

// 5. Publish now that assets are attached (immutable releases lock on publish)
const pub = await gh(`/repos/${repo}/releases/${release.id}`, {
  method: "PATCH",
  body: JSON.stringify({ draft: false }),
});
if (!pub.ok)
  throw new Error(`release publish failed: ${pub.status} ${await pub.text()}`);
console.log("release published");
