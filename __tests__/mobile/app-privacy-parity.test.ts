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
const terminalEvidence = readFileSync(
  path.join(root, "docs/apple-review/stripe-terminal-privacy-evidence.md"),
  "utf8"
);
const publicPolicy = readFileSync(
  path.join(root, "pages/privacy/index.tsx"),
  "utf8"
).replace(/\s+/g, " ");
const androidEvidence = readFileSync(
  path.join(root, "docs/mobile/stripe-terminal-android-privacy-evidence.md"),
  "utf8"
);
const playLocationAnswers = readFileSync(
  path.join(root, "docs/mobile/google-play-payment-location-data-safety.md"),
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
  it("keeps Android payment-location answers separate from the iOS manifest", () => {
    expect(
      packageJson.dependencies["@stripe/stripe-terminal-react-native"]
    ).toBe("0.0.1-beta.34");
    expect(androidEvidence).toContain("6.0.0");
    expect(androidEvidence).toContain(
      "4a86db10fed7b2cfe9787ae1cf2a200b08562f33e43f7627397bbfb553b0bd27"
    );
    expect(androidEvidence).toContain(
      "ApiRequestFactory.ttpaRequestedCardPresent"
    );
    for (const type of ["Approximate location", "Precise location"]) {
      expect(playLocationAnswers).toContain(
        `| Location → ${type} | Yes | Yes | No | App functionality; Fraud prevention, security, and compliance |`
      );
    }
    expect(playLocationAnswers).toContain(
      "linkable to seller/device/account/payment"
    );
    expect(playLocationAnswers).toContain("purpose-based geolocation criteria");
    expect(playLocationAnswers).toContain("coordinate deletion deadline");
    expect(privacyAnswers).not.toContain(
      "Android collection review as unresolved"
    );
    expect(privacyAnswers).not.toContain(
      "**REVIEW REQUIRED:** location access"
    );
    expect(publicPolicy).toContain("On Android,");
    expect(publicPolicy).toContain(
      "can collect precise device location using GPS"
    );
    expect(publicPolicy).toContain("already sent to Stripe");
  });

  it("declares only the location precision supported by Stripe's native manifest", () => {
    expect(privacyAnswers).toContain(
      "| Location → Precise Location | No | — | — | — |"
    );
    expect(privacyAnswers).toContain(
      "| Location → Coarse Location | Yes | No | No | App Functionality |"
    );
    expect(terminalEvidence).toContain(
      "| NSPrivacyCollectedDataTypeCoarseLocation | false | false | NSPrivacyCollectedDataTypePurposeAppFunctionality |"
    );
    expect(terminalEvidence).toContain(
      "90f370b39edee8a45ab50c512d6c054e7d6d3304931a7aeef80916ea97010129"
    );
    expect(privacyAnswers).not.toContain("Verify Stripe Terminal collection");
    expect(privacyAnswers).not.toContain("does not read device location");
  });

  it("includes the same SDK's product interaction collection, not just location", () => {
    expect(privacyAnswers).toContain(
      "| Usage Data → Product Interaction | Yes | No | No | App Functionality; Analytics |"
    );
    expect(terminalEvidence).toContain(
      "| NSPrivacyCollectedDataTypeProductInteraction | false | false | NSPrivacyCollectedDataTypePurposeAnalytics; NSPrivacyCollectedDataTypePurposeAppFunctionality |"
    );
  });

  it("discloses SDK collection and retention limits in the public policy", () => {
    expect(publicPolicy).toContain("In-Person Payments & Device Location");
    expect(publicPolicy).toContain("collection of coarse");
    expect(publicPolicy).toContain("product-interaction");
    expect(publicPolicy).toContain("not linked to your identity");
    expect(publicPolicy).toContain(
      "does not declare precise location collection"
    );
    expect(publicPolicy).toContain(
      "does not separately collect or store device coordinates"
    );
    expect(publicPolicy).toContain(
      "Terminal-location-specific retention period"
    );
    expect(publicPolicy).toContain(
      "https://stripe.com/legal/privacy-center#how-long-will-stripe-keep-my-data"
    );
  });

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
          `- \`${permission}\` — \\*\\*(?:COLLECTED|NOT COLLECTED|REVIEW REQUIRED):\\*\\*`
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
