"use client";

import { useCallback, useContext, useEffect, useState } from "react";
import { SignerContext } from "@/components/utility-components/nostr-context-provider";
import { createSellerActionAuthEventTemplate } from "@milk-market/nostr";

type DnsRecord = {
  key: string;
  type: string;
  host: string;
  data: string;
  valid: boolean;
};

type SenderDomain = {
  domain: string;
  valid: boolean;
  fromEmail: string | null;
  subdomain: string | null;
  dnsRecords: DnsRecord[];
  createdAt: string;
  lastValidationAt: string | null;
};

const API = "/api/email/sender-domain";
const VERIFY_API = "/api/email/verify-sender-domain";

function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-semibold tracking-wide text-gray-500 uppercase">
        {label}
      </span>
      <div className="flex items-center gap-2 rounded-md border-2 border-black bg-gray-50 px-3 py-2">
        <code className="flex-1 font-mono text-sm break-all text-gray-800">
          {value || "—"}
        </code>
        <button
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            } catch {
              /* ignore */
            }
          }}
          className="rounded-md border-2 border-black bg-white px-2 py-1 text-xs font-bold text-black hover:bg-gray-100"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

function DnsRow({ record }: { record: DnsRecord }) {
  return (
    <div className="space-y-2 rounded-md border-2 border-black p-4">
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold tracking-wide text-gray-500 uppercase">
          {record.key}
        </span>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-bold ${
            record.valid
              ? "bg-green-100 text-green-800"
              : "bg-amber-100 text-amber-800"
          }`}
        >
          {record.valid ? "Verified" : "Pending"}
        </span>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <CopyField label="Type" value={record.type} />
        <CopyField label="Host / Name" value={record.host} />
        <CopyField label="Value" value={record.data} />
      </div>
    </div>
  );
}

export default function EmailSenderDomainSection() {
  const { signer, pubkey: userPubkey } = useContext(SignerContext);

  const [loaded, setLoaded] = useState(false);
  const [record, setRecord] = useState<SenderDomain | null>(null);
  const [input, setInput] = useState("");
  const [fromInput, setFromInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!userPubkey) return;
    try {
      const r = await fetch(`${API}?pubkey=${encodeURIComponent(userPubkey)}`);
      const data = await r.json();
      setRecord(data);
    } catch {
      setRecord(null);
    } finally {
      setLoaded(true);
    }
  }, [userPubkey]);

  useEffect(() => {
    reload();
  }, [reload]);

  // Default the sending-address box to a sensible value once the domain is
  // verified (their saved address, or orders@theirdomain).
  useEffect(() => {
    if (record?.valid) {
      setFromInput(record.fromEmail || `orders@${record.domain}`);
    }
  }, [record?.valid, record?.fromEmail, record?.domain]);

  const onConnect = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);
      setNotice(null);
      if (!signer?.sign || !userPubkey) {
        setError("Please sign in first");
        return;
      }
      const cleanDomain = input.trim().toLowerCase();
      if (!cleanDomain) {
        setError("Enter a domain");
        return;
      }
      setBusy(true);
      try {
        const signedEvent = await signer.sign(
          createSellerActionAuthEventTemplate(
            userPubkey,
            "email-sender-domain-write",
            {
              method: "POST",
              path: API,
              fields: { domain: cleanDomain },
            }
          )
        );
        const r = await fetch(API, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            pubkey: userPubkey,
            domain: cleanDomain,
            signedEvent,
          }),
        });
        const data = await r.json();
        if (!r.ok) {
          setError(data.error || "Failed to connect domain");
          return;
        }
        setInput("");
        setRecord(data);
      } catch (err: any) {
        setError(err?.message || "Failed to connect domain");
      } finally {
        setBusy(false);
      }
    },
    [input, userPubkey, signer]
  );

  const onCheck = useCallback(async () => {
    if (!signer?.sign || !userPubkey) {
      setError("Please sign in first");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const signedEvent = await signer.sign(
        createSellerActionAuthEventTemplate(
          userPubkey,
          "email-sender-domain-write",
          { method: "POST", path: VERIFY_API }
        )
      );
      const r = await fetch(VERIFY_API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pubkey: userPubkey, signedEvent }),
      });
      const data = await r.json();
      if (!r.ok) {
        setError(data.error || "Could not check your setup");
        return;
      }
      setNotice(data.message || null);
      await reload();
    } catch (err: any) {
      setError(err?.message || "Could not check your setup");
    } finally {
      setBusy(false);
    }
  }, [signer, userPubkey, reload]);

  const onSaveFrom = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);
      setNotice(null);
      if (!signer?.sign || !userPubkey) {
        setError("Please sign in first");
        return;
      }
      const cleanFrom = fromInput.trim().toLowerCase();
      if (!cleanFrom) {
        setError("Enter a sending address");
        return;
      }
      setBusy(true);
      try {
        const signedEvent = await signer.sign(
          createSellerActionAuthEventTemplate(
            userPubkey,
            "email-sender-domain-write",
            { method: "PUT", path: API }
          )
        );
        const r = await fetch(API, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            pubkey: userPubkey,
            fromEmail: cleanFrom,
            signedEvent,
          }),
        });
        const data = await r.json();
        if (!r.ok) {
          setError(data.error || "Failed to save sending address");
          return;
        }
        setRecord(data);
        setNotice("Sending address saved. Your emails will now come from it.");
      } catch (err: any) {
        setError(err?.message || "Failed to save sending address");
      } finally {
        setBusy(false);
      }
    },
    [fromInput, signer, userPubkey]
  );

  const onDisconnect = useCallback(async () => {
    if (!signer?.sign || !userPubkey) return;
    if (
      !confirm(
        "Disconnect this email domain? Your emails will go back to being sent from the default Milk Market address."
      )
    )
      return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const signedEvent = await signer.sign(
        createSellerActionAuthEventTemplate(
          userPubkey,
          "email-sender-domain-write",
          { method: "DELETE", path: API }
        )
      );
      const r = await fetch(API, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pubkey: userPubkey, signedEvent }),
      });
      const data = await r.json();
      if (!r.ok) {
        setError(data.error || "Failed to disconnect");
        return;
      }
      setRecord(null);
      setFromInput("");
    } catch (err: any) {
      setError(err?.message || "Failed to disconnect");
    } finally {
      setBusy(false);
    }
  }, [signer, userPubkey]);

  if (!loaded) {
    return (
      <div className="shadow-neo rounded-md border-2 border-black bg-white p-6 text-sm text-gray-500">
        Loading email domain settings…
      </div>
    );
  }

  return (
    <div className="shadow-neo space-y-6 rounded-md border-2 border-black bg-white p-6">
      <div>
        <h3 className="text-lg font-bold text-black">
          Send From Your Own Domain
        </h3>
        <p className="mt-1 text-sm text-gray-600">
          By default your order and flow emails come from Milk Market. Connect
          your own domain so customers see them coming straight from you (e.g.{" "}
          <code className="rounded bg-gray-100 px-1 py-0.5 text-xs">
            orders@yourfarm.com
          </code>
          ). Until your domain is verified, we keep sending from the default
          address so nothing breaks.
        </p>
      </div>

      {error && (
        <div className="rounded-md border-2 border-black bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {notice && (
        <div className="rounded-md border-2 border-black bg-blue-50 p-3 text-sm text-blue-900">
          {notice}
        </div>
      )}

      {!record && (
        <form onSubmit={onConnect} className="space-y-3">
          <label className="block text-sm font-medium text-gray-700">
            Your domain (e.g. <code className="text-xs">yourfarm.com</code>)
          </label>
          <div className="flex flex-wrap gap-2">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="yourfarm.com"
              className="min-w-[240px] flex-1 rounded-md border-2 border-black px-3 py-2 text-sm focus:outline-none"
              disabled={busy}
            />
            <button
              type="submit"
              disabled={busy || !input.trim()}
              className="shadow-neo rounded-md border-2 border-black bg-black px-4 py-2 text-sm font-bold text-white hover:bg-gray-900 disabled:opacity-50"
            >
              {busy ? "Connecting…" : "Connect Domain"}
            </button>
          </div>
        </form>
      )}

      {record && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="font-mono text-base font-semibold text-gray-900">
                {record.domain}
              </p>
              <p className="text-xs text-gray-500">
                Added {new Date(record.createdAt).toLocaleString()}
              </p>
            </div>
            <span
              className={`rounded-full px-3 py-1 text-xs font-bold ${
                record.valid
                  ? "bg-green-100 text-green-800"
                  : "bg-amber-100 text-amber-800"
              }`}
            >
              {record.valid ? "Verified" : "Waiting for DNS"}
            </span>
          </div>

          {!record.valid && (
            <div className="space-y-4">
              <p className="text-sm text-gray-700">
                Add these records to your domain&apos;s DNS settings, then click
                <span className="font-semibold"> Check setup</span>. DNS changes
                can take up to 48 hours to take effect.
              </p>
              {record.dnsRecords.length > 0 ? (
                record.dnsRecords.map((rec) => (
                  <DnsRow key={rec.key} record={rec} />
                ))
              ) : (
                <p className="text-sm text-gray-500">
                  No DNS records available yet. Try reconnecting your domain.
                </p>
              )}
            </div>
          )}

          {record.valid && (
            <form onSubmit={onSaveFrom} className="space-y-3">
              <div className="rounded-md border-2 border-black bg-green-50 p-3 text-sm text-green-900">
                Your domain is verified. Choose the address your emails are sent
                from, it must end with{" "}
                <code className="rounded bg-white px-1 py-0.5 text-xs">
                  @{record.domain}
                </code>
                .
              </div>
              <label className="block text-sm font-medium text-gray-700">
                Sending address
              </label>
              <div className="flex flex-wrap gap-2">
                <input
                  type="email"
                  value={fromInput}
                  onChange={(e) => setFromInput(e.target.value)}
                  placeholder={`orders@${record.domain}`}
                  className="min-w-[240px] flex-1 rounded-md border-2 border-black px-3 py-2 text-sm focus:outline-none"
                  disabled={busy}
                />
                <button
                  type="submit"
                  disabled={busy || !fromInput.trim()}
                  className="shadow-neo rounded-md border-2 border-black bg-black px-4 py-2 text-sm font-bold text-white hover:bg-gray-900 disabled:opacity-50"
                >
                  {busy ? "Saving…" : "Save address"}
                </button>
              </div>
              {record.fromEmail && (
                <p className="text-xs text-gray-500">
                  Currently sending from{" "}
                  <span className="font-mono">{record.fromEmail}</span>.
                </p>
              )}
            </form>
          )}

          <div className="flex flex-wrap gap-2 pt-2">
            {!record.valid && (
              <button
                type="button"
                onClick={onCheck}
                disabled={busy}
                className="shadow-neo rounded-md border-2 border-black bg-black px-4 py-2 text-sm font-bold text-white hover:bg-gray-900 disabled:opacity-50"
              >
                {busy ? "Checking…" : "Check setup"}
              </button>
            )}
            <button
              type="button"
              onClick={onDisconnect}
              disabled={busy}
              className="rounded-md border-2 border-red-400 bg-white px-4 py-2 text-sm font-bold text-red-700 hover:bg-red-50 disabled:opacity-50"
            >
              Disconnect
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
