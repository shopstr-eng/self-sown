"use client";

import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { SignerContext } from "@/components/utility-components/nostr-context-provider";
import ProtectedRoute from "@/components/utility-components/protected-route";
import SellerMembershipsPanel from "@/components/admin/seller-memberships-panel";

type AdminDomain = {
  domain: string;
  pubkey: string;
  shopSlug: string;
  verified: boolean;
  domainType: string;
  tlsStatus: string;
  verificationToken: string | null;
  attachedAt: string | null;
  adminNotifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
  // Live www health check (apex + verified rows only). Null means not
  // applicable/not checked. DNS is verified before any TLS verdict, so a
  // registrar parking page serving valid HTTPS can never masquerade as
  // "attached". This replaces the admin having to remember whether they
  // attached the www variant: a missing attachment is visible here before
  // the seller goes live.
  wwwTls: {
    ok: boolean;
    state: "ok" | "dns_mismatch" | "certificate" | "unreachable";
  } | null;
};

const STATUS_OPTIONS = [
  "pending_dns",
  "dns_verified",
  "attached",
  "active",
  "failed",
] as const;

type AdminGate = "checking" | "allowed" | "denied" | "no-signer";

// Allow the full server-side auth-event window (10 min) for the signer to
// complete. This includes the time the user spends entering an NSec
// passphrase, scrypt decryption (NIP-49 is intentionally slow), and any
// NIP-46 bunker round-trips. Anything shorter punishes NSec users for
// taking a few extra seconds at the passphrase prompt.
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

function AdminDomainsInner() {
  const { signer, pubkey: userPubkey } = useContext(SignerContext);

  const [gate, setGate] = useState<AdminGate>("checking");
  const [domains, setDomains] = useState<AdminDomain[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updating, setUpdating] = useState<string | null>(null);
  const [phase, setPhase] = useState<string>("idle");

  // Hold latest signer in a ref so callbacks always read the current instance
  // without re-running effects when signer churns.
  const signerRef = useRef(signer);
  useEffect(() => {
    signerRef.current = signer;
  }, [signer]);

  const inflightRef = useRef(false);

  // Gate check only depends on userPubkey so signer churn doesn't keep
  // cancelling the in-flight admin check. Signer readiness is verified
  // again at load-time.
  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (!userPubkey) {
        setGate("checking");
        return;
      }
      try {
        const r = await fetch(
          `/api/admin/check?pubkey=${encodeURIComponent(userPubkey)}`
        );
        const data = await r.json();
        if (cancelled) return;
        setGate(data.isAdmin ? "allowed" : "denied");
      } catch (err) {
        console.error("[admin/dashboard] admin check failed", err);
        if (!cancelled) setGate("denied");
      }
    }
    run();
    return () => {
      cancelled = true;
    };
  }, [userPubkey]);

  const load = useCallback(async () => {
    const currentSigner = signerRef.current;
    if (!userPubkey) {
      setError("Sign in required");
      return;
    }
    if (typeof currentSigner?.sign !== "function") {
      setError(
        "Nostr signer isn't ready yet. Try refreshing the page or signing in again."
      );
      return;
    }
    if (inflightRef.current) return;
    inflightRef.current = true;
    setLoading(true);
    setError(null);
    setPhase("signing auth event");
    try {
      const signedEvent = await withTimeout(
        currentSigner.sign({
          kind: 27235,
          created_at: Math.floor(Date.now() / 1000),
          tags: [
            ["action", "admin-domain-list"],
            ["method", "POST"],
            ["path", "/api/admin/custom-domains"],
          ],
          content: "Authorize custom domain admin list",
        } as any),
        SIGN_TIMEOUT_MS,
        "Signer"
      );
      setPhase("fetching domains");
      const r = await fetch("/api/admin/custom-domains", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signedEvent }),
      });
      let data: any = null;
      try {
        data = await r.json();
      } catch {
        data = null;
      }
      if (!r.ok) {
        setError(
          `${(data && data.error) || "Failed to load"}${
            r.status ? ` (HTTP ${r.status})` : ""
          }`
        );
        setDomains([]);
        return;
      }
      setDomains((data && data.domains) || []);
    } catch (err: any) {
      console.error("[admin/dashboard] load failed", err);
      setError(err?.message || "Failed to load domains");
    } finally {
      inflightRef.current = false;
      setLoading(false);
      setPhase("idle");
    }
  }, [userPubkey]);

  // Auto-load once when allowed and signer is ready. Reset whenever the
  // signed-in pubkey changes or the gate leaves "allowed" so account switches
  // re-trigger a load.
  const autoLoadedRef = useRef(false);
  useEffect(() => {
    autoLoadedRef.current = false;
  }, [userPubkey]);
  useEffect(() => {
    if (gate !== "allowed") {
      autoLoadedRef.current = false;
      return;
    }
    if (!autoLoadedRef.current && typeof signer?.sign === "function") {
      autoLoadedRef.current = true;
      load();
    }
  }, [gate, signer, load]);

  const updateStatus = useCallback(
    async (domain: string, tlsStatus: string) => {
      const currentSigner = signerRef.current;
      if (!userPubkey || typeof currentSigner?.sign !== "function") {
        setError("Sign in required");
        return;
      }
      setUpdating(domain);
      setError(null);
      try {
        const signedEvent = await withTimeout(
          currentSigner.sign({
            kind: 27235,
            created_at: Math.floor(Date.now() / 1000),
            tags: [
              ["action", "admin-domain-status"],
              ["method", "POST"],
              ["path", "/api/admin/custom-domains/status"],
              ["field", "domain", domain.toLowerCase()],
              ["field", "tlsStatus", tlsStatus],
            ],
            content: "Authorize custom domain status update",
          } as any),
          SIGN_TIMEOUT_MS,
          "Signer"
        );
        const r = await fetch("/api/admin/custom-domains/status", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ domain, tlsStatus, signedEvent }),
        });
        const data = await r.json();
        if (!r.ok) {
          setError(data.error || "Update failed");
          return;
        }
        await load();
      } catch (err: any) {
        console.error("[admin/dashboard] update failed", err);
        setError(err?.message || "Update failed");
      } finally {
        setUpdating(null);
      }
    },
    [userPubkey, load]
  );

  if (gate === "checking") {
    return (
      <div className="mx-auto max-w-6xl px-4 pt-24 pb-24">
        <p className="text-sm text-gray-500">Verifying admin access…</p>
        <p className="mt-2 font-mono text-xs text-gray-400">
          pubkey: {userPubkey || "(waiting for signer)"}
        </p>
      </div>
    );
  }

  if (gate === "denied") {
    return (
      <div className="mx-auto max-w-6xl px-4 pt-24 pb-24">
        <div className="rounded-lg border border-red-200 bg-red-50 p-6">
          <h1 className="text-xl font-bold text-red-900">
            403: Access restricted
          </h1>
          <p className="mt-2 text-sm text-red-800">
            This page is only available to Self-sown admins. Your signed-in
            pubkey is not on the admin list.
          </p>
          {userPubkey && (
            <p className="mt-2 font-mono text-xs break-all text-red-700">
              {userPubkey}
            </p>
          )}
        </div>
      </div>
    );
  }

  const signerReady = typeof signer?.sign === "function";

  return (
    <div className="mx-auto max-w-6xl px-4 pt-24 pb-24">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">
            Custom Domains (Admin)
          </h1>
          <p className="mt-1 text-sm text-gray-600">
            Manually attach DNS-verified domains in the Replit Deployment
            dashboard, then mark them <code>attached</code>. For apex domains,
            attach <strong>both</strong> the apex and its{" "}
            <code>www.</code> variant — the panel probes www TLS live and
            flags a missing www attachment below. Once the certificate is
            live, mark them <code>active</code>.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading || !signerReady}
          className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          {loading ? "Refreshing…" : "Refresh"}
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

      {loading ? (
        <div className="mt-6 space-y-2">
          <p className="text-sm text-gray-500">Loading… ({phase})</p>
          {phase === "signing auth event" && (
            <p className="text-xs text-gray-400">
              Check your Nostr extension popup or passphrase prompt. It may be
              hidden behind another window. Take your time; the page waits up to{" "}
              {Math.round(SIGN_TIMEOUT_MS / 60_000)} minutes.
            </p>
          )}
        </div>
      ) : domains.length === 0 ? (
        <p className="mt-6 text-sm text-gray-500">No custom domains yet.</p>
      ) : (
        <div className="mt-6 space-y-3">
          {domains.map((d) => (
            <div
              key={d.domain}
              className="rounded-lg border border-gray-200 bg-white p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="font-mono text-base font-semibold text-gray-900">
                    {d.domain}
                  </p>
                  <p className="text-xs text-gray-500">
                    {d.domainType} → /stall/{d.shopSlug} · submitted{" "}
                    {new Date(d.createdAt).toLocaleString()}
                  </p>
                  <p className="mt-1 font-mono text-xs break-all text-gray-400">
                    Seller: {d.pubkey}
                  </p>
                  {d.verificationToken && (
                    <p className="mt-1 font-mono text-xs break-all text-gray-400">
                      TXT (_self-sown.{d.domain}): {d.verificationToken}
                    </p>
                  )}
                </div>
                <div className="flex flex-col items-end gap-2">
                  <span className="rounded-full bg-gray-100 px-3 py-1 text-xs font-semibold text-gray-700">
                    {d.tlsStatus} {d.verified ? "· DNS ✓" : ""}
                  </span>
                  {d.wwwTls?.state === "certificate" && (
                    <div className="max-w-xs rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800">
                      <p className="font-semibold">
                        www not attached — www.{d.domain} points at us but
                        https://www.{d.domain} fails with a certificate error.
                      </p>
                      <p className="mt-1">
                        Attach www.{d.domain} under Publishing → Domains
                        before marking this domain active.
                      </p>
                    </div>
                  )}
                  {d.wwwTls?.state === "dns_mismatch" && (
                    <div className="max-w-xs rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                      <p className="font-semibold">
                        www DNS missing or pointing elsewhere — nothing to
                        attach yet.
                      </p>
                      <p className="mt-1">
                        The seller still needs a www CNAME for {d.domain} (or
                        has a registrar parking/forwarding record shadowing
                        it). Attaching www.{d.domain} now won&apos;t hurt, but
                        it only matters once DNS points at us.
                      </p>
                    </div>
                  )}
                  {d.wwwTls?.state === "unreachable" && (
                    <div className="max-w-xs rounded-lg border border-gray-300 bg-gray-50 px-3 py-2 text-xs text-gray-700">
                      <p className="font-semibold">
                        www check inconclusive — www.{d.domain} points at us
                        but the TLS probe couldn&apos;t connect.
                      </p>
                      <p className="mt-1">
                        Often just DNS/edge propagation. Refresh in a few
                        minutes; if it persists, verify the www attachment
                        under Publishing → Domains.
                      </p>
                    </div>
                  )}
                  {d.wwwTls?.ok && (
                    <span className="rounded-full bg-green-100 px-3 py-1 text-xs font-semibold text-green-800">
                      www TLS ✓
                    </span>
                  )}
                  <select
                    value={d.tlsStatus}
                    onChange={(e) =>
                      void updateStatus(d.domain, e.target.value)
                    }
                    disabled={updating === d.domain}
                    className="rounded-md border border-gray-300 px-2 py-1 text-xs"
                  >
                    {STATUS_OPTIONS.map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <SellerMembershipsPanel />
    </div>
  );
}

export default function AdminDomainsPage() {
  return (
    <ProtectedRoute>
      <AdminDomainsInner />
    </ProtectedRoute>
  );
}
