// Explicit local preload only. Never imported by the application or deploy build.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
if (
  process.env.MILK_MOBILE_LOCAL_FIXTURES !== "1" ||
  !process.env.MILK_MOBILE_FIXTURE_DIR ||
  !/^postgres(?:ql)?:\/\/milk_mobile:milk_mobile_local@127\.0\.0\.1:55436\/milk_mobile$/.test(
    process.env.DATABASE_URL || ""
  )
)
  throw new Error("Local fixture isolation is required.");
const directory = process.env.MILK_MOBILE_FIXTURE_DIR;
fs.mkdirSync(directory, { recursive: true });
// SDKs can use Node's HTTP transport rather than fetch (notably Stripe).
for (const transport of [require("node:http"), require("node:https")]) {
  for (const method of ["request", "get"]) {
    const original = transport[method];
    transport[method] = function (input, ...args) {
      const hostname =
        typeof input === "string" || input instanceof URL
          ? new URL(input).hostname
          : String(input?.hostname || input?.host || "").split(":")[0];
      if (
        /(^|\.)(stripe\.com|sendgrid\.net|goshippo\.com|exp\.host)$/i.test(
          hostname
        )
      )
        throw new Error("External provider disabled in local mobile fixtures");
      return original.call(this, input, ...args);
    };
  }
}
const realFetch = globalThis.fetch;
const rate = {
  object_id: "mobile-local-rate",
  amount: "5.25",
  currency: "USD",
  provider: "USPS",
  servicelevel: { name: "Priority Mail" },
  estimated_days: 2,
};
globalThis.fetch = async (input, init) => {
  const url = String(input?.url || input);
  const json = (data) =>
    new Response(JSON.stringify(data), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  if (url.startsWith("https://exp.host/--/api/v2/push/")) {
    const body = JSON.parse(init?.body || "{}");
    fs.appendFileSync(
      path.join(directory, "push.jsonl"),
      JSON.stringify({ url, body }) + "\n"
    );
    if (url.endsWith("/send"))
      return json({
        data: body.map(() => ({ status: "ok", id: crypto.randomUUID() })),
      });
    if (url.endsWith("/getReceipts"))
      return json({
        data: Object.fromEntries(body.ids.map((id) => [id, { status: "ok" }])),
      });
    throw new Error("Unexpected local push operation");
  }
  if (url.startsWith("https://api.goshippo.com/")) {
    const body = JSON.parse(init?.body || "{}");
    fs.appendFileSync(
      path.join(directory, "shipping.jsonl"),
      JSON.stringify({ url, body }) + "\n"
    );
    if (url.endsWith("/shipments/")) {
      const isReturn = body.return === true;
      const controlsPath = path.join(directory, "shipping-controls.json");
      const controls = fs.existsSync(controlsPath)
        ? JSON.parse(fs.readFileSync(controlsPath, "utf8"))
        : {};
      if (isReturn && controls.failReturnRates)
        throw new Error("Local return rates unavailable");
      return json({
        object_id: isReturn
          ? "mobile-local-return-shipment"
          : "mobile-local-shipment",
        rates: [
          {
            ...rate,
            object_id: isReturn ? "mobile-local-return-rate" : rate.object_id,
          },
        ],
      });
    }
    if (url.endsWith("/transactions/"))
      return json({
        status: "SUCCESS",
        label_url: "https://example.invalid/local-label.pdf",
        tracking_number:
          body.rate === "mobile-local-return-rate"
            ? "LOCAL-RETURN-TRACKING"
            : "LOCAL-MOBILE-TRACKING",
        label_file_type: "PDF",
        rate,
      });
    if (url.includes("/rates/")) return json(rate);
    throw new Error("Unexpected local shipping operation");
  }
  if (url.startsWith("https://goshippo.com/oauth/access_token"))
    return json({
      access_token: "oauth.mobile-local",
      account_id: "mobile-local",
      scope: "*",
    });
  // Fail closed for any other commercial-provider endpoint.
  if (/shippo|stripe|sendgrid|exp\.host/.test(url))
    throw new Error("External provider disabled in local mobile fixtures");
  return realFetch(input, init);
};
