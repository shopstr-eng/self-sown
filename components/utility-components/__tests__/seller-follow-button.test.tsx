import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SellerFollowButton from "../seller-follow-button";
import {
  NostrContext,
  SignerContext,
} from "../nostr-context-provider";
import { FollowsContext } from "@/utils/context/context";
import { useState, type ReactNode } from "react";

const sellerA = "a".repeat(64);
const sellerB = "b".repeat(64);

jest.mock("@heroui/react", () => ({
  Button: ({ children, onPress, isLoading, ...props }: any) => (
    <button {...props} onClick={onPress} disabled={isLoading}>
      {children}
    </button>
  ),
  useDisclosure: () => ({
    isOpen: false,
    onOpen: jest.fn(),
    onClose: jest.fn(),
  }),
}));

jest.mock("../../sign-in/SignInModal", () => () => null);
jest.mock("@/utils/nostr/nostr-helper-functions", () => ({
  getLocalStorageData: () => ({
    relays: ["wss://relay.example"],
    readRelays: [],
    writeRelays: [],
  }),
}));

describe("SellerFollowButton", () => {
  it("publishes a replacement contact list without removing existing contacts", async () => {
    const user = userEvent.setup();
    const sign = jest.fn(async (template) => ({
      ...template,
      id: "signed",
      pubkey: "viewer",
      sig: "signature",
    }));
    const publish = jest.fn(async () => undefined);
    const setDirectFollowList = jest.fn();
    const FollowState = ({ children }: { children: ReactNode }) => {
      const [directFollowList, setDirect] = useState([sellerA]);
      return (
        <FollowsContext.Provider
          value={{
            followList: directFollowList,
            directFollowList,
            firstDegreeFollowsLength: directFollowList.length,
            isLoading: false,
            setDirectFollowList: (next) => {
              setDirectFollowList(next);
              setDirect(next);
            },
          }}
        >
          {children}
        </FollowsContext.Provider>
      );
    };

    render(
      <NostrContext.Provider
        value={{
          nostr: {
            fetch: jest.fn(async () => [
              {
                id: "existing",
                kind: 3,
                created_at: 1,
                content: "",
                pubkey: "viewer",
                sig: "signature",
                tags: [
                  ["p", sellerA, "wss://farm.example", "Farm"],
                  ["t", "local"],
                ],
              },
            ]),
            publish,
          } as any,
        }}
      >
        <SignerContext.Provider
          value={{ isLoggedIn: true, pubkey: "viewer", signer: { sign } as any }}
        >
          <FollowState>
            <SellerFollowButton sellerPubkey={sellerB} />
          </FollowState>
        </SignerContext.Provider>
      </NostrContext.Provider>
    );

    await user.click(screen.getByRole("button", { name: "Follow seller" }));

    expect(sign).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 3,
        content: "",
        tags: [
          ["p", sellerA, "wss://farm.example", "Farm"],
          ["t", "local"],
          ["p", sellerB],
        ],
      })
    );
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ id: "signed" }),
      ["wss://relay.example"]
    );
    expect(setDirectFollowList).toHaveBeenCalledWith([sellerA, sellerB]);
    expect(screen.getByRole("button", { name: "Unfollow seller" })).toHaveTextContent(
      "Following"
    );
  });

  it("uses the fetched list when toggled before follow hydration completes", async () => {
    const user = userEvent.setup();
    const sign = jest.fn(async (template) => ({
      ...template,
      id: "signed",
      pubkey: "viewer",
      sig: "signature",
    }));
    const setDirectFollowList = jest.fn();

    render(
      <NostrContext.Provider
        value={{
          nostr: {
            fetch: jest.fn(async () => [
              {
                id: "existing",
                kind: 3,
                created_at: 1,
                content: "",
                pubkey: "viewer",
                sig: "signature",
                tags: [["p", sellerA], ["p", sellerB], ["t", "local"]],
              },
            ]),
            publish: jest.fn(async () => undefined),
          } as any,
        }}
      >
        <SignerContext.Provider
          value={{ isLoggedIn: true, pubkey: "viewer", signer: { sign } as any }}
        >
          <FollowsContext.Provider
            value={{
              followList: [],
              directFollowList: [],
              firstDegreeFollowsLength: 0,
              isLoading: true,
              setDirectFollowList,
            }}
          >
            <SellerFollowButton sellerPubkey={sellerB} />
          </FollowsContext.Provider>
        </SignerContext.Provider>
      </NostrContext.Provider>
    );

    await user.click(screen.getByRole("button", { name: "Follow seller" }));

    expect(sign).toHaveBeenCalledWith(
      expect.objectContaining({
        tags: [["p", sellerA], ["t", "local"]],
      })
    );
    expect(setDirectFollowList).toHaveBeenCalledWith([sellerA]);
  });
});