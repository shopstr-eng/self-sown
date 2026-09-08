export function resolveMobileApiBaseUrl(
  value: string | undefined,
  platform: string,
  development: boolean
): string {
  if (!value?.trim()) {
    if (!development)
      throw new Error(
        "An HTTPS API deployment must be configured for release builds."
      );
    return platform === "android"
      ? "http://10.0.2.2:5000"
      : "http://127.0.0.1:5000";
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Invalid API deployment URL.");
  }
  const host = url.hostname.toLowerCase();
  const local =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host === "[::1]" ||
    host === "[::]" ||
    host.startsWith("[fc") ||
    host.startsWith("[fd") ||
    host.startsWith("[fe80:") ||
    /^(127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(
      host
    );
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["http:", "https:"].includes(url.protocol) ||
    (!development && (url.protocol !== "https:" || local))
  )
    throw new Error(
      "Release builds require a public HTTPS API deployment URL."
    );
  return url.toString().replace(/\/+$/, "");
}
