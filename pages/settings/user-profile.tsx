import { useEffect, useState, useContext, useMemo } from "react";
import { SettingsBreadCrumbs } from "@/components/settings/settings-bread-crumbs";
import { ProfileMapContext } from "@/utils/context/context";
import { useForm, Controller } from "react-hook-form";
import { Button, Textarea, Input, Image } from "@heroui/react";
import {
  AVATARBADGEBUTTONCLASSNAMES,
  PRIMARYBUTTONCLASSNAMES,
} from "@/utils/STATIC-VARIABLES";
import {
  SignerContext,
  NostrContext,
} from "@/components/utility-components/nostr-context-provider";
import { NostrNSecSigner } from "@/utils/nostr/signers/nostr-nsec-signer";
import {
  createNostrProfileEvent,
  getLocalUserProfileKey,
  getLegacyLocalUserProfileKey,
  parseLocalProfileFallback,
  isProfileContentPopulated,
} from "@/utils/nostr/nostr-helper-functions";
import { FileUploaderButton } from "@/components/utility-components/file-uploader";
import SelfSownSpinner from "@/components/utility-components/ss-spinner";
import ProtectedRoute from "@/components/utility-components/protected-route";
import { derivePaymentPreference } from "@/utils/lightning/direct-lnurl";

const UserProfilePage = () => {
  const { nostr } = useContext(NostrContext);
  const [isUploadingProfile, setIsUploadingProfile] = useState(false);
  const {
    signer,
    pubkey: userPubkey,
    npub: userNPub,
  } = useContext(SignerContext);
  const [isNPubCopied, setIsNPubCopied] = useState(false);
  const [isNSecCopied, setIsNSecCopied] = useState(false);
  const [userNSec, setUserNSec] = useState("");
  const [viewState, setViewState] = useState<"shown" | "hidden">("hidden");

  const profileContext = useContext(ProfileMapContext);
  const { handleSubmit, control, reset, watch, setValue } = useForm({
    defaultValues: {
      banner: "",
      picture: "",
      display_name: "",
      name: "",
      nip05: "", // Nostr address
      about: "",
      website: "",
      lud16: "", // Lightning address
    },
  });

  const watchBanner = watch("banner");
  const watchPicture = watch("picture");
  const hasCurrentUserProfile =
    !!userPubkey && profileContext.profileData.has(userPubkey);
  const isFetchingProfile =
    !userPubkey || (profileContext.isLoading && !hasCurrentUserProfile);
  const defaultImage = useMemo(() => {
    return "https://robohash.org/" + userPubkey;
  }, [userPubkey]);

  const profileImageSrc = watchPicture || defaultImage;

  // Whether the seller's storefront accepts Bitcoin — drives the derived
  // (read-only) payment preference. Defaults to true like checkout does.
  const [acceptBitcoin, setAcceptBitcoin] = useState(true);
  useEffect(() => {
    if (!userPubkey) return;
    fetch(`/api/storefront/lookup?pubkey=${encodeURIComponent(userPubkey)}`)
      .then((r) => r.json())
      .then((data) => {
        setAcceptBitcoin(data?.shopConfig?.storefront?.acceptBitcoin !== false);
      })
      .catch(() => {});
  }, [userPubkey]);

  useEffect(() => {
    if (!userPubkey || profileContext.isLoading) return;

    const localFallback = parseLocalProfileFallback(
      localStorage.getItem(getLocalUserProfileKey(userPubkey)) ??
        localStorage.getItem(getLegacyLocalUserProfileKey(userPubkey))
    );

    const profileMap = profileContext.profileData;
    const profile = profileMap.has(userPubkey)
      ? profileMap.get(userPubkey)
      : undefined;

    if (profile) {
      const profileCreatedAt = profile.created_at || 0;
      const shouldUseLocalFallback =
        !!localFallback &&
        localFallback.updatedAt > profileCreatedAt &&
        isProfileContentPopulated(localFallback.content);

      if (shouldUseLocalFallback) {
        reset(localFallback.content);
      } else {
        reset(profile.content);
      }

      try {
        localStorage.setItem(
          getLocalUserProfileKey(userPubkey),
          JSON.stringify({
            content: shouldUseLocalFallback
              ? localFallback!.content
              : profile.content,
            updatedAt: shouldUseLocalFallback
              ? localFallback!.updatedAt
              : profileCreatedAt,
          })
        );
      } catch (error) {
        console.error("Failed to persist profile fallback locally:", error);
      }
    } else {
      try {
        if (localFallback?.content) {
          reset(localFallback.content);
        }
      } catch (error) {
        console.error("Failed to read local profile fallback:", error);
      }
    }
  }, [userPubkey, profileContext.isLoading, profileContext.profileData, reset]);

  const onSubmit = async (data: { [x: string]: string }) => {
    if (!userPubkey) {
      console.error("Cannot save profile: pubkey is undefined");
      return;
    }

    setIsUploadingProfile(true);
    try {
      const profileMap = profileContext.profileData;
      const existingProfile = profileMap.has(userPubkey)
        ? profileMap.get(userPubkey)?.content
        : {};

      const updatedData: Record<string, unknown> = {
        ...existingProfile,
        ...data,
      };
      // The payment preference is derived, never chosen manually.
      updatedData.payment_preference = derivePaymentPreference(
        typeof data.lud16 === "string" ? data.lud16 : "",
        acceptBitcoin
      );
      // Migrate the donation key forward if needed; ss_donation (set in shop
      // settings) is the canonical key — never propagate the stale legacy
      // ones, but never lose the value either.
      if (
        updatedData.ss_donation === undefined &&
        updatedData.mm_donation !== undefined
      ) {
        updatedData.ss_donation = updatedData.mm_donation;
      }
      delete updatedData.shopstr_donation;
      delete updatedData.mm_donation;

      try {
        localStorage.setItem(
          getLocalUserProfileKey(userPubkey),
          JSON.stringify({
            content: updatedData,
            updatedAt: Math.floor(Date.now() / 1000),
          })
        );
      } catch (error) {
        console.error("Failed to save local profile fallback:", error);
      }

      if (!nostr || !signer) {
        console.error("Cannot save profile: nostr or signer is unavailable");
        return;
      }

      await createNostrProfileEvent(nostr, signer, JSON.stringify(updatedData));
      profileContext.updateProfileData({
        pubkey: userPubkey,
        content: updatedData,
        created_at: Math.floor(Date.now() / 1000),
      });
    } catch (error) {
      console.error("Failed to save user profile:", error);
    } finally {
      setIsUploadingProfile(false);
    }
  };

  return (
    <ProtectedRoute>
      <div className="flex min-h-screen flex-col bg-white pt-24 md:pb-20">
        <div className="mx-auto h-full w-full px-4 lg:w-1/2">
          <SettingsBreadCrumbs />
          {isFetchingProfile ? (
            <SelfSownSpinner />
          ) : (
            <>
              <div className="mb-20 h-40 rounded-lg bg-white">
                <div className="bg-primary-yellow relative flex h-40 items-center justify-center rounded-lg">
                  {watchBanner && (
                    <Image
                      alt={"User banner image"}
                      src={watchBanner}
                      className="h-40 w-full rounded-lg object-cover object-fill"
                    />
                  )}
                  <FileUploaderButton
                    className={`bg-primary-yellow absolute right-5 bottom-5 z-20 border-2 border-white shadow-md ${PRIMARYBUTTONCLASSNAMES}`}
                    imgCallbackOnUpload={(imgUrl) => setValue("banner", imgUrl)}
                  >
                    Upload Banner
                  </FileUploaderButton>
                </div>
                <div className="flex items-center justify-center">
                  <div className="relative z-20 mt-[-3rem] h-24 w-24 overflow-visible">
                    <FileUploaderButton
                      isIconOnly
                      ariaLabel="Upload profile picture"
                      className={AVATARBADGEBUTTONCLASSNAMES}
                      containerClassName="absolute right-[-0.5rem] bottom-[-0.5rem] z-20"
                      imgCallbackOnUpload={(imgUrl) =>
                        setValue("picture", imgUrl)
                      }
                    />
                    <Image
                      key={profileImageSrc}
                      src={profileImageSrc}
                      alt="user profile picture"
                      radius="full"
                      className="h-24 w-24 rounded-full object-cover"
                    />
                  </div>
                </div>
              </div>

              <div
                className="mx-auto mb-2 flex w-full max-w-2xl cursor-pointer flex-row items-center justify-center rounded-lg border-2 border-black p-2 hover:opacity-60"
                onClick={() => {
                  if (userNPub) navigator.clipboard.writeText(userNPub);
                  setIsNPubCopied(true);
                  setTimeout(() => {
                    setIsNPubCopied(false);
                  }, 2100);
                }}
              >
                <span
                  className="lg:text-base pr-2 text-[0.50rem] font-bold break-all text-black sm:text-xs md:text-sm"
                  suppressHydrationWarning
                >
                  {userNPub}
                </span>
                {isNPubCopied ? (
                  <span
                    aria-hidden="true"
                    className="shrink-0 text-sm leading-none"
                  >
                    ✔️
                  </span>
                ) : (
                  <span
                    aria-hidden="true"
                    className="shrink-0 text-sm leading-none"
                  >
                    📋
                  </span>
                )}
              </div>

              {userNSec ? (
                <div className="mx-auto mb-12 flex w-full max-w-2xl cursor-pointer flex-row items-center justify-center rounded-lg border-2 border-black p-2">
                  <span
                    className="lg:text-base pr-2 text-[0.50rem] font-bold break-all text-black sm:text-xs md:text-sm"
                    suppressHydrationWarning
                  >
                    {viewState === "shown"
                      ? userNSec
                      : "***************************************************************"}
                  </span>
                  {isNSecCopied ? (
                    <span
                      aria-hidden="true"
                      className="shrink-0 text-sm leading-none"
                    >
                      ✔️
                    </span>
                  ) : (
                    <button
                      type="button"
                      aria-label="Copy nsec"
                      className="shrink-0 cursor-pointer text-sm leading-none"
                      onClick={() => {
                        navigator.clipboard.writeText(userNSec);
                        setIsNSecCopied(true);
                        setTimeout(() => {
                          setIsNSecCopied(false);
                        }, 2100);
                      }}
                    >
                      📋
                    </button>
                  )}
                  {viewState === "shown" ? (
                    <button
                      type="button"
                      aria-label="Hide nsec"
                      className="shrink-0 cursor-pointer px-1 text-xl leading-none"
                      onClick={() => {
                        setViewState("hidden");
                      }}
                    >
                      👁️⃠
                    </button>
                  ) : (
                    <button
                      type="button"
                      aria-label="Show nsec"
                      className="shrink-0 cursor-pointer px-1 text-xl leading-none"
                      onClick={async () => {
                        // Only decrypt nsec when user explicitly asks to see it.
                        if (!userNSec && signer instanceof NostrNSecSigner) {
                          try {
                            const nsec = await (
                              signer as NostrNSecSigner
                            )._getNSec();
                            setUserNSec(nsec);
                          } catch (err) {
                            console.error(err);
                          }
                        }
                        setViewState("shown");
                      }}
                    >
                      👁️
                    </button>
                  )}
                </div>
              ) : (
                <div className="mb-12" />
              )}

              <form onSubmit={handleSubmit(onSubmit as any)}>
                <Controller
                  name="display_name"
                  control={control}
                  render={({
                    field: { onChange, onBlur, value },
                    fieldState: { error },
                  }) => {
                    const isErrored = error !== undefined;
                    const errorMessage: string = error?.message
                      ? error.message
                      : "";
                    return (
                      <Input
                        className="pb-4 text-black"
                        classNames={{
                          label: "text-black text-lg",
                        }}
                        variant="bordered"
                        fullWidth={true}
                        label="Display name"
                        labelPlacement="outside"
                        isInvalid={isErrored}
                        errorMessage={errorMessage}
                        placeholder="Add your display name . . ."
                        // controller props
                        onChange={onChange} // send value to hook form
                        onBlur={onBlur} // notify when input is touched/blur
                        value={value}
                      />
                    );
                  }}
                />

                <Controller
                  name="name"
                  control={control}
                  render={({
                    field: { onChange, onBlur, value },
                    fieldState: { error },
                  }) => {
                    const isErrored = error !== undefined;
                    const errorMessage: string = error?.message
                      ? error.message
                      : "";
                    return (
                      <Input
                        className="pb-4 text-black"
                        classNames={{
                          label: "text-black text-lg",
                        }}
                        variant="bordered"
                        fullWidth={true}
                        label="Username"
                        labelPlacement="outside"
                        isInvalid={isErrored}
                        errorMessage={errorMessage}
                        placeholder="Add your username . . ."
                        // controller props
                        onChange={onChange} // send value to hook form
                        onBlur={onBlur} // notify when input is touched/blur
                        value={value}
                      />
                    );
                  }}
                />

                <Controller
                  name="about"
                  control={control}
                  render={({
                    field: { onChange, onBlur, value },
                    fieldState: { error },
                  }) => {
                    const isErrored = error !== undefined;
                    const errorMessage: string = error?.message
                      ? error.message
                      : "";
                    return (
                      <Textarea
                        className="pb-4 text-black"
                        classNames={{
                          label: "text-black text-lg",
                        }}
                        variant="bordered"
                        fullWidth={true}
                        placeholder="Add something about yourself . . ."
                        isInvalid={isErrored}
                        errorMessage={errorMessage}
                        label="About"
                        labelPlacement="outside"
                        // controller props
                        onChange={onChange} // send value to hook form
                        onBlur={onBlur} // notify when input is touched/blur
                        value={value}
                      />
                    );
                  }}
                />

                <Controller
                  name="website"
                  control={control}
                  render={({
                    field: { onChange, onBlur, value },
                    fieldState: { error },
                  }) => {
                    const isErrored = error !== undefined;
                    const errorMessage: string = error?.message
                      ? error.message
                      : "";
                    return (
                      <Input
                        className="pb-4 text-black"
                        classNames={{
                          label: "text-black text-lg",
                        }}
                        variant="bordered"
                        fullWidth={true}
                        label="Website"
                        labelPlacement="outside"
                        isInvalid={isErrored}
                        errorMessage={errorMessage}
                        placeholder="Add your website URL . . ."
                        // controller props
                        onChange={onChange} // send value to hook form
                        onBlur={onBlur} // notify when input is touched/blur
                        value={value}
                      />
                    );
                  }}
                />
                <Controller
                  name="nip05"
                  control={control}
                  render={({
                    field: { onChange, onBlur, value },
                    fieldState: { error },
                  }) => {
                    const isErrored = error !== undefined;
                    const errorMessage: string = error?.message
                      ? error.message
                      : "";
                    return (
                      <Input
                        className="pb-4 text-black"
                        classNames={{
                          label: "text-black text-lg",
                        }}
                        variant="bordered"
                        fullWidth={true}
                        label="Nostr address"
                        labelPlacement="outside"
                        isInvalid={isErrored}
                        errorMessage={errorMessage}
                        placeholder="Add your NIP-05 address . . ."
                        // controller props
                        onChange={onChange} // send value to hook form
                        onBlur={onBlur} // notify when input is touched/blur
                        value={value}
                      />
                    );
                  }}
                />

                <Controller
                  name="lud16"
                  control={control}
                  render={({
                    field: { onChange, onBlur, value },
                    fieldState: { error },
                  }) => {
                    const isErrored = error !== undefined;
                    const errorMessage: string = error?.message
                      ? error.message
                      : "";
                    return (
                      <Input
                        className="pb-4 text-black"
                        classNames={{
                          label: "text-black text-lg",
                        }}
                        variant="bordered"
                        fullWidth={true}
                        label="Lightning address"
                        labelPlacement="outside"
                        isInvalid={isErrored}
                        errorMessage={errorMessage}
                        placeholder="Add your Lightning address . . ."
                        // controller props
                        onChange={onChange} // send value to hook form
                        onBlur={onBlur} // notify when input is touched/blur
                        value={value}
                      />
                    );
                  }}
                />
                <div className="pb-4">
                  <label className="block pb-2 text-lg text-black">
                    Payment preference
                  </label>
                  <div className="border-default-200 flex h-12 items-center rounded-xl border-2 px-3 text-base font-medium text-black">
                    {(() => {
                      const derived = derivePaymentPreference(
                        watch("lud16"),
                        acceptBitcoin
                      );
                      return derived === "lightning"
                        ? "Lightning (Bitcoin)"
                        : derived === "fiat"
                          ? "Local Currency (Fiat)"
                          : "Cashu (Bitcoin)";
                    })()}
                  </div>
                  <p className="mt-2 text-sm font-medium text-black opacity-70">
                    This is set automatically: Lightning when you have a
                    Lightning address, Cashu when no address is set, and Local
                    Currency (Fiat) when Bitcoin payments are turned off in your
                    shop settings.
                  </p>
                </div>

                <Button
                  className={`mb-10 w-full ${PRIMARYBUTTONCLASSNAMES}`}
                  type="submit"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault(); // Prevent default to avoid submitting the form again
                      handleSubmit(onSubmit as any)(); // Programmatic submit
                    }
                  }}
                  isDisabled={isUploadingProfile}
                  isLoading={isUploadingProfile}
                >
                  Save Profile
                </Button>
              </form>
            </>
          )}
        </div>
      </div>
    </ProtectedRoute>
  );
};

export default UserProfilePage;
