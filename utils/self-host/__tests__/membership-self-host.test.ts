// Verifies the self-host entitlement short-circuit in getMembershipView /
// isPubkeyProEntitled is scoped to EXACTLY the configured tenant pubkey and
// never touches the DB for that tenant — while every other pubkey still resolves
// from the DB layer as normal.

const isSelfHostTenantMock = jest.fn();
const getProMembershipMock = jest.fn();

jest.mock("@/utils/self-host/config", () => ({
  isSelfHostTenant: (pubkey: string | null | undefined) =>
    isSelfHostTenantMock(pubkey),
}));

jest.mock("@/utils/db/pro-membership", () => ({
  getProMembership: (pubkey: string) => getProMembershipMock(pubkey),
}));

import { getMembershipView, isPubkeyProEntitled } from "@/utils/pro/membership";

const TENANT = "a".repeat(64);
const OTHER = "b".repeat(64);

describe("getMembershipView self-host bypass", () => {
  beforeEach(() => {
    isSelfHostTenantMock.mockReset();
    getProMembershipMock.mockReset();
  });

  it("returns an active lifetime view for the tenant WITHOUT hitting the DB", async () => {
    isSelfHostTenantMock.mockReturnValue(true);

    const view = await getMembershipView(TENANT);

    expect(view.isLifetime).toBe(true);
    expect(view.status).toBe("active");
    expect(getProMembershipMock).not.toHaveBeenCalled();
  });

  it("entitles the tenant via isPubkeyProEntitled", async () => {
    isSelfHostTenantMock.mockReturnValue(true);
    await expect(isPubkeyProEntitled(TENANT)).resolves.toBe(true);
    expect(getProMembershipMock).not.toHaveBeenCalled();
  });

  it("resolves any non-tenant pubkey from the DB (no bypass)", async () => {
    isSelfHostTenantMock.mockReturnValue(false);
    getProMembershipMock.mockResolvedValue(null);

    const view = await getMembershipView(OTHER);

    expect(getProMembershipMock).toHaveBeenCalledWith(OTHER);
    expect(view.isLifetime).toBe(false);
  });

  it("does not entitle a non-tenant with no DB row", async () => {
    isSelfHostTenantMock.mockReturnValue(false);
    getProMembershipMock.mockResolvedValue(null);

    await expect(isPubkeyProEntitled(OTHER)).resolves.toBe(false);
  });
});
