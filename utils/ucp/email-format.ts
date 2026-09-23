/**
 * Email shape check byte-identical to ajv-formats' `email` format. The
 * published checkout-session-create request schema declares
 * `format: "email"` on buyerEmail, and agent clients pre-validate with
 * ajv-formats before POSTing — so the route's accept/reject answer must match
 * theirs exactly (a@b, a..b@x.com, .a@x.com, a@-x.com are all REJECTED by
 * ajv-formats even though a loose `[^@]+@[^@]+` regex accepts them).
 *
 * ajv-formats itself is a devDependency, so it cannot be imported from a page
 * route; this regex is copied verbatim from its formats implementation. The
 * schema/route parity test (__tests__/pages/api/ucp-checkout-schema-parity.
 * test.ts) pins equivalence against a real ajv compile, so an ajv-formats
 * upgrade that changes the format fails the suite instead of drifting.
 */
const AJV_FORMATS_EMAIL =
  /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;

export function isSchemaEmail(value: unknown): value is string {
  return typeof value === "string" && AJV_FORMATS_EMAIL.test(value);
}
