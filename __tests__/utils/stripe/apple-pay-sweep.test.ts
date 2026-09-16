import {
  sweepMarketplaceApplePayPmds,
  type PaymentMethodDomainRef,
} from "@/utils/stripe/apple-pay-sweep";

const ACCOUNT_A = "acct_a";
const ACCOUNT_B = "acct_b";
const ACCOUNT_C = "acct_c";

function makeDeps(overrides?: {
  pmdsByAccount?: Record<string, PaymentMethodDomainRef[]>;
  listErrorAccounts?: string[];
  disableErrorPmds?: string[];
  apply?: boolean;
}) {
  const apply = overrides?.apply ?? true;
  const disabledCalls: Array<{ accountId: string; pmdId: string }> = [];
  const logs: string[] = [];
  const deps = {
    listAccounts: jest.fn(async () => [
      { pubkey: "pk_a", stripe_account_id: ACCOUNT_A },
      // Duplicate row for the same account — must be swept once.
      { pubkey: "pk_a2", stripe_account_id: ACCOUNT_A },
      { pubkey: "pk_b", stripe_account_id: ACCOUNT_B },
      { pubkey: "pk_c", stripe_account_id: ACCOUNT_C },
    ]),
    listPaymentMethodDomains: jest.fn(async (accountId: string) => {
      if (overrides?.listErrorAccounts?.includes(accountId)) {
        throw new Error("stripe list blew up");
      }
      return overrides?.pmdsByAccount?.[accountId] ?? [];
    }),
    disablePaymentMethodDomain: jest.fn(
      async (accountId: string, pmdId: string) => {
        if (overrides?.disableErrorPmds?.includes(pmdId)) {
          throw new Error("stripe update blew up");
        }
        disabledCalls.push({ accountId, pmdId });
      }
    ),
    domain: "self-sown.com",
    apply,
    log: (msg: string) => logs.push(msg),
  };
  return { deps, disabledCalls, logs };
}

describe("sweepMarketplaceApplePayPmds", () => {
  it("disables only enabled PMDs, dedupes accounts, skips accounts with none", async () => {
    const { deps, disabledCalls } = makeDeps({
      pmdsByAccount: {
        [ACCOUNT_A]: [
          { id: "pmd_enabled", enabled: true },
          { id: "pmd_off", enabled: false },
        ],
        [ACCOUNT_B]: [], // never registered the domain
        [ACCOUNT_C]: [{ id: "pmd_off2", enabled: false }],
      },
    });

    const report = await sweepMarketplaceApplePayPmds(deps);

    expect(deps.listPaymentMethodDomains).toHaveBeenCalledTimes(3);
    expect(disabledCalls).toEqual([
      { accountId: ACCOUNT_A, pmdId: "pmd_enabled" },
    ]);
    expect(report).toEqual({
      total: 4,
      accounts: 3,
      noDomain: 1,
      alreadyDisabled: 2,
      disabled: 1,
      wouldDisable: 0,
      errors: 0,
    });
  });

  it("report-only mode makes no writes", async () => {
    const { deps, disabledCalls } = makeDeps({
      apply: false,
      pmdsByAccount: { [ACCOUNT_A]: [{ id: "pmd_enabled", enabled: true }] },
    });

    const report = await sweepMarketplaceApplePayPmds(deps);

    expect(disabledCalls).toEqual([]);
    expect(report.wouldDisable).toBe(1);
    expect(report.disabled).toBe(0);
  });

  it("a list failure on one account is logged and does not abort the sweep", async () => {
    const { deps, disabledCalls, logs } = makeDeps({
      listErrorAccounts: [ACCOUNT_B],
      pmdsByAccount: {
        [ACCOUNT_A]: [{ id: "pmd_a", enabled: true }],
        [ACCOUNT_C]: [{ id: "pmd_c", enabled: true }],
      },
    });

    const report = await sweepMarketplaceApplePayPmds(deps);

    expect(disabledCalls).toHaveLength(2);
    expect(report.errors).toBe(1);
    expect(report.disabled).toBe(2);
    expect(logs.some((m) => m.includes(`ERROR ${ACCOUNT_B}`))).toBe(true);
  });

  it("a disable failure keeps later accounts and PMDs moving", async () => {
    const { deps, disabledCalls } = makeDeps({
      disableErrorPmds: ["pmd_bad"],
      pmdsByAccount: {
        [ACCOUNT_A]: [
          { id: "pmd_bad", enabled: true },
          { id: "pmd_good", enabled: true },
        ],
        [ACCOUNT_C]: [{ id: "pmd_c", enabled: true }],
      },
    });

    const report = await sweepMarketplaceApplePayPmds(deps);

    expect(disabledCalls).toEqual([
      { accountId: ACCOUNT_A, pmdId: "pmd_good" },
      { accountId: ACCOUNT_C, pmdId: "pmd_c" },
    ]);
    expect(report.errors).toBe(1);
    expect(report.disabled).toBe(2);
  });
});
