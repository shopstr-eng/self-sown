import React, { useEffect, useState, useContext } from "react";
import {
  Modal,
  ModalContent,
  ModalBody,
  Button,
  Image,
  Input,
  InputProps,
} from "@nextui-org/react";
import {
  WHITEBUTTONCLASSNAMES,
  BLUEBUTTONCLASSNAMES,
} from "@/utils/STATIC-VARIABLES";
import {
  setLocalStorageDataOnSignIn,
  validateNSecKey,
  parseBunkerToken,
} from "@/utils/nostr/nostr-helper-functions";
import MilkMarketSpinner from "@/components/utility-components/mm-spinner";
import { RelaysContext } from "../../utils/context/context";
import { useRouter } from "next/router";
import FailureModal from "../../components/utility-components/failure-modal";
import { SignerContext } from "@/components/utility-components/nostr-context-provider";
import { NostrSigner } from "@/utils/nostr/signers/nostr-signer";
import { NostrNSecSigner } from "@/utils/nostr/signers/nostr-nsec-signer";

export default function SignInModal({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  const [bunkerToken, setBunkerToken] = useState("");
  const [validBunkerToken, setValidBunkerToken] =
    useState<InputProps["color"]>("default");

  const [passphrase, setPassphrase] = useState<string>("");
  const [privateKey, setPrivateKey] = useState<string>("");
  const [validPrivateKey, setValidPrivateKey] =
    useState<InputProps["color"]>("default");

  const [showBunkerSignIn, setShowBunkerSignIn] = useState(false);
  const [isBunkerConnecting, setIsBunkerConnecting] = useState(false);

  const [showNsecSignIn, setShowNsecSignIn] = useState(false);

  const [showFailureModal, setShowFailureModal] = useState(false);
  const [failureText, setFailureText] = useState("");

  const [showNostrOptions, setShowNostrOptions] = useState(false);

  const relaysContext = useContext(RelaysContext);

  const router = useRouter();
  const { newSigner } = useContext(SignerContext);

  const saveSigner = (signer: NostrSigner) => {
    if (
      !relaysContext.isLoading &&
      relaysContext.relayList.length >= 0 &&
      relaysContext.readRelayList &&
      relaysContext.writeRelayList
    ) {
      const generalRelays = relaysContext.relayList;
      const readRelays = relaysContext.readRelayList;
      const writeRelays = relaysContext.writeRelayList;
      setLocalStorageDataOnSignIn({
        signer,
        relays: generalRelays,
        readRelays: readRelays,
        writeRelays: writeRelays,
      });
    } else {
      setLocalStorageDataOnSignIn({
        signer,
      });
    }
  };

  const startExtensionLogin = async () => {
    setShowBunkerSignIn(false);
    setShowNsecSignIn(false);
    try {
      const signer = newSigner!("nip07", {});
      await signer.getPubKey();
      saveSigner(signer);
      onClose();
      router.push("/onboarding/user-profile");
    } catch (error) {
      setFailureText("Extension sign-in failed! " + error);
      setShowFailureModal(true);
    }
  };

  const startBunkerLogin = async () => {
    setIsBunkerConnecting(true);
    try {
      const signer = newSigner!("nip46", { bunker: bunkerToken });
      await signer.connect();
      saveSigner(signer);
      setIsBunkerConnecting(false);
      await signer.getPubKey();
      onClose();
      router.push("/onboarding/user-profile");
    } catch (error) {
      setFailureText("Bunker sign-in failed!");
      setShowFailureModal(true);
      setIsBunkerConnecting(false);
    }
  };

  useEffect(() => {
    if (bunkerToken === "") {
      setValidBunkerToken("default");
    } else {
      setValidBunkerToken(parseBunkerToken(bunkerToken) ? "success" : "danger");
    }
  }, [bunkerToken]);

  const handleGenerateKeys = () => {
    router.push("/onboarding/new-account");
    onClose();
  };

  const handleSignIn = async () => {
    if (validPrivateKey) {
      if (passphrase === "" || passphrase === null) {
        setFailureText("No passphrase provided!");
        setShowFailureModal(true);
      } else {
        const { encryptedPrivKey, pubkey } = NostrNSecSigner.getEncryptedNSEC(
          privateKey,
          passphrase
        );

        setTimeout(() => {
          onClose(); // avoids tree walker issue by closing modal
        }, 500);

        const signer = newSigner!("nsec", {
          encryptedPrivKey: encryptedPrivKey,
          pubkey,
        });
        await signer.getPubKey();
        saveSigner(signer);
        onClose();

        router.push("/onboarding/user-profile");
      }
    } else {
      setFailureText(
        "The private key inputted was not valid! Generate a new key pair or try again."
      );
      setShowFailureModal(true);
    }
  };

  useEffect(() => {
    if (privateKey === "") {
      setValidPrivateKey("default");
    } else {
      setValidPrivateKey(validateNSecKey(privateKey) ? "success" : "danger");
    }
  }, [privateKey]);

  if (!isOpen) return null;

  return (
    <>
      <Modal
        backdrop="blur"
        isOpen={isOpen}
        onClose={() => {
          setShowBunkerSignIn(false);
          setIsBunkerConnecting(false);
          setBunkerToken("");
          setShowNsecSignIn(false);
          setPrivateKey("");
          setPassphrase("");
          setShowNostrOptions(false);
          onClose();
        }}
        classNames={{
          body: "py-6 bg-white",
          backdrop: "bg-black/50 backdrop-opacity-60",
          base: "border-4 border-black rounded-md shadow-neo",
          header: "border-b-4 border-black bg-white rounded-t-md",
          footer: "border-t-4 border-black bg-white rounded-b-md",
          closeButton:
            "hover:bg-gray-100 active:bg-gray-200 text-black font-bold",
        }}
        isDismissable={true}
        scrollBehavior={"normal"}
        placement={"center"}
        size="2xl"
      >
        <ModalContent>
          <ModalBody className="flex flex-col overflow-hidden text-black">
            {!showNostrOptions ? (
              // Initial landing view - Your neobrutalist styled version
              <div className="flex flex-col items-center justify-center space-y-6 py-8">
                <div className="flex items-center justify-center">
                  <Image
                    alt="Milk Market logo"
                    height={80}
                    radius="sm"
                    src="/milk-market.png"
                    width={80}
                  />
                  <h1 className="ml-3 text-4xl font-bold text-black">
                    Milk Market
                  </h1>
                </div>

                {/* Signup image */}
                <div className="w-full max-w-md">
                  <Image src="signup.png" alt="sign up" className="w-full" />
                </div>

                {/* Action buttons */}
                <div className="flex w-full max-w-md flex-col space-y-4">
                  <div className="text-center">
                    <p className="mb-2 text-lg font-bold text-black">
                      New to Milk Market?
                    </p>
                    <p className="mb-4 text-sm text-black">
                      Sign up to get started!
                    </p>
                  </div>

                  <Button
                    className={`${WHITEBUTTONCLASSNAMES} w-full text-lg`}
                    onClick={handleGenerateKeys}
                    size="lg"
                  >
                    Sign Up
                  </Button>

                  <div className="text-center text-xs font-bold text-black">
                    ------ or ------
                  </div>

                  <Button
                    className={`${WHITEBUTTONCLASSNAMES} w-full text-lg`}
                    onClick={() => setShowNostrOptions(true)}
                    size="lg"
                  >
                    Sign In with Nostr
                  </Button>
                </div>
              </div>
            ) : (
              // Nostr sign-in options view
              <div className="flex w-full flex-col">
                <div className="space-y-3">
                  <div className="mb-3 flex items-center justify-center gap-3">
                    <Image
                      alt="Milk Market logo"
                      height={50}
                      radius="sm"
                      src="/milk-market.png"
                      width={50}
                    />
                    <div className="text-2xl font-bold text-black">
                      Milk Market
                    </div>
                  </div>

                  <Button
                    className={`${WHITEBUTTONCLASSNAMES} w-full`}
                    onClick={startExtensionLogin}
                  >
                    Extension Sign-in
                  </Button>

                  <div className="text-center text-xs font-bold text-black">
                    ------ or ------
                  </div>

                  {/* Bunker Sign-in */}
                  <div className="flex flex-col">
                    <div className="">
                      <Button
                        data-testid="bunker-open-btn"
                        onClick={() => {
                          setShowNsecSignIn(false);
                          setShowBunkerSignIn(true);
                        }}
                        className={`${WHITEBUTTONCLASSNAMES} w-full ${
                          showBunkerSignIn ? "hidden" : ""
                        }`}
                      >
                        Bunker Sign-in
                      </Button>
                    </div>
                    <div
                      className={`flex flex-col justify-between space-y-3 ${
                        showBunkerSignIn ? "" : "hidden"
                      }`}
                    >
                      <div>
                        <label className="mb-2 block text-sm font-bold text-black">
                          Bunker Token:
                        </label>
                        <Input
                          color={validBunkerToken}
                          width="100%"
                          size="lg"
                          value={bunkerToken}
                          placeholder="Paste your bunker token (bunker://)..."
                          onChange={(e) => setBunkerToken(e.target.value)}
                          classNames={{
                            input: "text-black font-medium",
                            inputWrapper:
                              "border-3 border-black rounded-md bg-white shadow-none",
                          }}
                        />
                      </div>
                      <div>
                        <Button
                          data-testid="bunker-submit-btn"
                          className={`${BLUEBUTTONCLASSNAMES} w-full`}
                          onClick={startBunkerLogin}
                          isDisabled={validBunkerToken != "success"}
                        >
                          {isBunkerConnecting ? (
                            <div className="flex items-center justify-center">
                              <MilkMarketSpinner />
                            </div>
                          ) : (
                            <>Bunker Sign-in</>
                          )}
                        </Button>
                      </div>
                    </div>
                  </div>

                  <div className="text-center text-xs font-bold text-black">
                    ------ or ------
                  </div>
                </div>

                {/* nsec Sign-in */}
                <div className="flex flex-col">
                  <div className="">
                    <Button
                      data-testid="nsec-open-btn"
                      onClick={() => {
                        setShowBunkerSignIn(false);
                        setShowNsecSignIn(true);
                      }}
                      className={`${WHITEBUTTONCLASSNAMES} w-full ${
                        showNsecSignIn ? "hidden" : ""
                      }`}
                    >
                      nsec Sign-in
                    </Button>
                  </div>
                  <div
                    className={`flex flex-col justify-between space-y-3 ${
                      showNsecSignIn ? "" : "hidden"
                    }`}
                  >
                    <div>
                      <label className="mb-2 block text-sm font-bold text-black">
                        Private Key:
                      </label>
                      <Input
                        color={validPrivateKey}
                        type="password"
                        width="100%"
                        size="lg"
                        value={privateKey}
                        placeholder="Paste your Nostr private key..."
                        onChange={(e) => setPrivateKey(e.target.value)}
                        classNames={{
                          input: "text-black font-medium",
                          inputWrapper:
                            "border-3 border-black rounded-md bg-white shadow-none",
                        }}
                      />
                    </div>
                    <div>
                      <label className="mb-2 block text-sm font-bold text-black">
                        Encryption Passphrase:
                        <span className="text-red-500">*</span>
                      </label>
                      <Input
                        type="password"
                        width="100%"
                        size="lg"
                        value={passphrase}
                        placeholder="Enter a passphrase of your choice..."
                        onChange={(e) => setPassphrase(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && validPrivateKey)
                            handleSignIn();
                        }}
                        classNames={{
                          input: "text-black font-medium",
                          inputWrapper:
                            "border-3 border-black rounded-md bg-white shadow-none",
                        }}
                      />
                    </div>
                    <div>
                      <Button
                        data-testid="nsec-submit-btn"
                        className={`${BLUEBUTTONCLASSNAMES} w-full`}
                        onClick={handleSignIn}
                        isDisabled={validPrivateKey != "success"}
                      >
                        nsec Sign-in
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </ModalBody>
        </ModalContent>
      </Modal>
      <FailureModal
        bodyText={failureText}
        isOpen={showFailureModal}
        onClose={() => {
          setShowFailureModal(false);
          setFailureText("");
        }}
      />
    </>
  );
}
