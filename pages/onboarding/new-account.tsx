import { useState, useEffect, useContext } from "react";
import { useRouter } from "next/router";
import { InformationCircleIcon } from "@heroicons/react/24/outline";
import {
  Card,
  CardBody,
  Button,
  Input,
  Image,
  Tooltip,
} from "@nextui-org/react";
import { ArrowLongRightIcon } from "@heroicons/react/24/outline";
import { WHITEBUTTONCLASSNAMES } from "@/utils/STATIC-VARIABLES";
import {
  generateKeys,
  setLocalStorageDataOnSignIn,
} from "@/utils/nostr/nostr-helper-functions";
import { RelaysContext } from "../../utils/context/context";
import { SignerContext } from "@/components/utility-components/nostr-context-provider";
import { NostrSigner } from "@/utils/nostr/signers/nostr-signer";
import { NostrNSecSigner } from "@/utils/nostr/signers/nostr-nsec-signer";
import FailureModal from "../../components/utility-components/failure-modal";

const Keys = () => {
  const router = useRouter();

  const [privateKey, setPrivateKey] = useState<string>("");
  const [passphrase, setPassphrase] = useState<string>("");

  const [showFailureModal, setShowFailureModal] = useState(false);

  const { newSigner } = useContext(SignerContext);
  const relaysContext = useContext(RelaysContext);

  const saveSigner = (signer: NostrSigner) => {
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
  };

  useEffect(() => {
    const fetchKeys = async () => {
      const { nsec } = await generateKeys();
      setPrivateKey(nsec);
    };

    fetchKeys();
  }, []);

  const handleNext = async () => {
    if (passphrase === "" || passphrase === null) {
      setShowFailureModal(true);
    } else {
      const { encryptedPrivKey, pubkey } = NostrNSecSigner.getEncryptedNSEC(
        privateKey,
        passphrase
      );
      const signer = newSigner!("nsec", {
        encryptedPrivKey: encryptedPrivKey,
        pubkey,
      });
      await signer.getPubKey();
      saveSigner(signer);
      router.push("/onboarding/user-type");
    }
  };

  return (
    <>
      <div className="flex h-[100vh] flex-col bg-light-bg pt-24">
        <div className="mx-auto w-full max-w-2xl px-4 py-6">
          <Card className="bg-dark-fg">
            <CardBody>
              <div className="mb-4 flex flex-row items-center justify-center">
                <Image
                  alt="Milk Market logo"
                  height={50}
                  radius="sm"
                  src="/milk-market.png"
                  width={50}
                />
                <h1 className="cursor-pointer text-center text-3xl font-bold text-dark-text">
                  Milk Market
                </h1>
              </div>
              <div className="mb-4 text-center">
                <h2 className="text-2xl font-bold text-dark-text">
                  Step 1: Account Creation
                </h2>
                <p className="text-dark-text">
                  Enter a passphrase to make sure your data is secured. You can
                  view your account information under your profile settings.
                </p>
              </div>

              <div className="mb-4 flex flex-col space-y-2 text-dark-text">
                <div className="flex items-center gap-2">
                  <label className="text-xl">
                    Passphrase:<span className="text-red-500">*</span>
                  </label>
                  <Tooltip
                    content="This passphrase acts as a password and is used to keep your account secure. Remember it and keep it safe as it can't be recovered!"
                    placement="bottom"
                    trigger="focus"
                    classNames={{
                      content: "bg-dark-bg text-dark-text p-2 max-w-xs",
                    }}
                  >
                    <button
                      type="button"
                      className="flex items-center justify-center"
                      aria-label="Passphrase information"
                    >
                      <InformationCircleIcon className="h-5 w-5 cursor-pointer text-dark-text" />
                    </button>
                  </Tooltip>
                </div>
                <Input
                  type="password"
                  fullWidth
                  size="lg"
                  value={passphrase}
                  placeholder="Enter a passphrase of your choice..."
                  onChange={(e) => setPassphrase(e.target.value)}
                  onKeyDown={(e) => {
                    if (
                      e.key === "Enter" &&
                      !(passphrase === "" || passphrase === null)
                    )
                      handleNext();
                  }}
                />
              </div>

              <div className="flex justify-center">
                <Button className={WHITEBUTTONCLASSNAMES} onClick={handleNext}>
                  Next <ArrowLongRightIcon className="h-5 w-5" />
                </Button>
              </div>
            </CardBody>
          </Card>
        </div>
      </div>
      <FailureModal
        bodyText="No passphrase provided!"
        isOpen={showFailureModal}
        onClose={() => setShowFailureModal(false)}
      />
    </>
  );
};

export default Keys;
