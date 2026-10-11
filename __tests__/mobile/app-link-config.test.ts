/** @jest-environment node */

// Guards the universal-link wiring that lets the account-recovery email open
// directly in the installed app: iOS associatedDomains and the Android
// autoVerify intent filter must stay pointed at the platform host's
// /auth/recover path, matching the AASA/assetlinks files served by
// pages/api/.well-known/ (covered by __tests__/api/well-known/app-link-association.test.ts).

import config from "../../apps/mobile/app.config";

test("iOS declares the platform host as an associated domain", () => {
  expect(config.ios?.associatedDomains).toContain("applinks:self-sown.com");
});

test("Android auto-verifies https recovery links on the platform host", () => {
  const filters = config.android?.intentFilters ?? [];
  const recovery = filters.find((f: any) =>
    (f.data ?? []).some(
      (d: any) =>
        d.scheme === "https" &&
        d.host === "self-sown.com" &&
        d.pathPrefix === "/auth/recover"
    )
  );
  expect(recovery).toBeDefined();
  if (!recovery) throw new Error("recovery intent filter missing");
  expect(recovery.autoVerify).toBe(true);
  expect(recovery.action).toBe("VIEW");
  expect(recovery.category).toEqual(
    expect.arrayContaining(["BROWSABLE", "DEFAULT"])
  );
});
