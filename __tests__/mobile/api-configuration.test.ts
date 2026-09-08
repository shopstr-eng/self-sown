/** @jest-environment node */
import { resolveMobileApiBaseUrl } from "../../apps/mobile/lib/api-configuration";
test("local development uses emulator-specific loopback", () => {
  expect(resolveMobileApiBaseUrl(undefined, "android", true)).toBe(
    "http://10.0.2.2:5000"
  );
  expect(resolveMobileApiBaseUrl(undefined, "ios", true)).toBe(
    "http://127.0.0.1:5000"
  );
});
test.each([
  undefined,
  "http://example.com",
  "https://localhost",
  "https://127.0.0.1",
  "https://10.0.2.2",
  "https://user:pass@example.com",
  "https://example.com?token=secret",
  "garbage",
])("release configuration rejects unsafe API URL %s", (url) => {
  expect(() => resolveMobileApiBaseUrl(url, "ios", false)).toThrow();
});
test("release accepts an explicit HTTPS deployment", () => {
  expect(
    resolveMobileApiBaseUrl("https://staging.example.com/", "ios", false)
  ).toBe("https://staging.example.com");
});
