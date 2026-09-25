/** @jest-environment jsdom */

// Mounted-widget regression tests for the two behaviors the pure-helper suite
// can't see:
//   1. Keyboard users can open and collapse the panel (native click path),
//      and a drag's trailing click event does NOT open it.
//   2. An in-place account switch remounts the chat and drops any writes-state
//      callback captured under the previous account.

import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SignerContext } from "@/components/utility-components/nostr-context-provider";
import FloatingAssistant, {
  resolveAssistantAudience,
} from "@/components/assistant/floating-assistant";

const PUBKEY_A = "a".repeat(64);
const PUBKEY_B = "b".repeat(64);

// Capture every props object the chat receives so tests can replay a STALE
// callback after an account switch.
const chatPropsLog: Array<{
  onWritesStateChange?: (enabled: boolean) => void;
}> = [];
let chatMountCount = 0;

jest.mock("@/components/assistant/assistant-chat", () => ({
  __esModule: true,
  default: (props: { onWritesStateChange?: (e: boolean) => void }) => {
    chatPropsLog.push(props);

    React.useEffect(() => {
      chatMountCount += 1;
    }, []);
    return <div data-testid="assistant-chat" />;
  },
}));

jest.mock("@/components/utility-components/pro-membership-context", () => ({
  useProMembership: () => ({
    membership: { isPro: true },
    loading: false,
  }),
}));

jest.mock("next/router", () => ({
  useRouter: () => ({ push: jest.fn() }),
}));

jest.mock("@/utils/nostr/nip98-auth", () => ({
  createNip98AuthorizationHeader: jest.fn(async () => "Nostr test-auth"),
}));

// Writes NOT enabled on the server so the setup card renders.
const fetchMock = jest.fn(async () => ({
  ok: true,
  json: async () => ({ writesEnabled: false }),
})) as unknown as typeof fetch;
(globalThis as { fetch: typeof fetch }).fetch = fetchMock;

const fakeSigner = {
  toJSON: () => ({ type: "nsec", passphrase: "embedded" }),
  sign: jest.fn(),
};

function renderWidget(pubkey: string) {
  const value = {
    signer: fakeSigner,
    isLoggedIn: true,
    isAuthStateResolved: true,
    pubkey,
    npub: "npub1test",
  };
  return (
    <SignerContext.Provider value={value as never}>
      <FloatingAssistant />
    </SignerContext.Provider>
  );
}

beforeAll(() => {
  // jsdom lacks pointer capture; the widget calls it on drag start.
  (
    HTMLElement.prototype as unknown as { setPointerCapture: unknown }
  ).setPointerCapture = jest.fn();
  // jsdom has no PointerEvent constructor (fireEvent falls back to a bare
  // Event and drops clientY/pointerId). Polyfill from MouseEvent so drag
  // coordinates actually reach the handlers.
  if (!window.PointerEvent) {
    class PointerEventPolyfill extends MouseEvent {
      pointerId: number;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 0;
      }
    }
    (window as unknown as { PointerEvent: unknown }).PointerEvent =
      PointerEventPolyfill;
  }
});

beforeEach(() => {
  chatPropsLog.length = 0;
  chatMountCount = 0;
  window.localStorage.clear();
  jest.clearAllMocks();
});

describe("FloatingAssistant — keyboard + drag behavior", () => {
  it("opens on keyboard activation and collapses back to the bubble with focus returned", async () => {
    const user = userEvent.setup();
    render(renderWidget(PUBKEY_A));

    const bubble = await screen.findByLabelText("Open the seller assistant");
    bubble.focus();
    await user.keyboard("{Enter}");

    const panel = await screen.findByRole("dialog", {
      name: "Seller assistant",
    });
    // Focus moved into the panel.
    await waitFor(() => expect(panel).toHaveFocus());

    await user.click(screen.getByLabelText("Collapse the assistant"));

    // Panel is gone, the bubble is back, and focus returned to it.
    expect(
      screen.queryByRole("dialog", { name: "Seller assistant" })
    ).toBeNull();
    const bubbleAgain = await screen.findByLabelText(
      "Open the seller assistant"
    );
    await waitFor(() => expect(bubbleAgain).toHaveFocus());
  });

  it("does NOT open when a drag ends (the trailing click is suppressed)", async () => {
    render(renderWidget(PUBKEY_A));
    const bubble = await screen.findByLabelText("Open the seller assistant");

    fireEvent.pointerDown(bubble, { pointerId: 1, clientY: 500 });
    fireEvent.pointerMove(bubble, { pointerId: 1, clientY: 200 });
    fireEvent.pointerUp(bubble, {
      pointerId: 1,
      clientY: 200,
      clientX: 100,
    });
    // Browsers fire click after pointerup — a drag must not toggle the panel.
    fireEvent.click(bubble);

    expect(
      screen.queryByRole("dialog", { name: "Seller assistant" })
    ).toBeNull();
    // The drag snapped the bubble to the left edge.
    expect(bubble).toHaveStyle({ left: "16px" });
  });
});

describe("FloatingAssistant — account switch isolation", () => {
  it("remounts the chat and drops a stale writes-state callback from the previous account", async () => {
    const { rerender } = render(renderWidget(PUBKEY_A));

    // Open the panel and let the setup-status fetch resolve (writes OFF).
    const bubble = await screen.findByLabelText("Open the seller assistant");
    fireEvent.click(bubble);
    await screen.findByText("Enable write actions");

    expect(chatPropsLog.length).toBeGreaterThan(0);
    const lastProps = chatPropsLog[chatPropsLog.length - 1];
    const staleCallback = lastProps?.onWritesStateChange as (
      enabled: boolean
    ) => void;
    const mountsBefore = chatMountCount;

    // In-place account switch: same widget instance, new pubkey.
    rerender(renderWidget(PUBKEY_B));

    // The chat subtree remounted for the new account (transcript cleared).
    await waitFor(() => expect(chatMountCount).toBeGreaterThan(mountsBefore));
    // The new account's own status fetch resolves → setup card returns.
    await screen.findByText("Enable write actions");

    // A response that started under account A now completes and reports
    // "writes enabled". It must NOT stamp A's state onto B's panel.
    staleCallback(true);
    await waitFor(() =>
      expect(screen.getByText("Enable write actions")).toBeTruthy()
    );
  });
});

describe("resolveAssistantAudience", () => {
  const STALL = "c".repeat(64);

  it("marketplace: signed-in users get the seller assistant, guests nothing", () => {
    expect(
      resolveAssistantAudience({
        stallPubkey: null,
        viewerPubkey: "a".repeat(64),
        isLoggedIn: true,
        visibility: null,
      })
    ).toBe("seller");
    expect(
      resolveAssistantAudience({
        stallPubkey: null,
        viewerPubkey: null,
        isLoggedIn: false,
        visibility: null,
      })
    ).toBeNull();
  });

  it("stall: owner gets seller mode, honoring the seller toggle", () => {
    const base = {
      stallPubkey: STALL,
      viewerPubkey: STALL,
      isLoggedIn: true,
    };
    expect(
      resolveAssistantAudience({
        ...base,
        visibility: { buyers: false, seller: true },
      })
    ).toBe("seller");
    expect(
      resolveAssistantAudience({
        ...base,
        visibility: { buyers: true, seller: false },
      })
    ).toBeNull();
  });

  it("stall: guests and signed-in non-owners get buyer mode only when opted in", () => {
    const guest = { stallPubkey: STALL, viewerPubkey: null, isLoggedIn: false };
    const buyer = {
      stallPubkey: STALL,
      viewerPubkey: "d".repeat(64),
      isLoggedIn: true,
    };
    for (const viewer of [guest, buyer]) {
      expect(
        resolveAssistantAudience({
          ...viewer,
          visibility: { buyers: true, seller: true },
        })
      ).toBe("buyer");
      expect(
        resolveAssistantAudience({
          ...viewer,
          visibility: { buyers: false, seller: true },
        })
      ).toBeNull();
    }
  });

  it("hides the widget while the stall toggles are still loading", () => {
    expect(
      resolveAssistantAudience({
        stallPubkey: STALL,
        viewerPubkey: null,
        isLoggedIn: false,
        visibility: null,
      })
    ).toBeNull();
  });
});
