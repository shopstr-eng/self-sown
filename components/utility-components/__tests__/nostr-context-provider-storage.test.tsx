import { act, render, screen, waitFor } from "@testing-library/react";
import { useContext } from "react";
import {
  SignerContext,
  SignerContextProvider,
} from "../nostr-context-provider";
import { NostrManager } from "@/utils/nostr/nostr-manager";

jest.mock("@/utils/nostr/nostr-helper-functions", () => ({
  getLocalStorageData: jest.fn(() => ({
    signer: undefined,
    signInMethod: undefined,
    relays: [],
    readRelays: [],
    writeRelays: [],
  })),
}));
jest.mock("@/utils/nostr/nostr-manager", () => ({
  NostrManager: jest.fn().mockImplementation(() => ({ addRelays: jest.fn() })),
}));
jest.mock("../request-passphrase-modal", () => () => null);
jest.mock("../auth-challenge-modal", () => () => null);
jest.mock("../migration-prompt-modal", () => () => null);
jest.mock("@/utils/nostr/encryption-migration", () => ({
  needsMigration: () => false,
}));

function Probe() {
  const { pubkey } = useContext(SignerContext);
  return <output>{pubkey || "signed-out"}</output>;
}

describe("SignerContextProvider encrypted signer storage", () => {
  it("adopts the active NIP-46 signer instead of reconstructing it after local persistence", async () => {
    const addEventListener = jest.spyOn(window, "addEventListener");
    const pubkey = "a".repeat(64);
    const activeSigner = {
      getPubKey: jest.fn().mockResolvedValue(pubkey),
      toJSON: jest.fn(),
    } as any;
    const signerFrom = jest.fn();
    (NostrManager as any).signerFrom = signerFrom;

    render(
      <SignerContextProvider>
        <Probe />
      </SignerContextProvider>
    );

    await waitFor(() =>
      expect(addEventListener).toHaveBeenCalledWith("storage", expect.any(Function))
    );
    const storageHandler = addEventListener.mock.calls
      .filter(([type]) => type === "storage")
      .at(-1)?.[1] as EventListener;
    await act(async () => {
      storageHandler(
        new CustomEvent("storage", {
          detail: {
            shouldReloadSigner: false,
            activeSigner,
            signerKey: JSON.stringify({
              type: "nip46",
              encryptedSigner: "encrypted-session",
            }),
          },
        })
      );
    });

    expect(activeSigner.getPubKey).toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByText(pubkey)).toBeInTheDocument()
    );
    expect(activeSigner.getPubKey).toHaveBeenCalledTimes(1);
    expect(signerFrom).not.toHaveBeenCalled();
  });
});