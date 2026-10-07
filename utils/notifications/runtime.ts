import { ensureTablesInitialized, getDbPool } from "@/utils/db/db-service";
import { createDeviceRegistrationService } from "./device-registration";
import { createExpoPushProvider } from "./expo-provider";
import { createNotificationTokenVault } from "./token-crypto";

export function sellerPushEnabled(): boolean {
  return process.env.MOBILE_SELLER_PUSH_ENABLED === "true";
}
export async function getNotificationRuntime() {
  const deployment = process.env.MOBILE_PUSH_DEPLOYMENT ?? "";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(deployment))
    throw new Error("Notification deployment is not configured");
  const vault = createNotificationTokenVault(
    process.env.MOBILE_PUSH_TOKEN_ENCRYPTION_KEY ?? ""
  );
  // Provider construction is lazy: revocation/metadata remains available if
  // push credentials have been removed while notifications are disabled.
  const provider = () =>
    createExpoPushProvider({
      accessToken: process.env.EXPO_ACCESS_TOKEN ?? "",
    });
  await ensureTablesInitialized();
  const pool = getDbPool();
  const service = createDeviceRegistrationService({
    pool,
    deployment,
    vault,
    sendChallenge: async (input) => {
      const tickets = await provider().send([
        {
          deviceId: input.challengeId,
          token: input.token,
          data: {
            version: 1,
            type: "device_challenge",
            challengeId: input.challengeId,
            nonce: input.nonce,
          },
        },
      ]);
      if (tickets[0]?.status !== "accepted")
        throw new Error("Device challenge delivery failed");
    },
  });
  return { pool, deployment, vault, provider, service };
}
export const notificationHandlerDependencies = {
  enabled: sellerPushEnabled,
  getService: async () => (await getNotificationRuntime()).service,
};
