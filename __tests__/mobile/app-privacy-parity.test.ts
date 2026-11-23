import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(__dirname, "../..");
const appConfig = readFileSync(
  path.join(root, "apps/mobile/app.config.ts"),
  "utf8"
);
const packageJson = JSON.parse(
  readFileSync(path.join(root, "apps/mobile/package.json"), "utf8")
) as { dependencies: Record<string, string> };
const privacyAnswers = readFileSync(
  path.join(root, "docs/apple-review/app-privacy-answers.md"),
  "utf8"
);

const dependencyNamePattern =
  /(async-storage|secure-store|document-picker|notifications|device|camera|location|contacts|image-picker|media-library|analytics|crash|sentry|firebase|stripe|square|payment|tracking|ads)/i;
const dependencyCollectionStatus: Record<
  string,
  "COLLECTED" | "NOT COLLECTED"
> = {
  "@react-native-async-storage/async-storage": "NOT COLLECTED",
  "@stripe/stripe-terminal-react-native": "COLLECTED",
  "expo-device": "COLLECTED",
  "expo-document-picker": "COLLECTED",
  "expo-notifications": "COLLECTED",
  "expo-secure-store": "NOT COLLECTED",
};

function configuredIosUsageDescriptions() {
  const configuredKeys = [
    ...appConfig.matchAll(/\b(NS\w+UsageDescription)\s*:/g),
  ].map(([, key]) => key);
  const entries = [
    ...appConfig.matchAll(/\b(NS\w+UsageDescription)\s*:\s*["']([^"']+)["']/g),
  ].map(([, key, description]) => ({ key, description }));
  expect(entries.map(({ key }) => key)).toEqual(configuredKeys);
  return entries;
}

function configuredAndroidPermissions() {
  const permissions = appConfig.match(/permissions\s*:\s*\[([\s\S]*?)\]/);
  const configuredPermissions = permissions?.[1];
  if (configuredPermissions === undefined) {
    throw new Error("Android permissions array is missing from app.config.ts");
  }
  return [...configuredPermissions.matchAll(/["']([^"']+)["']/g)].map(
    ([, value]) => value
  );
}

describe("App Privacy answers stay aligned with mobile configuration", () => {
  it("documents every configured iOS usage description and its purpose", () => {
    const usageDescriptions = configuredIosUsageDescriptions();
    expect(usageDescriptions.length).toBeGreaterThan(0);

    for (const { key, description } of usageDescriptions) {
      expect(privacyAnswers).toContain(`\`${key}\``);
      expect(privacyAnswers).toContain(description);
      expect(privacyAnswers).toMatch(
        new RegExp(
          `- \`${key}\` — [^\\n]*\\*\\*(?:COLLECTED|NOT COLLECTED):\\*\\*`
        )
      );
    }
  });

  it("documents every configured Android permission", () => {
    const permissions = configuredAndroidPermissions();
    expect(permissions.length).toBeGreaterThan(0);

    for (const permission of permissions) {
      expect(privacyAnswers).toContain(`\`${permission}\``);
      expect(privacyAnswers).toMatch(
        new RegExp(
          `- \`${permission}\` — \\*\\*(?:COLLECTED|NOT COLLECTED):\\*\\*`
        )
      );
    }
  });

  it("classifies every privacy-relevant direct dependency in the answers", () => {
    const privacyRelevantDependencies = Object.keys(packageJson.dependencies)
      .filter((name) => dependencyNamePattern.test(name))
      .sort();

    expect(Object.keys(dependencyCollectionStatus).sort()).toEqual(
      privacyRelevantDependencies
    );

    for (const dependency of privacyRelevantDependencies) {
      const status = dependencyCollectionStatus[dependency];
      expect(privacyAnswers).toContain(`- \`${dependency}\` — **${status}:`);
    }
  });
});
