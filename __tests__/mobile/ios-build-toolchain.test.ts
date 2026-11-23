/** @jest-environment node */
import { readFileSync } from "node:fs";
import path from "node:path";
import config from "../../apps/mobile/app.config";

const mobile = path.resolve(__dirname, "../../apps/mobile");
const readJson = (file: string) =>
  JSON.parse(readFileSync(path.join(mobile, file), "utf8"));

test("production pins Xcode 27 without changing the local signing contract", () => {
  const eas = readJson("eas.json");
  expect(eas.build.production.ios).toEqual({
    image: "macos-tahoe-26.6-xcode-27.2",
    credentialsSource: "local",
  });
  expect(eas.build.production.autoIncrement).toBe(true);
  expect(eas.build.production.env.EXPO_NO_CAPABILITY_SYNC).toBe("1");
  expect(eas.cli.appVersionSource).toBe("remote");
  expect(readJson("package.json").scripts["submit:ios"]).toBe(
    "node scripts/submit-ios.mjs"
  );
});

test("the supported Expo scene migration is enabled for iOS 27 launches", () => {
  const pkg = readJson("package.json");
  const version = pkg.dependencies.expo
    .replace(/^[~^]/, "")
    .split(".")
    .map(Number);
  expect(version[0]).toBe(57);
  expect(version[1] > 0 || version[2] >= 23).toBe(true);
  const plugin = config.plugins?.find(
    (entry) => Array.isArray(entry) && entry[0] === "expo-build-properties"
  ) as [string, { ios: { enableSceneSupport: boolean } }];
  expect(plugin[1].ios.enableSceneSupport).toBe(true);
  expect(config.ios?.deploymentTarget).toBe("16.4");
  expect(
    config.ios?.entitlements?.[
      "com.apple.developer.proximity-reader.payment.acceptance"
    ]
  ).toBe(true);
});
