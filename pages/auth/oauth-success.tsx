import { useEffect, useRef, useState, useContext, type FormEvent } from "react";
import { useRouter } from "next/router";
import { SignerContext } from "@/components/utility-components/nostr-context-provider";
import { getLocalStorageData, setLocalStorageDataOnSignIn } from "@/utils/nostr/nostr-helper-functions";
import { NostrNSecSigner } from "@/utils/nostr/signers/nostr-nsec-signer";
import { RelaysContext } from "@/utils/context/context";
import type { OAuthHandoff } from "@/utils/auth/oauth-handoff";

type AccountSetup =
  | { status: "loading" }
  | { status: "unlock"; credentials: OAuthHandoff; error?: string }
  | { status: "saving"; credentials: OAuthHandoff }
  | { status: "failed"; error: string }
  | { status: "complete" };

export default function OAuthSuccess() {
  const router = useRouter();
  const { newSigner } = useContext(SignerContext);
  const relays = useContext(RelaysContext);
  const started = useRef(false);
  const [setup, setSetup] = useState<AccountSetup>({ status: "loading" });
  const [passphrase, setPassphrase] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const credentials = setup.status === "unlock" || setup.status === "saving" ? setup.credentials : undefined;
  const error = setup.status === "failed" || setup.status === "unlock" ? setup.error : undefined;
  const saving = setup.status === "saving";

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const initialize = async () => {
      const params = new URLSearchParams(window.location.search);
      // Retired credential URLs must never be accepted or left in history.
      window.history.replaceState(null, "", "/auth/oauth-success");
      if (params.has("nsec")) throw new Error("Please start sign-in again to use the secure sign-in flow.");
      if (params.get("migrate") === "1") {
        const { signer } = getLocalStorageData();
        if (signer?.type !== "nsec" || !signer.oauthProvider) {
          throw new Error("No legacy OAuth account was found. Please sign in again.");
        }
        const oldUnlock = `oauth-${signer.oauthProvider}-${signer.oauthEmail || signer.pubkey}`;
        const legacy = new NostrNSecSigner({
          encryptedPrivKey: signer.encryptedPrivKey, passphrase: oldUnlock,
        }, async (_type, _challenge, abort) => {
          abort();
          throw new Error("Could not unlock the legacy key. Please sign in with Apple or Google again.");
        });
        const nsec = await legacy._getNSec();
        const pubkey = await legacy.getPubKey();
        setSetup({ status: "unlock", credentials: {
          nsec, pubkey,
          provider: signer.oauthProvider, email: signer.oauthEmail, isNewUser: false,
        } });
        return;
      }
      const response = await fetch("/api/auth/oauth-handoff", {
        method: "POST", credentials: "same-origin",
        headers: { "X-OAuth-Handoff": "1" },
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Please sign in again.");
      setSetup({ status: "unlock", credentials: payload });
    };
    void initialize().catch((e) => setSetup({ status: "failed", error: e instanceof Error ? e.message : "Please sign in again." }));
  }, []);

  const finish = async (event: FormEvent) => {
    event.preventDefault();
    if (setup.status !== "unlock") return;
    const credentials = setup.credentials;
    if (passphrase.length < 12 || passphrase !== confirmation) {
      setSetup({ status: "unlock", credentials, error: "Use at least 12 characters and enter the same passphrase twice." });
      return;
    }
    setSetup({ status: "saving", credentials });
    try {
      const encrypted = NostrNSecSigner.getEncryptedNSEC(credentials.nsec, passphrase);
      if (encrypted.pubkey !== credentials.pubkey) throw new Error("The account key did not match. Please sign in again.");
      const signer = newSigner!("nsec", { ...encrypted, passphrase, memoryOnlyUnlock: true });
      // Persist ciphertext first; a failure must leave legacy recovery data intact.
      await setLocalStorageDataOnSignIn({
        signer, relays: relays.relayList, readRelays: relays.readRelayList, writeRelays: relays.writeRelayList,
      });
      localStorage.setItem("authProvider", credentials.provider);
      if (credentials.email) localStorage.setItem("authEmail", credentials.email);
      else localStorage.removeItem("authEmail");
      const destination = credentials.flow === "seller" ? "/settings"
        : credentials.isNewUser && localStorage.getItem("buyerOnlySignup") !== null
          ? "/onboarding/user-type" : "/marketplace";
      setSetup({ status: "complete" });
      setPassphrase("");
      setConfirmation("");
      await router.replace(destination);
    } catch (e) {
      setSetup({ status: "unlock", credentials, error: e instanceof Error ? e.message : "Could not save your account." });
    }
  };

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 p-6">
      <h1 className="text-2xl font-bold">Secure your account on this device</h1>
      <p>Choose a local unlock passphrase to protect your account key. It is not saved or sent to our servers. You can sign in with Apple or Google again if you forget it.</p>
      {error && <p role="alert">{error}</p>}
      {!credentials ? (setup.status === "failed"
        ? <a className="underline" href="/marketplace">Return to sign-in to try again.</a>
        : <p>{setup.status === "complete" ? "Account secured. Opening your account…" : "Preparing secure sign-in…"}</p>) : (
        <form onSubmit={finish} className="flex flex-col gap-4">
          <label>Local unlock passphrase
            <input className="mt-1 w-full border-2 border-black p-2" type="password" autoComplete="new-password" minLength={12} required value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
          </label>
          <label>Confirm passphrase
            <input className="mt-1 w-full border-2 border-black p-2" type="password" autoComplete="new-password" minLength={12} required value={confirmation} onChange={(e) => setConfirmation(e.target.value)} />
          </label>
          <button className="border-2 border-black bg-black p-3 font-bold text-white disabled:opacity-50" type="submit" disabled={saving}>{saving ? "Securing account…" : "Save and continue"}</button>
        </form>
      )}
    </main>
  );
}
