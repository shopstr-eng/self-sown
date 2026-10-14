import { SelfSownApiError, createSelfSownApiClient } from "../index";

describe("api client", () => {
  test("sends email sign-in requests to the expected route", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({
          success: true,
          nsec: "nsec1test",
          pubkey: "pubkey-test",
        }),
    });
    const client = createSelfSownApiClient({
      baseUrl: "http://127.0.0.1:5000",
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(
      client.emailSignIn({
        email: "seller@example.com",
        password: "secret",
      })
    ).resolves.toEqual({
      success: true,
      nsec: "nsec1test",
      pubkey: "pubkey-test",
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:5000/api/auth/email-signin",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          email: "seller@example.com",
          password: "secret",
        }),
      })
    );
  });

  test("builds signed notification email requests against the read route", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ email: "seller@example.com" }),
    });
    const client = createSelfSownApiClient({
      baseUrl: "http://localhost:5000",
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(
      client.fetchSellerNotificationEmail("seller-pubkey", {
        id: "event-1",
      })
    ).resolves.toEqual({
      email: "seller@example.com",
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://localhost:5000/api/email/notification-email/read",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          pubkey: "seller-pubkey",
          role: "seller",
          signedEvent: {
            id: "event-1",
          },
        }),
      })
    );
  });

  test("requests an account recovery email", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({
          success: true,
          message:
            "If an account exists with this email, a recovery link has been sent.",
        }),
    });
    const client = createSelfSownApiClient({
      baseUrl: "http://127.0.0.1:5000",
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(
      client.requestAccountRecovery({ email: "seller@example.com" })
    ).resolves.toEqual({
      success: true,
      message:
        "If an account exists with this email, a recovery link has been sent.",
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:5000/api/auth/request-recovery",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ email: "seller@example.com" }),
      })
    );
  });

  test("verifies a recovery token", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({
          success: true,
          email: "seller@example.com",
          authType: "email",
        }),
    });
    const client = createSelfSownApiClient({
      baseUrl: "http://127.0.0.1:5000",
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(
      client.verifyAccountRecoveryToken({ token: "token-123" })
    ).resolves.toEqual({
      success: true,
      email: "seller@example.com",
      authType: "email",
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:5000/api/auth/verify-recovery-token",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ token: "token-123" }),
      })
    );
  });

  test("resets the password with a recovery key and returns the nsec", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({
          success: true,
          nsec: "nsec1recovered",
          pubkey: "pubkey-recovered",
          authType: "email",
        }),
    });
    const client = createSelfSownApiClient({
      baseUrl: "http://127.0.0.1:5000",
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(
      client.resetAccountRecoveryPassword({
        token: "token-123",
        recoveryKey: "ABCD-EFGH-IJKL",
        newPassword: "new-secret",
      })
    ).resolves.toEqual({
      success: true,
      nsec: "nsec1recovered",
      pubkey: "pubkey-recovered",
      authType: "email",
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:5000/api/auth/reset-password",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          token: "token-123",
          recoveryKey: "ABCD-EFGH-IJKL",
          newPassword: "new-secret",
        }),
      })
    );
  });

  test("surfaces recovery endpoint errors as typed api errors", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: "Invalid recovery key" }),
    });
    const client = createSelfSownApiClient({
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(
      client.resetAccountRecoveryPassword({
        token: "token-123",
        recoveryKey: "wrong-key",
        newPassword: "new-secret",
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<SelfSownApiError>>({
        name: "SelfSownApiError",
        message: "Invalid recovery key",
        status: 400,
      })
    );
  });

  test("throws a typed api error for non-2xx responses", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: false,
      status: 409,
      text: async () => JSON.stringify({ error: "Email already registered" }),
    });
    const client = createSelfSownApiClient({
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(
      client.emailSignUp({
        email: "seller@example.com",
        password: "secret",
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<SelfSownApiError>>({
        name: "SelfSownApiError",
        message: "Email already registered",
        status: 409,
      })
    );
  });

  test("passes absolute mobile return URLs to the stripe link route", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({ url: "https://connect.stripe.com/test" }),
    });
    const client = createSelfSownApiClient({
      baseUrl: "http://127.0.0.1:5000",
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(
      client.createStripeConnectAccountLink({
        accountId: "acct_123",
        pubkey: "seller-pubkey",
        signedEvent: { id: "event-1" },
        returnUrl: "milkmarket://stripe-connect-return?success=true",
        refreshUrl: "milkmarket://stripe-connect-return?refresh=true",
      })
    ).resolves.toEqual({
      url: "https://connect.stripe.com/test",
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:5000/api/stripe/connect/create-account-link",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          accountId: "acct_123",
          pubkey: "seller-pubkey",
          signedEvent: { id: "event-1" },
          returnUrl: "milkmarket://stripe-connect-return?success=true",
          refreshUrl: "milkmarket://stripe-connect-return?refresh=true",
        }),
      })
    );
  });
});
