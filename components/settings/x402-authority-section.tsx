// Settings → Payments: the x402 custom Lightning invoice authority card.
// Herd (Pro) sellers running their own LNbits instance can have MCP/x402
// Lightning checkout invoices issued by their own node — the x402 request
// hash is embedded directly in the invoice (spec-strict binding) and funds
// land on their own Lightning infrastructure instead of the platform mint.

import { useCallback, useEffect, useState } from "react";
import { Button, Input } from "@heroui/react";
import {
  BoltIcon,
  LinkSlashIcon,
  ServerStackIcon,
} from "@heroicons/react/24/outline";
import {
  BLUEBUTTONCLASSNAMES,
  DANGERBUTTONCLASSNAMES,
} from "@/utils/STATIC-VARIABLES";
import {
  deleteX402Authority,
  fetchX402Authority,
  saveX402Authority,
  type X402AuthorityStatus,
} from "@/utils/x402/client-api";

interface Props {
  signer: { sign: (t: any) => Promise<{ kind: number }> } | null;
  pubkey: string | null;
}

export default function X402AuthoritySection({ signer, pubkey }: Props) {
  const [authority, setAuthority] = useState<X402AuthorityStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [url, setUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState<"save" | "disconnect" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!pubkey || !signer?.sign) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      setAuthority(await fetchX402Authority(signer as never, pubkey));
    } catch {
      // A failed status read must not break the payments page; show the
      // connect form so the seller can still (re)configure.
      setAuthority(null);
    } finally {
      setLoading(false);
    }
  }, [pubkey, signer]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleSave = async () => {
    if (!pubkey || !signer?.sign) return;
    setBusy("save");
    setError(null);
    setInfo(null);
    try {
      const saved = await saveX402Authority(signer as never, pubkey, {
        url: url.trim(),
        apiKey: apiKey.trim(),
      });
      setAuthority(saved);
      setApiKey("");
      setInfo(
        "Connected. Your Lightning checkout invoices are now issued by your own node."
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to connect");
    } finally {
      setBusy(null);
    }
  };

  const handleDisconnect = async () => {
    if (!pubkey || !signer?.sign) return;
    setBusy("disconnect");
    setError(null);
    setInfo(null);
    try {
      await deleteX402Authority(signer as never, pubkey);
      setAuthority(null);
      setInfo("Disconnected. Invoices are issued by the platform mint again.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to disconnect");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="shadow-neo mt-4 space-y-3 rounded-md border-2 border-black bg-white p-5">
      <div className="flex items-start gap-3">
        <BoltIcon className="text-primary-blue mt-0.5 h-6 w-6 shrink-0" />
        <div>
          <p className="font-bold text-black">
            Agent payments: your own Lightning node (Herd)
          </p>
          <p className="text-sm text-gray-700">
            AI agents can pay for your products over x402 (Bitcoin Lightning).
            By default invoices are issued through the platform mint. Connect
            your own LNbits instance to have invoices issued by your node —
            payments settle straight to you, and each invoice is
            cryptographically bound to the exact order request.
          </p>
        </div>
      </div>

      {loading ? null : authority ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2 rounded-md border-2 border-black bg-green-100 p-2 text-sm font-bold text-green-800">
            <ServerStackIcon className="h-5 w-5 text-green-700" />
            <span>Connected: {authority.url} (LNbits)</span>
          </div>
          <Button
            className={DANGERBUTTONCLASSNAMES}
            isLoading={busy === "disconnect"}
            isDisabled={busy !== null}
            startContent={
              busy !== "disconnect" ? (
                <LinkSlashIcon className="h-4 w-4" />
              ) : undefined
            }
            onClick={() => void handleDisconnect()}
          >
            Disconnect
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          <Input
            label="LNbits URL"
            placeholder="https://your-lnbits.example.com"
            value={url}
            onValueChange={setUrl}
            isDisabled={busy !== null}
          />
          <Input
            label="LNbits API key (invoice/read key)"
            placeholder="lnbits inkey or adminkey"
            type="password"
            value={apiKey}
            onValueChange={setApiKey}
            isDisabled={busy !== null}
          />
          <Button
            className={BLUEBUTTONCLASSNAMES}
            isLoading={busy === "save"}
            isDisabled={busy !== null || !url.trim() || !apiKey.trim()}
            onClick={() => void handleSave()}
          >
            Connect Lightning node
          </Button>
          <p className="text-xs text-gray-600">
            The key is verified against your node before saving and stored
            encrypted. If your node is unreachable, agent checkouts fail loudly
            until you reconnect or disconnect here.
          </p>
        </div>
      )}

      {error && <p className="text-sm font-bold text-red-600">{error}</p>}
      {info && <p className="text-sm font-bold text-green-700">{info}</p>}
    </div>
  );
}
