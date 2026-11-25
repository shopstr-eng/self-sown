/** @jest-environment node */

import { createHash } from "node:crypto";
import {
  createSellerSessionFromNsec,
  generateSellerNsecCredentials,
} from "@self-sown/nostr";
import { verifyEvent } from "nostr-tools";

jest.mock("@react-native-async-storage/async-storage", () => ({}), {
  virtual: true,
});
jest.mock("expo-secure-store", () => ({}), { virtual: true });
jest.mock(
  "../../lib/api-base-url",
  () => ({ getApiBaseUrl: () => "https://local.example.invalid" }),
  { virtual: true }
);
jest.mock("../../apps/mobile/lib/api-base-url", () => ({
  getApiBaseUrl: () => "https://local.example.invalid",
}));
jest.mock(
  "../../lib/api-client",
  () => jest.requireActual("../../apps/mobile/lib/api-client"),
  { virtual: true }
);
jest.mock(
  "../../lib/order-actions",
  () => jest.requireActual("../../apps/mobile/lib/order-actions"),
  { virtual: true }
);
jest.mock(
  "../../lib/order-notification-outbox",
  () => jest.requireActual("../../apps/mobile/lib/order-notification-outbox"),
  { virtual: true }
);
jest.mock(
  "../../lib/secure-outbox-storage",
  () => jest.requireActual("../../apps/mobile/lib/secure-outbox-storage"),
  { virtual: true }
);

afterEach(() => jest.restoreAllMocks());

it("fetches statuses for 201 orders with a separate signature for each request body", async () => {
  const session = createSellerSessionFromNsec(
    generateSellerNsecCredentials().nsec
  );
  const orderIds = Array.from({ length: 201 }, (_, index) => `order-${index}`);
  const receivedOrderIds: string[] = [];
  const fetch = jest
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (url, init) => {
      const body = init?.body;
      if (typeof body !== "string") {
        throw new Error("Expected a JSON order-status body.");
      }
      const header = new Headers(init?.headers).get("Authorization");
      if (!header?.startsWith("Nostr ")) {
        throw new Error("Expected a signed order-status request.");
      }
      const event = JSON.parse(
        Buffer.from(header.slice("Nostr ".length), "base64").toString("utf8")
      );
      expect(verifyEvent(event)).toBe(true);
      expect(event.pubkey).toBe(session.pubkey);
      expect(event.tags).toEqual([
        ["u", url],
        ["method", "POST"],
        ["payload", createHash("sha256").update(body).digest("hex")],
      ]);
      const { orderIds: batch } = JSON.parse(body);
      expect(batch.length).toBeLessThanOrEqual(200);
      receivedOrderIds.push(...batch);
      return Response.json({
        statuses: Object.fromEntries(
          batch.map((id: string) => [id, "confirmed"])
        ),
      });
    });
  const { sellerOrdersLoaderDependencies } = jest.requireActual<
    typeof import("../../apps/mobile/lib/seller-order-runtime")
  >("../../apps/mobile/lib/seller-order-runtime");

  await expect(
    sellerOrdersLoaderDependencies.fetchOrderStatuses(orderIds, session)
  ).resolves.toEqual(
    Object.fromEntries(orderIds.map((id) => [id, "confirmed"]))
  );
  expect(receivedOrderIds).toEqual(orderIds);
  expect(fetch).toHaveBeenCalledTimes(2);
});
