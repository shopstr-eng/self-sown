import {
  getOutgoingSendTokens,
  recordOutgoingSendToken,
  resolveOutgoingSendToken,
  RESOLVED_RETENTION_MS,
} from "../outgoing-send-tokens";

const STORAGE_KEY = "milkmarket.outgoingSendTokens";

describe("outgoing-send-tokens", () => {
  beforeEach(() => {
    localStorage.clear();
    jest.restoreAllMocks();
  });

  test("records a token and lists newest first", () => {
    jest.spyOn(Date, "now").mockReturnValue(1000);
    recordOutgoingSendToken({
      token: "cashuA_first",
      mintUrl: "https://mint.one",
      amount: 100,
    });
    jest.spyOn(Date, "now").mockReturnValue(2000);
    recordOutgoingSendToken({
      token: "cashuA_second",
      mintUrl: "https://mint.two",
      amount: 200,
    });

    const entries = getOutgoingSendTokens();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      token: "cashuA_second",
      mintUrl: "https://mint.two",
      amount: 200,
      createdAt: 2000,
      status: "unclaimed",
    });
    expect(entries[1]!.token).toBe("cashuA_first");
  });

  test("upserting the same token preserves createdAt and status", () => {
    jest.spyOn(Date, "now").mockReturnValue(1000);
    recordOutgoingSendToken({
      token: "cashuA_tok",
      mintUrl: "https://mint.one",
      amount: 100,
    });
    resolveOutgoingSendToken("cashuA_tok", "claimed");
    jest.spyOn(Date, "now").mockReturnValue(5000);
    recordOutgoingSendToken({
      token: "cashuA_tok",
      mintUrl: "https://mint.one",
      amount: 100,
    });

    const entries = getOutgoingSendTokens();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      createdAt: 1000,
      status: "claimed",
    });
  });

  test("resolve marks status and resolvedAt; unknown token is a no-op", () => {
    jest.spyOn(Date, "now").mockReturnValue(1000);
    recordOutgoingSendToken({
      token: "cashuA_tok",
      mintUrl: "https://mint.one",
      amount: 100,
    });
    jest.spyOn(Date, "now").mockReturnValue(3000);
    resolveOutgoingSendToken("cashuA_tok", "reclaimed");
    resolveOutgoingSendToken("cashuA_missing", "claimed");

    const entries = getOutgoingSendTokens();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      status: "reclaimed",
      resolvedAt: 3000,
    });
  });

  test("prunes old resolved entries but never prunes unclaimed ones", () => {
    jest.spyOn(Date, "now").mockReturnValue(1000);
    recordOutgoingSendToken({
      token: "cashuA_old_unclaimed",
      mintUrl: "https://mint.one",
      amount: 100,
    });
    recordOutgoingSendToken({
      token: "cashuA_old_claimed",
      mintUrl: "https://mint.one",
      amount: 50,
    });
    resolveOutgoingSendToken("cashuA_old_claimed", "claimed");

    // Far in the future, a new write triggers pruning.
    jest
      .spyOn(Date, "now")
      .mockReturnValue(1000 + RESOLVED_RETENTION_MS + 60_000);
    recordOutgoingSendToken({
      token: "cashuA_new",
      mintUrl: "https://mint.one",
      amount: 25,
    });

    const tokens = getOutgoingSendTokens().map((e) => e.token);
    expect(tokens).toContain("cashuA_old_unclaimed");
    expect(tokens).toContain("cashuA_new");
    expect(tokens).not.toContain("cashuA_old_claimed");
  });

  test("returns [] on corrupt storage", () => {
    localStorage.setItem(STORAGE_KEY, "{not json");
    expect(getOutgoingSendTokens()).toEqual([]);
  });

  test("dispatches a synthetic storage event on write", () => {
    const listener = jest.fn();
    window.addEventListener("storage", listener);
    recordOutgoingSendToken({
      token: "cashuA_tok",
      mintUrl: "https://mint.one",
      amount: 100,
    });
    expect(listener).toHaveBeenCalled();
    window.removeEventListener("storage", listener);
  });
});
