import { useContext, useEffect, useRef, useState } from "react";
import { Button, Input, Spinner } from "@heroui/react";
import ProtectedRoute from "@/components/utility-components/protected-route";
import { SettingsBreadCrumbs } from "@/components/settings/settings-bread-crumbs";
import UpgradeBanner from "@/components/pro/upgrade-banner";
import { useProMembership } from "@/components/utility-components/pro-membership-context";
import { SignerContext } from "@/components/utility-components/nostr-context-provider";
import AssistantChat from "@/components/assistant/assistant-chat";
import { createNip98AuthorizationHeader } from "@/utils/nostr/nip98-auth";
import { mintScopedSessionToken } from "@/utils/assistant/session-client";
import { PRIMARYBUTTONCLASSNAMES } from "@/utils/STATIC-VARIABLES";

const AssistantSettingsPage = () => {
  const { membership, loading } = useProMembership();
  const { signer, isLoggedIn } = useContext(SignerContext);
  const [writesEnabled, setWritesEnabled] = useState<boolean | null>(null);
  const [nsec, setNsec] = useState("");
  const [enabling, setEnabling] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  // Short-lived bearer token minted from ONE NIP-98 signature, so NIP-07
  // extension / NIP-46 bunker users approve once per window instead of once
  // per interaction. In-memory only — a fresh page load re-mints.
  const sessionRef = useRef<{ token: string; expiresAt: number } | null>(null);

  // Mint (or reuse) an "assistant-setup" scoped session token. Returns null
  // when minting fails — callers fall back to per-request NIP-98 signing.
  const getSessionToken = async (): Promise<string | null> => {
    const cached = sessionRef.current;
    // 60s margin so a token can't expire mid-request.
    if (cached && cached.expiresAt - 60_000 > Date.now()) {
      return cached.token;
    }
    if (!signer) return null;
    const minted = await mintScopedSessionToken(signer, "assistant-setup");
    sessionRef.current = minted;
    return minted?.token ?? null;
  };

  // On load, check whether agent signing is already on file (it is automatic
  // for sellers who configured an MCP API key with signing for external
  // agents — the assistant reuses it).
  useEffect(() => {
    const checkStatus = async () => {
      if (!membership.isPro || !signer || !isLoggedIn) return;
      try {
        const url = `${window.location.origin}/api/assistant/setup`;
        const token = await getSessionToken();
        const authorization = token
          ? `Bearer ${token}`
          : await createNip98AuthorizationHeader(signer, url, "GET");
        const res = await fetch(url, {
          headers: { Authorization: authorization },
        });
        if (res.ok) {
          const data = await res.json();
          setWritesEnabled(Boolean(data.writesEnabled));
        }
      } catch {
        // Best-effort — every chat response also reports the state.
      }
    };
    checkStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [membership.isPro, signer, isLoggedIn]);

  const enableWrites = async () => {
    const trimmed = nsec.trim();
    if (!trimmed || enabling || !signer) return;
    setEnabling(true);
    setSetupError(null);
    try {
      const url = `${window.location.origin}/api/assistant/setup`;
      const body = JSON.stringify({ nsec: trimmed });
      const signedPost = async () =>
        fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: await createNip98AuthorizationHeader(
              signer,
              url,
              "POST",
              body
            ),
          },
          body,
        });
      const token = await getSessionToken();
      let res = token
        ? await fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body,
          })
        : await signedPost();
      // A rejected bearer token (expired, rotated secret) falls back to one
      // signed request so the user's action isn't lost.
      if (res.status === 401 && token) {
        sessionRef.current = null;
        res = await signedPost();
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSetupError(
          (data as { error?: string }).error || `Setup failed (${res.status})`
        );
        return;
      }
      setWritesEnabled(true);
      setNsec("");
    } catch {
      setSetupError("Network error — check your connection and try again.");
    } finally {
      setEnabling(false);
    }
  };

  return (
    <ProtectedRoute>
      <div className="flex min-h-screen flex-col bg-white py-8 md:pb-20">
        <div className="container mx-auto max-w-4xl px-4">
          <SettingsBreadCrumbs />
          <div className="mb-6">
            <h1 className="text-3xl font-bold text-black">AI Assistant</h1>
            <p className="mt-2 text-zinc-600">
              Chat with your stall. The assistant works through the same MCP
              tools external AI agents use — it can answer questions about
              orders, listings, stock, discounts, and analytics, and make
              changes for you on the spot: update listings and email flows, send
              one-off broadcast emails, and buy shipping labels for paid orders.
              It runs on Anthropic, which processes your messages and the
              account data it reads to generate answers.
            </p>
          </div>

          {loading ? (
            <div className="flex justify-center py-12">
              <Spinner />
            </div>
          ) : !membership.isPro ? (
            <div className="space-y-4">
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
                <div className="shadow-neo mb-6 rounded-lg border-2 border-black bg-amber-50 p-4 md:p-6">
                  <h2 className="text-lg font-bold text-black">
                    Enable write actions
                  </h2>
                  <p className="mt-1 text-sm text-zinc-700">
                    Right now the assistant is read-only. To let it make changes
                    — update listings, adjust stock, edit your storefront — it
                    needs your Nostr signing key. The key is stored encrypted
                    and used only for actions you trigger in this chat. Moving
                    money, deleting listings or discount codes, and sending
                    direct messages to buyers always stay manual.
                  </p>
                  <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                    <Input
                      type="password"
                      aria-label="Nostr secret key"
                      placeholder="nsec1... or 64-char hex key"
                      value={nsec}
                      onValueChange={setNsec}
                      classNames={{
                        inputWrapper: "border-2 border-black bg-white",
                      }}
                    />
                    <Button
                      className={PRIMARYBUTTONCLASSNAMES}
                      onPress={enableWrites}
                      isDisabled={enabling || !nsec.trim()}
                    >
                      {enabling ? "Enabling…" : "Enable writes"}
                    </Button>
                  </div>
                  {setupError && (
                    <p className="mt-2 text-sm text-red-600">{setupError}</p>
                  )}
                </div>
              )}
              {writesEnabled === true && (
                <p className="mb-4 text-sm font-medium text-green-700">
                  Write actions are enabled — the assistant can update your
                  stall, listings, stock, discounts, and orders.
                </p>
              )}
              <AssistantChat onWritesStateChange={setWritesEnabled} />
            </>
          )}
        </div>
      </div>
    </ProtectedRoute>
  );
};

export default AssistantSettingsPage;
