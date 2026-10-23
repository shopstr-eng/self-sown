import { useEffect, useContext } from "react";
import { useRouter } from "next/router";
import { SignerContext } from "@/components/utility-components/nostr-context-provider";
import { setLocalStorageDataOnSignIn } from "@/utils/nostr/nostr-helper-functions";
import { NostrNSecSigner } from "@/utils/nostr/signers/nostr-nsec-signer";
import SelfSownSpinner from "@/components/utility-components/ss-spinner";
import { RelaysContext } from "@/utils/context/context";

export default function OAuthSuccess() {
  const router = useRouter();
  const { newSigner } = useContext(SignerContext);
  const relaysContext = useContext(RelaysContext);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const nsec = params.get("nsec");
    const pubkey = params.get("pubkey");
    const provider = params.get("provider");
    const email = params.get("email");
    const isNewUser = params.get("isNewUser");
    const flow = params.get("flow");

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

          // Mirror SignInModal's redirects: seller CTAs ("Start Selling")
          // thread flow=seller through the OAuth handshake and land on
          // settings; every other flow lands on the marketplace. The one
          // exception is a custom-stall sign-up: the modal leaves a
          // buyerOnlySignup marker that user-type consumes to skip the role
          // step and force the buyer profile, so those new users still route
          // through /onboarding/user-type (staleness is handled there).
          const hasBuyerOnlyMarker =
            localStorage.getItem("buyerOnlySignup") !== null;
          router.push(
            flow === "seller"
              ? "/settings"
              : isNewUser === "true" && hasBuyerOnlyMarker
                ? "/onboarding/user-type"
                : "/marketplace"
          );
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
        <SelfSownSpinner />
        <p className="mt-4 text-lg font-bold">Completing sign-in...</p>
      </div>
    </div>
  );
}
