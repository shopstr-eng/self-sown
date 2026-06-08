"use client";

import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { nip19 } from "nostr-tools";
import { SignerContext } from "@/components/utility-components/nostr-context-provider";

// Mirror the custom-domain admin page: allow the full server-side auth-event
// window for the signer to complete (NSec passphrase entry, NIP-49 scrypt,
// NIP-46 bunker round-trips).
const SIGN_TIMEOUT_MS = 5 * 60 * 1000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms / 1000}s`)),
      ms
    );
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

type MembershipView = {
  pubkey: string;
  status: string;
  isPro: boolean;
  isLifetime: boolean;
  isTrialing: boolean;
  isReadOnly: boolean;
  isHidden: boolean;
  billingMethod: string | null;
  term: string | null;
  trialEnd: string | null;
  currentPeriodEnd: string | null;
  graceUntil: string | null;
  readonlyUntil: string | null;
  cancelAtPeriodEnd: boolean;
};

// Normalize an npub or 64-char hex pubkey to lowercase hex. Returns null when
// the input isn't a valid pubkey. Must match the server's normalizePubkey so
// the signed auth field binds to the same value the server checks.
function normalizePubkey(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("npub")) {
    try {
      const decoded = nip19.decode(trimmed);
      if (decoded.type === "npub" && typeof decoded.data === "string") {
        return decoded.data.toLowerCase();
      }
    } catch {
      return null;
    }
    return null;
  }
  const hex = trimmed.toLowerCase();
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
}

const MONTH_OPTIONS = [1, 2, 3, 6, 12, 24] as const;

function fmt(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

export default function SellerMembershipsPanel() {
  const { signer, pubkey: userPubkey } = useContext(SignerContext);

  const signerRef = useRef(signer);
  useEffect(() => {
    signerRef.current = signer;
  }, [signer]);

  const [input, setInput] = useState("");
  const [resolvedPubkey, setResolvedPubkey] = useState<string | null>(null);
  const [view, setView] = useState<MembershipView | null>(null);
  const [months, setMonths] = useState<number>(3);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const signEvent = useCallback(
    async (action: string, path: string, fields: Record<string, string>) => {
      const currentSigner = signerRef.current;
      if (!userPubkey || typeof currentSigner?.sign !== "function") {
        throw new Error("Nostr signer isn't ready yet. Try signing in again.");
      }
      const tags: string[][] = [
        ["action", action],
        ["method", "POST"],
        ["path", path],
      ];
      for (const [k, v] of Object.entries(fields)) {
        tags.push(["field", k, v]);
      }
      return withTimeout(
        currentSigner.sign({
          kind: 27235,
          created_at: Math.floor(Date.now() / 1000),
          tags,
          content: `Authorize ${action}`,
        } as any),
        SIGN_TIMEOUT_MS,
        "Signer"
      );
    },
    [userPubkey]
  );

  const lookup = useCallback(async () => {
    setError(null);
    setNotice(null);
    const pubkey = normalizePubkey(input);
    if (!pubkey) {
      setError("Enter a valid seller npub or 64-char hex pubkey.");
      return;
    }
    setBusy("lookup");
    try {
      const signedEvent = await signEvent(
        "admin-membership-lookup",
        "/api/admin/memberships",
        { pubkey }
      );
      const r = await fetch("/api/admin/memberships", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pubkey, signedEvent }),
      });
      const data = await r.json();
      if (!r.ok) {
        setError(data?.error || "Lookup failed");
        setView(null);
        setResolvedPubkey(null);
        return;
      }
      setView(data.view as MembershipView);
      setResolvedPubkey(pubkey);
    } catch (err: any) {
      setError(err?.message || "Lookup failed");
    } finally {
      setBusy(null);
    }
  }, [input, signEvent]);

  const runOp = useCallback(
    async (op: "grant-pro" | "grant-lifetime" | "revoke") => {
      setError(null);
      setNotice(null);
      const pubkey = resolvedPubkey || normalizePubkey(input);
      if (!pubkey) {
        setError("Look up a seller first.");
        return;
      }
      if (op === "revoke") {
        const ok = window.confirm(
          "Revoke this seller's membership and downgrade them to the free tier? This also cancels any live Stripe subscription."
        );
        if (!ok) return;
      }
      const opMonths = op === "grant-pro" ? months : 0;
      setBusy(op);
      try {
        const signedEvent = await signEvent(
          "admin-membership-update",
          "/api/admin/memberships/update",
          { pubkey, op, months: String(opMonths) }
        );
        const r = await fetch("/api/admin/memberships/update", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pubkey, op, months: opMonths, signedEvent }),
        });
        const data = await r.json();
        if (!r.ok) {
          setError(data?.error || "Update failed");
          return;
        }
        setView(data.view as MembershipView);
        setResolvedPubkey(pubkey);
        setNotice(
          op === "grant-pro"
            ? `Granted ${opMonths} month(s) of Herd access.`
            : op === "grant-lifetime"
              ? "Granted Wrangler lifetime access."
              : "Membership revoked — seller is back on the free tier."
        );
      } catch (err: any) {
        setError(err?.message || "Update failed");
      } finally {
        setBusy(null);
      }
    },
    [resolvedPubkey, input, months, signEvent]
  );

  const signerReady = typeof signer?.sign === "function";
  const anyBusy = busy !== null;

  return (
    <section className="mt-12 border-t border-gray-200 pt-8">
      <h2 className="text-2xl font-bold text-gray-900">Seller Memberships</h2>
      <p className="mt-1 text-sm text-gray-600">
        Look up a seller by npub or hex pubkey, then manually grant timed Herd
        access, grant Wrangler lifetime access, or revoke their membership.
      </p>

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1">
          <label className="block text-xs font-medium text-gray-600">
            Seller npub or hex pubkey
          </label>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !anyBusy) lookup();
            }}
            placeholder="npub1… or 64-char hex"
            spellCheck={false}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-sm"
          />
        </div>
        <button
          type="button"
          onClick={lookup}
          disabled={anyBusy || !signerReady}
          className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          {busy === "lookup" ? "Looking up…" : "Look up"}
        </button>
      </div>

      {!signerReady && (
        <div className="mt-4 rounded bg-amber-50 p-3 text-sm text-amber-800">
          Waiting for Nostr signer to initialize. If this persists, refresh the
          page or sign in again.
        </div>
      )}

      {error && (
        <div className="mt-4 rounded bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {notice && (
        <div className="mt-4 rounded bg-green-50 p-3 text-sm text-green-800">
          {notice}
        </div>
      )}

      {view && (
        <div className="mt-6 rounded-lg border border-gray-200 bg-white p-4">
          <p className="font-mono text-xs break-all text-gray-500">
            {view.pubkey}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-gray-100 px-3 py-1 text-xs font-semibold text-gray-700">
              {view.isLifetime
                ? "Wrangler (lifetime)"
                : view.isPro
                  ? `Herd (${view.status})`
                  : view.status}
            </span>
            {view.billingMethod && (
              <span className="rounded-full bg-gray-100 px-3 py-1 text-xs text-gray-600">
                via {view.billingMethod}
              </span>
            )}
            {view.cancelAtPeriodEnd && (
              <span className="rounded-full bg-amber-100 px-3 py-1 text-xs text-amber-800">
                cancels at period end
              </span>
            )}
          </div>
          {!view.isLifetime && (
            <dl className="mt-3 grid grid-cols-1 gap-1 text-xs text-gray-600 sm:grid-cols-2">
              <div>
                <dt className="inline font-medium">Trial ends: </dt>
                <dd className="inline">{fmt(view.trialEnd)}</dd>
              </div>
              <div>
                <dt className="inline font-medium">Period ends: </dt>
                <dd className="inline">{fmt(view.currentPeriodEnd)}</dd>
              </div>
              <div>
                <dt className="inline font-medium">Grace until: </dt>
                <dd className="inline">{fmt(view.graceUntil)}</dd>
              </div>
              <div>
                <dt className="inline font-medium">Read-only until: </dt>
                <dd className="inline">{fmt(view.readonlyUntil)}</dd>
              </div>
            </dl>
          )}

          <div className="mt-5 flex flex-wrap items-end gap-3 border-t border-gray-100 pt-4">
            <div>
              <label className="block text-xs font-medium text-gray-600">
                Herd duration
              </label>
              <select
                value={months}
                onChange={(e) => setMonths(Number(e.target.value))}
                disabled={anyBusy}
                className="mt-1 rounded-md border border-gray-300 px-2 py-2 text-sm"
              >
                {MONTH_OPTIONS.map((m) => (
                  <option key={m} value={m}>
                    {m} month{m > 1 ? "s" : ""}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              onClick={() => runOp("grant-pro")}
              disabled={anyBusy || !signerReady}
              className="rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800 disabled:opacity-50"
            >
              {busy === "grant-pro" ? "Granting…" : "Grant Herd"}
            </button>
            <button
              type="button"
              onClick={() => runOp("grant-lifetime")}
              disabled={anyBusy || !signerReady}
              className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-medium text-white hover:bg-amber-600 disabled:opacity-50"
            >
              {busy === "grant-lifetime" ? "Granting…" : "Grant Wrangler"}
            </button>
            <button
              type="button"
              onClick={() => runOp("revoke")}
              disabled={anyBusy || !signerReady}
              className="rounded-lg border border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
            >
              {busy === "revoke" ? "Revoking…" : "Revoke"}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
