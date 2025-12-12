import { useEffect, useContext } from "react";
import { useRouter } from "next/router";
import { SignerContext } from "@/components/utility-components/nostr-context-provider";
import { setLocalStorageDataOnSignIn } from "@/utils/nostr/nostr-helper-functions";
import { NostrNSecSigner } from "@/utils/nostr/signers/nostr-nsec-signer";
import MilkMarketSpinner from "@/components/utility-components/mm-spinner";
import { RelaysContext } from "@/utils/context/context";

export default function OAuthSuccess() {
  const router = useRouter();
  const { newSigner } = useContext(SignerContext);
  const relaysContext = useContext(RelaysContext);
  const { nsec, pubkey, provider, email } = router.query;

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const nsec = params.get("nsec");
    const pubkey = params.get("pubkey");
    const provider = params.get("provider");
    const email = params.get("email");
    const isNewUser = params.get("isNewUser");

    if (nsec && pubkey && provider) {
      const handleOAuthSuccess = async () => {
        try {
          // Use a fixed passphrase derived from the OAuth provider
          // This prevents passphrase prompts for OAuth users
          const oauthPassphrase = `oauth-${provider}-${email || pubkey}`;

          const { encryptedPrivKey } = NostrNSecSigner.getEncryptedNSEC(
            nsec,
            oauthPassphrase
          );

          const signer = newSigner!("nsec", {
            encryptedPrivKey: encryptedPrivKey,
            pubkey,
            passphrase: oauthPassphrase, // Store passphrase to prevent modal prompts
          });

          await signer.getPubKey();

          if (
            !relaysContext.isLoading &&
            relaysContext.relayList.length >= 0 &&
            relaysContext.readRelayList &&
            relaysContext.writeRelayList
          ) {
            setLocalStorageDataOnSignIn({
              signer,
              relays: relaysContext.relayList,
              readRelays: relaysContext.readRelayList,
              writeRelays: relaysContext.writeRelayList,
            });
          } else {
            setLocalStorageDataOnSignIn({ signer });
          }

          // Store OAuth provider info
          localStorage.setItem("authProvider", provider);
          if (email) {
            localStorage.setItem("authEmail", email);
          }

          // Route to onboarding for new users, marketplace for existing users
          router.push(isNewUser === "true" ? "/onboarding/user-type" : "/marketplace");
        } catch (error) {
          console.error("OAuth sign-in failed:", error);
          router.push("/");
        }
      };

      handleOAuthSuccess();
    } else {
      router.push("/");
    }
  }, [relaysContext, newSigner, router]);

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="text-center">
        <MilkMarketSpinner />
        <p className="mt-4 text-lg font-bold">Completing sign-in...</p>
      </div>
    </div>
  );
}