import React, { useEffect, useState, useContext } from "react";
import { useRouter } from "next/router";
import { useForm, Controller } from "react-hook-form";
import { Button, Textarea, Input, Image } from "@nextui-org/react";

import { ShopMapContext } from "@/utils/context/context";
import {
  WHITEBUTTONCLASSNAMES,
  BLUEBUTTONCLASSNAMES,
} from "@/utils/STATIC-VARIABLES";
import {
  SignerContext,
  NostrContext,
} from "@/components/utility-components/nostr-context-provider";
import { createNostrShopEvent } from "@/utils/nostr/nostr-helper-functions";
import { FileUploaderButton } from "@/components/utility-components/file-uploader";
import MilkMarketSpinner from "@/components/utility-components/mm-spinner";

interface ShopProfileFormProps {
  isOnboarding?: boolean;
}

const ShopProfileForm = ({ isOnboarding = false }: ShopProfileFormProps) => {
  const router = useRouter();
  const { nostr } = useContext(NostrContext);
  const [isUploadingShopProfile, setIsUploadingShopProfile] = useState(false);
  const [isFetchingShop, setIsFetchingShop] = useState(false);

  const { signer, pubkey: userPubkey } = useContext(SignerContext);

  const shopContext = useContext(ShopMapContext);
  const { handleSubmit, control, reset, watch, setValue } = useForm({
    defaultValues: {
      banner: "",
      picture: "",
      name: "",
      about: "",
    },
  });

  const watchBanner = watch("banner");
  const watchPicture = watch("picture");
  const defaultImage = "/milk-market.png";

  useEffect(() => {
    setIsFetchingShop(true);
    const shopMap = shopContext.shopData;

    const shop = shopMap.has(userPubkey!)
      ? shopMap.get(userPubkey!)
      : undefined;
    if (shop) {
      const mappedContent = {
        name: shop.content.name,
        about: shop.content.about,
        picture: shop.content.ui.picture,
        banner: shop.content.ui.banner,
      };
      reset(mappedContent);
    }
    setIsFetchingShop(false);
  }, [shopContext, userPubkey, reset]);

  const onSubmit = async (data: { [x: string]: string }) => {
    setIsUploadingShopProfile(true);
    const transformedData = {
      name: data.name || "",
      about: data.about || "",
      ui: {
        picture: data.picture || "",
        banner: data.banner || "",
        theme: "",
        darkMode: false,
      },
      merchants: [userPubkey!],
    };
    await createNostrShopEvent(
      nostr!,
      signer!,
      JSON.stringify(transformedData)
    );
    shopContext.updateShopData({
      pubkey: userPubkey!,
      content: transformedData,
      created_at: 0,
    });
    setIsUploadingShopProfile(false);

    if (isOnboarding) {
      router.push("/onboarding/stripe-connect");
    }
  };

  if (isFetchingShop) {
    return <MilkMarketSpinner />;
  }

  return (
    <>
      <div className="mb-8">
        <div className="relative flex h-48 items-center justify-center overflow-hidden rounded-xl border-3 border-black bg-primary-blue">
          {watchBanner && (
            <Image
              alt={"Shop Banner Image"}
              src={watchBanner}
              className="h-full w-full object-cover"
              classNames={{
                wrapper: "!max-w-full w-full h-full",
              }}
            />
          )}
          <FileUploaderButton
            className={`absolute right-4 top-4 z-20 ${WHITEBUTTONCLASSNAMES}`}
            imgCallbackOnUpload={(imgUrl) => setValue("banner", imgUrl)}
          >
            Upload Banner
          </FileUploaderButton>
        </div>

        <div className="flex items-center justify-center">
          <div className="relative mt-[-4rem] h-32 w-32">
            <div className="relative h-full w-full overflow-hidden rounded-full border-4 border-black bg-white">
              {watchPicture ? (
                <Image
                  src={watchPicture}
                  alt="Shop Logo"
                  className="h-full w-full rounded-full object-cover"
                  classNames={{
                    wrapper: "!max-w-full w-full h-full",
                  }}
                />
              ) : (
                <Image
                  src={defaultImage}
                  alt="Shop Logo"
                  className="h-full w-full rounded-full object-cover"
                  classNames={{
                    wrapper: "!max-w-full w-full h-full",
                  }}
                />
              )}
            </div>
            <FileUploaderButton
              isIconOnly={true}
              className={`!min-w-10 absolute bottom-0 right-0 z-20 !h-10 !w-10 ${WHITEBUTTONCLASSNAMES}`}
              imgCallbackOnUpload={(imgUrl) => setValue("picture", imgUrl)}
            />
          </div>
        </div>
      </div>

      <form onSubmit={handleSubmit(onSubmit as any)} className="space-y-6">
        <Controller
          name="name"
          control={control}
          rules={{
            maxLength: {
              value: 50,
              message: "This input exceed maxLength of 50.",
            },
          }}
          render={({
            field: { onChange, onBlur, value },
            fieldState: { error },
          }) => {
            const isErrored = error !== undefined;
            const errorMessage: string = error?.message ? error.message : "";
            return (
              <div>
                <label className="mb-2 block text-base font-bold text-black">
                  Shop Name
                </label>
                <Input
                  classNames={{
                    inputWrapper:
                      "border-3 border-black rounded-lg bg-white shadow-none hover:bg-white data-[hover=true]:bg-white group-data-[focus=true]:border-4 group-data-[focus=true]:border-black",
                    input: "text-base",
                  }}
                  variant="bordered"
                  fullWidth={true}
                  isInvalid={isErrored}
                  errorMessage={errorMessage}
                  placeholder="Add your shop's name..."
                  onChange={onChange}
                  onBlur={onBlur}
                  value={value}
                />
              </div>
            );
          }}
        />

        <Controller
          name="about"
          control={control}
          rules={{
            maxLength: {
              value: 500,
              message: "This input exceed maxLength of 500.",
            },
          }}
          render={({
            field: { onChange, onBlur, value },
            fieldState: { error },
          }) => {
            const isErrored = error !== undefined;
            const errorMessage: string = error?.message ? error.message : "";
            return (
              <div>
                <label className="mb-2 block text-base font-bold text-black">
                  About
                </label>
                <Textarea
                  classNames={{
                    inputWrapper:
                      "border-3 border-black rounded-lg bg-white shadow-none hover:bg-white data-[hover=true]:bg-white group-data-[focus=true]:border-4 group-data-[focus=true]:border-black",
                    input: "text-base",
                  }}
                  variant="bordered"
                  fullWidth={true}
                  minRows={4}
                  placeholder="Add something about your shop..."
                  isInvalid={isErrored}
                  errorMessage={errorMessage}
                  onChange={onChange}
                  onBlur={onBlur}
                  value={value}
                />
              </div>
            );
          }}
        />

        <Button
          className={`w-full text-lg ${BLUEBUTTONCLASSNAMES}`}
          type="submit"
          size="lg"
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              handleSubmit(onSubmit as any)();
            }
          }}
          isDisabled={isUploadingShopProfile}
          isLoading={isUploadingShopProfile}
        >
          Save Shop
        </Button>
      </form>
    </>
  );
};

export default ShopProfileForm;
