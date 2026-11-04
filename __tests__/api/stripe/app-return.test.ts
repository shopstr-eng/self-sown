/** @jest-environment node */

import handler from "@/pages/api/stripe/connect/app-return";

function createMockResponse() {
  const response = {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    redirectTo: undefined as string | undefined,
    status(code: number) {
      response.statusCode = code;
      return response;
    },
    json(payload: unknown) {
      response.body = payload;
      return response;
    },
    setHeader(name: string, value: string | number) {
      response.headers[name] = String(value);
      return response;
    },
    redirect(code: number, url: string) {
      response.statusCode = code;
      response.redirectTo = url;
      response.headers["Location"] = url;
      return response;
    },
  };

  return response;
}

describe("stripe connect app-return bounce", () => {
  // Stripe's API rejects non-http(s) redirect URLs, so mobile deep links
  // reach Stripe as this https route; it must 302 into the app scheme for
  // the in-app auth session to intercept.
  test("302s to a selfsown:// deep link", async () => {
    const response = createMockResponse();

    await handler(
      {
        method: "GET",
        query: { to: "selfsown://stripe-connect-return?success=true" },
      } as any,
      response as any
    );

    expect(response.statusCode).toBe(302);
    expect(response.redirectTo).toBe(
      "selfsown://stripe-connect-return?success=true"
    );
    expect(response.headers["Cache-Control"]).toBe("private, no-store");
  });

  test("302s to the legacy milkmarket:// scheme", async () => {
    const response = createMockResponse();

    await handler(
      {
        method: "GET",
        query: { to: "milkmarket://stripe-connect-return?refresh=true" },
      } as any,
      response as any
    );

    expect(response.statusCode).toBe(302);
    expect(response.redirectTo).toBe(
      "milkmarket://stripe-connect-return?refresh=true"
    );
  });

  test.each([
    [
      "an https URL (would make this an open web redirector)",
      "https://self-sown.com/settings/payments",
    ],
    ["an http URL", "http://evil.example/return"],
    ["a javascript: URL", "javascript:alert(1)"],
    ["a malformed URL", "not a url"],
  ])("rejects %s", async (_label, to) => {
    const response = createMockResponse();

    await handler({ method: "GET", query: { to } } as any, response as any);

    expect(response.statusCode).toBe(400);
    expect(response.redirectTo).toBeUndefined();
  });

  test("rejects a missing target", async () => {
    const response = createMockResponse();

    await handler({ method: "GET", query: {} } as any, response as any);

    expect(response.statusCode).toBe(400);
  });

  test("rejects non-GET methods", async () => {
    const response = createMockResponse();

    await handler(
      {
        method: "POST",
        query: { to: "selfsown://stripe-connect-return?success=true" },
      } as any,
      response as any
    );

    expect(response.statusCode).toBe(405);
  });
});
