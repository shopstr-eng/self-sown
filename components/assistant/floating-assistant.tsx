// Floating seller-assistant widget: a draggable chat bubble docked to either
// side of the viewport that expands into the full assistant chat panel.
// Mounted globally from _app so the assistant is reachable from any page.
//
// Setup is auth-method aware (the user is NEVER asked to paste an nsec here):
//   - Encrypted-key (nsec/ncryptsec) sign-in: enabling writes asks for the
//     key's DECRYPTION PASSPHRASE via the app's existing challenge modal
//     (NostrNSecSigner._getNSec decrypts locally).
//   - OAuth/email sign-in: the key passphrase is already embedded in the
//     local signer record, so enabling writes is one click, no prompt.
//   - NIP-07 extension / NIP-46 bunker: no raw key exists client-side, so
//     every chat request is signed through the extension/signer app (its own
//     confirmation prompt). Server-held write keys can't be exported from
//     those signers, so write enablement routes to the settings page.

import {
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useRouter } from "next/router";
import { Button, Spinner } from "@heroui/react";
import { SignerContext } from "@/components/utility-components/nostr-context-provider";
import { useProMembership } from "@/components/utility-components/pro-membership-context";
import UpgradeBanner from "@/components/pro/upgrade-banner";
import AssistantChat from "@/components/assistant/assistant-chat";
import { createNip98AuthorizationHeader } from "@/utils/nostr/nip98-auth";
import { NostrNSecSigner } from "@/utils/nostr/signers/nostr-nsec-signer";
import {
  readAssistantVisibility,
  type StallAssistantVisibility,
} from "@/utils/assistant/stall-visibility";
import {
  PRIMARYBUTTONCLASSNAMES,
  WHITEBUTTONCLASSNAMES,
} from "@/utils/STATIC-VARIABLES";

export type BubbleSide = "left" | "right";

export interface BubblePosition {
  side: BubbleSide;
  top: number;
}

export const BUBBLE_POSITION_STORAGE_KEY = "assistantBubblePosition";
const BUBBLE_SIZE = 56;
const EDGE_GAP = 16;
const DRAG_THRESHOLD_PX = 6;
const PANEL_MAX_HEIGHT = 640;
const PANEL_HEIGHT_RATIO = 0.72;

// --- Pure helpers (unit-tested) --------------------------------------------

export function clampBubbleTop(top: number, viewportHeight: number): number {
  if (!Number.isFinite(top)) return EDGE_GAP;
  const max = Math.max(EDGE_GAP, viewportHeight - BUBBLE_SIZE - EDGE_GAP);
  return Math.min(Math.max(top, EDGE_GAP), max);
}

export function readStoredBubblePosition(
  storage: Pick<Storage, "getItem">,
  viewportHeight: number
): BubblePosition | null {
  try {
    const raw = storage.getItem(BUBBLE_POSITION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<BubblePosition>;
    if (parsed.side !== "left" && parsed.side !== "right") return null;
    if (typeof parsed.top !== "number") return null;
    return {
      side: parsed.side,
      top: clampBubbleTop(parsed.top, viewportHeight),
    };
  } catch {
    return null;
  }
}

export function serializeBubblePosition(position: BubblePosition): string {
  return JSON.stringify({ side: position.side, top: Math.round(position.top) });
}

function defaultBubbleTop(viewportHeight: number): number {
  // Default above the marketplace page's own bottom-right action button.
  return clampBubbleTop(viewportHeight - BUBBLE_SIZE - 120, viewportHeight);
}

export type AssistantAudience = "seller" | "buyer" | null;

// Who sees the widget, and which assistant they get. Marketplace (no stall):
// seller assistant, signed-in users only. On a custom stall: the stall owner
// gets the seller assistant (unless they hid it via the seller toggle);
// everyone else — guests and signed-in buyers alike — gets the buyer
// assistant, and only when the stall opted in via the buyers toggle.
export function resolveAssistantAudience(opts: {
  stallPubkey: string | null;
  viewerPubkey: string | null;
  isLoggedIn: boolean;
  visibility: StallAssistantVisibility | null;
}): AssistantAudience {
  const { stallPubkey, viewerPubkey, isLoggedIn, visibility } = opts;
  if (!stallPubkey) return isLoggedIn ? "seller" : null;
  if (!visibility) return null; // toggles still loading
  if (isLoggedIn && viewerPubkey === stallPubkey) {
    return visibility.seller ? "seller" : null;
  }
  return visibility.buyers ? "buyer" : null;
}

// --- Icons ------------------------------------------------------------------

function ChatBubbleIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-6 w-6"
      aria-hidden="true"
    >
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </svg>
  );
}

function DragGripIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      className="h-4 w-4"
      aria-hidden="true"
    >
      <circle cx="9" cy="6" r="1.6" />
      <circle cx="15" cy="6" r="1.6" />
      <circle cx="9" cy="12" r="1.6" />
      <circle cx="15" cy="12" r="1.6" />
      <circle cx="9" cy="18" r="1.6" />
      <circle cx="15" cy="18" r="1.6" />
    </svg>
  );
}

function MinimizeIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      className="h-4 w-4"
      aria-hidden="true"
    >
      <path d="M5 12h14" />
    </svg>
  );
}

// --- Widget -----------------------------------------------------------------

interface DragState {
  pointerId: number;
  startY: number;
  startTop: number;
  moved: boolean;
}

export interface FloatingAssistantProps {
  // Set when mounted on a custom stall (storefront route or seller custom
  // domain): that stall's pubkey and/or route slug. Drives the buyer/seller
  // audience split and the stall's own visibility toggles. Both null on the
  // general marketplace. The slug matters because _app's storefront pubkey
  // resolution is tied to initial-load state — after marketplace→stall
  // client-side navigation it can stay null, so the widget resolves the
  // slug itself rather than mistaking a stall for the marketplace.
  stallPubkey?: string | null;
  stallSlug?: string | null;
}

export default function FloatingAssistant({
  stallPubkey = null,
  stallSlug = null,
}: FloatingAssistantProps) {
  const router = useRouter();
  const { signer, isLoggedIn, isAuthStateResolved, pubkey } =
    useContext(SignerContext);
  const { membership, loading: membershipLoading } = useProMembership();

  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<BubblePosition>({
    side: "right",
    top: EDGE_GAP,
  });
  const [writesEnabled, setWritesEnabled] = useState<boolean | null>(null);
  const [enabling, setEnabling] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  // Stall-context visibility toggles (kind:30019 storefront.assistantVisibility),
  // fetched once per stall. Null = not loaded yet.
  const [visibility, setVisibility] = useState<StallAssistantVisibility | null>(
    null
  );
  // Effective stall identity. Prefers the prop (resolved by _app's storefront
  // machinery); falls back to resolving the route slug ourselves so a
  // marketplace→stall client-side navigation can't leave the widget thinking
  // it's on the marketplace.
  const [resolvedStallPubkey, setResolvedStallPubkey] = useState<string | null>(
    null
  );
  const isStallContext = Boolean(stallPubkey || stallSlug);

  const dragState = useRef<DragState | null>(null);
  const statusRequestedFor = useRef<string | null>(null);
  const bubbleRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // Browsers fire a click after ANY pointerup — including at the end of a
  // drag. The drag end sets this so the trailing click doesn't toggle.
  const suppressClickRef = useRef(false);
  const wasOpenRef = useRef(false);
  // Mirrors the context pubkey so async callbacks started under a previous
  // account can tell they are stale (the widget is NOT remounted by _app on
  // an in-place account switch).
  const pubkeyRef = useRef(pubkey);

  // Resolve the stall identity: the prop wins; the route slug is the fallback
  // for client-side navigations where _app's resolution hasn't run.
  useEffect(() => {
    if (stallPubkey) {
      setResolvedStallPubkey(stallPubkey);
      return;
    }
    if (!stallSlug) {
      setResolvedStallPubkey(null);
      return;
    }
    let cancelled = false;
    fetch(
      `${window.location.origin}/api/storefront/lookup?slug=${encodeURIComponent(stallSlug)}`
    )
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled) {
          setResolvedStallPubkey(
            typeof data?.pubkey === "string" ? data.pubkey : null
          );
        }
      })
      .catch(() => {
        if (!cancelled) setResolvedStallPubkey(null);
      });
    return () => {
      cancelled = true;
    };
  }, [stallPubkey, stallSlug]);

  // Stall context: fetch the stall's assistant visibility toggles once per
  // stall. The lookup endpoint is public (it backs anonymous storefront
  // rendering), so guests can call it too.
  useEffect(() => {
    if (!resolvedStallPubkey) {
      setVisibility(null);
      return;
    }
    let cancelled = false;
    fetch(
      `${window.location.origin}/api/storefront/lookup?pubkey=${resolvedStallPubkey}`
    )
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!cancelled) setVisibility(readAssistantVisibility(data?.shopConfig));
      })
      .catch(() => {
        if (!cancelled) setVisibility(readAssistantVisibility(null));
      });
    return () => {
      cancelled = true;
    };
  }, [resolvedStallPubkey]);

  // Resolve initial position from storage once client-side.
  useEffect(() => {
    const stored = readStoredBubblePosition(
      window.localStorage,
      window.innerHeight
    );
    setPosition(
      stored ?? { side: "right", top: defaultBubbleTop(window.innerHeight) }
    );
    setMounted(true);
  }, []);

  // Keep the bubble on screen when the viewport resizes.
  useEffect(() => {
    const onResize = () =>
      setPosition((prev) => ({
        ...prev,
        top: clampBubbleTop(prev.top, window.innerHeight),
      }));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Account switch: drop the previous account's cached setup state. The chat
  // subtree is additionally keyed by pubkey below, so its transcript state
  // (which is submitted with every request) can never carry into the next
  // account's session.
  useEffect(() => {
    pubkeyRef.current = pubkey;
    setWritesEnabled(null);
    setSetupError(null);
    statusRequestedFor.current = null;
  }, [pubkey]);

  // Focus follows the panel: move into it on open, back to the bubble on
  // collapse, so keyboard users never lose their place.
  useEffect(() => {
    if (open) {
      panelRef.current?.focus();
    } else if (wasOpenRef.current) {
      bubbleRef.current?.focus();
    }
    wasOpenRef.current = open;
  }, [open]);

  const applyPosition = (next: BubblePosition) => {
    setPosition(next);
    try {
      window.localStorage.setItem(
        BUBBLE_POSITION_STORAGE_KEY,
        serializeBubblePosition(next)
      );
    } catch {
      // Storage unavailable — position just resets next session.
    }
  };

  const onDragStart = (event: ReactPointerEvent<HTMLElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    dragState.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startTop: position.top,
      moved: false,
    };
  };

  const onDragMove = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragState.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const deltaY = event.clientY - drag.startY;
    if (Math.abs(deltaY) > DRAG_THRESHOLD_PX) drag.moved = true;
    if (drag.moved) {
      setPosition((prev) => ({
        ...prev,
        top: clampBubbleTop(drag.startTop + deltaY, window.innerHeight),
      }));
    }
  };

  const onDragEnd = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragState.current;
    dragState.current = null;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.moved) {
      // The trailing click event after a drag must not toggle the panel.
      suppressClickRef.current = true;
      const side: BubbleSide =
        event.clientX < window.innerWidth / 2 ? "left" : "right";
      applyPosition({ side, top: position.top });
    }
  };

  // Native click activation (pointer click AND keyboard Enter/Space — a
  // pointer-only handler would make the bubble unreachable by keyboard).
  const onBubbleClick = () => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    setOpen(true);
  };

  // Lazy, best-effort setup-status check the first time the panel opens for
  // an account. Signing this request may surface the signer's own prompt
  // (passphrase modal / extension / bunker) — a cancel just leaves the state
  // unknown; every chat response also reports it. Seller-audience only: the
  // buyer assistant has no setup state and guests have no signer to sign with.
  useEffect(() => {
    if (stallPubkey && pubkey !== stallPubkey) return;
    if (!open || !signer || !pubkey || !membership.isPro) return;
    if (statusRequestedFor.current === pubkey) return;
    statusRequestedFor.current = pubkey;
    void (async () => {
      try {
        const url = `${window.location.origin}/api/assistant/setup`;
        const authorization = await createNip98AuthorizationHeader(
          signer,
          url,
          "GET"
        );
        const res = await fetch(url, {
          headers: { Authorization: authorization },
        });
        if (res.ok) {
          const data = (await res.json()) as { writesEnabled?: boolean };
          setWritesEnabled(Boolean(data.writesEnabled));
        }
      } catch {
        // Cancelled prompt or offline — the chat itself still works.
      }
    })();
  }, [open, signer, pubkey, membership.isPro]);

  const enableWrites = async () => {
    if (!signer || enabling) return;
    setEnabling(true);
    setSetupError(null);
    try {
      if (!(signer instanceof NostrNSecSigner)) {
        setSetupError(
          "Write actions can't be enabled from a browser extension or remote signer."
        );
        return;
      }
      // Decrypts the stored key LOCALLY: an OAuth/email passphrase embedded
      // in the signer record resolves silently; an encrypted-key sign-in
      // triggers the app's passphrase prompt. The raw key goes straight to
      // the setup endpoint over the signed request — no nsec field anywhere.
      const nsec = await signer._getNSec();
      const url = `${window.location.origin}/api/assistant/setup`;
      const body = JSON.stringify({ nsec });
      const authorization = await createNip98AuthorizationHeader(
        signer,
        url,
        "POST",
        body
      );
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: authorization,
        },
        body,
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setSetupError(data.error || `Setup failed (${res.status})`);
        return;
      }
      setWritesEnabled(true);
    } catch {
      setSetupError("Setup was cancelled or failed — nothing was saved.");
    } finally {
      setEnabling(false);
    }
  };

  const audience = resolveAssistantAudience({
    stallPubkey,
    viewerPubkey: pubkey ?? null,
    isLoggedIn: Boolean(isLoggedIn),
    visibility,
  });

  if (!mounted || !isAuthStateResolved || !audience) return null;
  // The seller assistant always signs its requests; no signer, no widget.
  if (audience === "seller" && !signer) return null;

  const signerType = (signer?.toJSON?.() as { type?: string } | undefined)
    ?.type;
  const isRemoteOrExtensionSigner =
    signerType === "nip07" || signerType === "nip46";
  const hasEmbeddedPassphrase = Boolean(
    (signer?.toJSON?.() as { passphrase?: string } | undefined)?.passphrase
  );

  const viewportHeight = window.innerHeight;
  const panelHeight = Math.min(
    Math.round(viewportHeight * PANEL_HEIGHT_RATIO),
    PANEL_MAX_HEIGHT
  );
  const panelTop = Math.min(
    Math.max(position.top - 160, EDGE_GAP),
    Math.max(EDGE_GAP, viewportHeight - panelHeight - EDGE_GAP)
  );

  if (!open) {
    const bubbleStyle = {
      top: position.top,
      [position.side]: EDGE_GAP,
    } as CSSProperties;
    return (
      // data-overlay-container opts the widget into the storefront's
      // body.sf-active theme variables (colors/borders/shadows remap to the
      // stall palette; on the marketplace that body class is absent).
      <button
        ref={bubbleRef}
        type="button"
        data-overlay-container
        aria-label={
          audience === "buyer"
            ? "Open the shopping assistant"
            : "Open the seller assistant"
        }
        aria-haspopup="dialog"
        onClick={onBubbleClick}
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        className="shadow-neo bg-primary-yellow fixed z-50 flex h-14 w-14 touch-none items-center justify-center rounded-full border-2 border-black text-black transition-transform hover:-translate-y-0.5"
        style={bubbleStyle}
      >
        <ChatBubbleIcon />
      </button>
    );
  }

  const panelStyle = {
    top: panelTop,
    height: panelHeight,
    [position.side]: EDGE_GAP + BUBBLE_SIZE + 12,
  } as CSSProperties;

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label={
        audience === "buyer" ? "Shopping assistant" : "Seller assistant"
      }
      tabIndex={-1}
      data-overlay-container
      className="shadow-neo fixed z-50 flex w-[380px] max-w-[calc(100vw-6rem)] flex-col overflow-hidden rounded-lg border-2 border-black bg-white outline-hidden"
      style={panelStyle}
    >
      <div className="bg-primary-yellow flex items-center gap-1 border-b-2 border-black px-2 py-1.5">
        <span
          role="button"
          tabIndex={-1}
          aria-label="Drag the assistant panel"
          title="Drag to move"
          onPointerDown={onDragStart}
          onPointerMove={onDragMove}
          onPointerUp={(event) => onDragEnd(event)}
          className="flex h-8 w-8 cursor-grab touch-none items-center justify-center rounded text-black/60 hover:bg-black/10 active:cursor-grabbing"
        >
          <DragGripIcon />
        </span>
        <span className="flex-1 text-sm font-bold text-black">
          {audience === "buyer" ? "Shopping assistant" : "Seller assistant"}
        </span>
        <button
          type="button"
          aria-label="Collapse the assistant"
          title="Collapse"
          onClick={() => setOpen(false)}
          className="flex h-8 w-8 items-center justify-center rounded border-2 border-black bg-white text-black transition-colors hover:bg-zinc-100"
        >
          <MinimizeIcon />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {audience === "buyer" ? (
          <AssistantChat
            // Remount per stall: a buyer transcript belongs to the shop it
            // was written about (it's submitted with every request).
            key={`buyer:${stallPubkey}`}
            fillHeight
            buyerMode={{ stallPubkey: stallPubkey as string }}
          />
        ) : membershipLoading ? (
          <div className="flex flex-1 items-center justify-center">
            <Spinner />
          </div>
        ) : !membership.isPro ? (
          <div className="space-y-3 overflow-y-auto p-4">
            <UpgradeBanner feature="The AI assistant" />
            <p className="text-sm text-zinc-600">
              The in-app AI assistant is included with Herd (and Wrangler
              lifetime). Upgrade to manage your stall by chatting instead of
              clicking.
            </p>
          </div>
        ) : (
          <>
            {writesEnabled === false && (
              <div className="border-b-2 border-black bg-amber-50 p-3">
                {isRemoteOrExtensionSigner ? (
                  <>
                    <p className="text-xs text-zinc-700">
                      You're signed in with{" "}
                      {signerType === "nip07"
                        ? "a browser extension"
                        : "a remote signer"}{" "}
                      — every assistant request is confirmed through it, so you
                      never paste a key here. Write actions need a signing key
                      the server can hold, which your signer can't export; chat
                      is read-only until one is set up.
                    </p>
                    <Button
                      size="sm"
                      className={`${WHITEBUTTONCLASSNAMES} mt-2 w-full`}
                      onPress={() => router.push("/settings/assistant")}
                    >
                      Open assistant settings
                    </Button>
                  </>
                ) : (
                  <>
                    <p className="text-sm font-bold text-black">
                      Enable write actions
                    </p>
                    <p className="mt-1 text-xs text-zinc-700">
                      {hasEmbeddedPassphrase
                        ? "One click — your sign-in already unlocked your key on this device. Nothing to paste."
                        : "You'll be asked for your key's decryption passphrase — never your nsec."}
                    </p>
                    <Button
                      size="sm"
                      className={`${PRIMARYBUTTONCLASSNAMES} mt-2 w-full`}
                      onPress={enableWrites}
                      isDisabled={enabling}
                    >
                      {enabling ? "Enabling…" : "Enable writes"}
                    </Button>
                    {setupError && (
                      <p className="mt-2 text-xs text-red-600">{setupError}</p>
                    )}
                  </>
                )}
              </div>
            )}
            <AssistantChat
              // Remount per account: the transcript (submitted with every
              // request) belongs to the account that wrote it.
              key={pubkey}
              fillHeight
              onWritesStateChange={(enabled) => {
                // A response that started under a previous account must never
                // stamp its setup state onto the current one.
                if (pubkeyRef.current === pubkey) setWritesEnabled(enabled);
              }}
            />
          </>
        )}
      </div>
    </div>
  );
}
