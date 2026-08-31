/** @jest-environment node */

import {
  createNip98AuthorizationHeader,
  createSellerMessagesListProof,
  createSellerSessionFromNsec,
  generateSellerNsecCredentials,
} from "@milk-market/nostr";

import { verifyNip98Request } from "@/utils/nostr/nip98-auth";
import {
  buildMessagesListProof,
  verifySignedHttpRequestProof,
} from "@/utils/nostr/request-auth";

describe("mobile seller order authentication compatibility", () => {
  it("produces a message-list proof accepted by the server verifier", () => {
    const session = createSellerSessionFromNsec(
      generateSellerNsecCredentials().nsec
    );
    const proof = createSellerMessagesListProof(session);

    expect(
      verifySignedHttpRequestProof(
        proof,
        buildMessagesListProof(session.pubkey)
      )
    ).toEqual({ ok: true, status: 200 });
  });

  it("produces a payload-bound NIP-98 header accepted by status routes", async () => {
    const session = createSellerSessionFromNsec(
      generateSellerNsecCredentials().nsec
    );
    const body = {
      orderId: "order-123",
      status: "confirmed",
      messageId: "1".repeat(64),
    };
    const authorization = createNip98AuthorizationHeader({
      session,
      url: "https://milk.market/api/db/update-order-status",
      method: "POST",
      body: JSON.stringify(body),
    });
    const request = {
      method: "POST",
      url: "/api/db/update-order-status",
      body,
      headers: {
        authorization,
        host: "milk.market",
        "x-forwarded-proto": "https",
      },
    } as any;

    await expect(verifyNip98Request(request, "POST", body)).resolves.toEqual({
      ok: true,
      pubkey: session.pubkey,
    });
  });
});
