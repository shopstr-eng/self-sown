import React, { useEffect, useState, useContext, useMemo } from "react";
import { useRouter } from "next/router";
import { useForm, Controller } from "react-hook-form";
import { Button, Textarea, Input, Image } from "@nextui-org/react";
import { ProfileMapContext } from "@/utils/context/context";
import {
  BLACKBUTTONCLASSNAMES,
  WHITEBUTTONCLASSNAMES,
} from "@/utils/STATIC-VARIABLES";
import {
  SignerContext,
  NostrContext,
} from "@/components/utility-components/nostr-context-provider";
import { createNostrProfileEvent } from "@/utils/nostr/nostr-helper-functions";
import { FileUploaderButton } from "@/components/utility-components/file-uploader";
import MilkMarketSpinner from "@/components/utility-components/mm-spinner";

interface BuyerProfileFormProps {
  isOnboarding?: boolean;
}

const BuyerProfileForm = ({ isOnboarding }: BuyerProfileFormProps) => {
  const router = useRouter();
  const { nostr } = useContext(NostrContext);
  const [isUploadingProfile, setIsUploadingProfile] = useState(false);
  const [isFetchingProfile, setIsFetchingProfile] = useState(false);

  const { signer, pubkey: userPubkey } = useContext(SignerContext);

  const profileContext = useContext(ProfileMapContext);
  const { handleSubmit, control, reset, watch, setValue } = useForm({
    defaultValues: {
      banner: "",
      picture: "",
      display_name: "",
      name: "",
      about: "",
    },
  });

  const watchBanner = watch("banner");
  const watchPicture = watch("picture");
  const defaultImage = useMemo(() => {
    return "https://robohash.org/" + userPubkey;
  }, [userPubkey]);

  useEffect(() => {
    if (!userPubkey) return;
    setIsFetchingProfile(true);
    const profileMap = profileContext.profileData;
    const profile = profileMap.has(userPubkey)
      ? profileMap.get(userPubkey)
      : undefined;
    if (profile) {
      reset({
        banner: profile.content.banner || "",
        picture: profile.content.picture || "",
        display_name: profile.content.display_name || "",
        name: profile.content.name || "",
        about: profile.content.about || "",
      });
    }
    setIsFetchingProfile(false);
  }, [profileContext, userPubkey, reset]);

  const onSubmit = async (data: { [x: string]: string }) => {
    if (!userPubkey) throw new Error("pubkey is undefined");
    setIsUploadingProfile(true);

    // Preserve existing profile data and only update buyer-relevant fields
    const profileMap = profileContext.profileData;
    const existingProfile = profileMap.has(userPubkey)
      ? profileMap.get(userPubkey)?.content
      : {};

    const updatedData = {
      ...existingProfile,
      banner: data.banner || "",
      picture: data.picture || "",
      display_name: data.display_name || "",
      name: data.name || "",
      about: data.about || "",
    };

    await createNostrProfileEvent(nostr!, signer!, JSON.stringify(updatedData));
    profileContext.updateProfileData({
      pubkey: userPubkey!,
      content: updatedData,
      created_at: 0,
    });
    setIsUploadingProfile(false);

    if (isOnboarding) {
      router.push("/marketplace");
    }
  };

  if (isFetchingProfile) {
    return <MilkMarketSpinner />;
  }

  return (
    <>
      <div className="mb-20 h-40 rounded-lg bg-dark-fg">
        <div className="relative flex h-40 items-center justify-center rounded-lg bg-light-bg">
          {watchBanner && (
            <Image
              alt={"User banner image"}
              src={watchBanner}
              className="h-40 w-full rounded-lg object-cover object-fill"
            />
          )}
          <FileUploaderButton
            className={`absolute bottom-5 right-5 z-20 border-2 border-white shadow-md ${BLACKBUTTONCLASSNAMES}`}
            imgCallbackOnUpload={(imgUrl) => setValue("banner", imgUrl)}
          >
            Upload Banner
          </FileUploaderButton>
        </div>
        <div className="flex items-center justify-center">
          <div className="relative z-20 mt-[-3rem] h-24 w-24">
            <div className="">
              <FileUploaderButton
                isIconOnly
                className={`absolute bottom-[-0.5rem] right-[-0.5rem] z-20 ${BLACKBUTTONCLASSNAMES}`}
                imgCallbackOnUpload={(imgUrl) => setValue("picture", imgUrl)}
              />
              {watchPicture ? (
                <Image
                  src={watchPicture}
                  alt="user profile picture"
                  className="rounded-full"
                />
              ) : (
                <Image
                  src={defaultImage}
                  alt="user profile picture"
                  className="rounded-full"
                />
              )}
            </div>
          </div>
        </div>
      </div>

      <form onSubmit={handleSubmit(onSubmit as any)}>
        <Controller
          name="display_name"
          control={control}
          render={({
            field: { onChange, onBlur, value },
            fieldState: { error },
          }) => {
            const isErrored = error !== undefined;
            const errorMessage: string = error?.message ? error.message : "";
            return (
              <Input
                className="pb-4 text-dark-text"
                classNames={{
                  label: "!text-dark-text text-lg",
                }}
                variant="bordered"
                fullWidth={true}
                label="Display name"
                labelPlacement="outside"
                isInvalid={isErrored}
                errorMessage={errorMessage}
                placeholder="Add your display name . . ."
                onChange={onChange}
                onBlur={onBlur}
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
            const errorMessage: string = error?.message ? error.message : "";
            return (
              <Input
                className="pb-4 text-dark-text"
                classNames={{
                  label: "!text-dark-text text-lg",
                }}
                variant="bordered"
                fullWidth={true}
                label="Username"
                labelPlacement="outside"
                isInvalid={isErrored}
                errorMessage={errorMessage}
                placeholder="Add your username . . ."
                onChange={onChange}
                onBlur={onBlur}
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
            const errorMessage: string = error?.message ? error.message : "";
            return (
              <Textarea
                className="pb-4 text-dark-text"
                classNames={{
                  label: "!text-dark-text text-lg",
                }}
                variant="bordered"
                fullWidth={true}
                placeholder="Add something about yourself . . ."
                isInvalid={isErrored}
                errorMessage={errorMessage}
                label="About"
                labelPlacement="outside"
                onChange={onChange}
                onBlur={onBlur}
                value={value}
              />
            );
          }}
        />

        <Button
          className={`mb-10 w-full ${WHITEBUTTONCLASSNAMES}`}
          type="submit"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              handleSubmit(onSubmit as any)();
            }
          }}
          isDisabled={isUploadingProfile}
          isLoading={isUploadingProfile}
        >
          Save Profile
        </Button>
      </form>
    </>
  );
};

export default BuyerProfileForm;
