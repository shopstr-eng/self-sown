import React, { useState } from "react";
import { useRouter } from "next/router";
import { Card, CardBody, Button, Image } from "@nextui-org/react";
import {
  ArrowLongRightIcon,
  ShoppingBagIcon,
  UserIcon,
} from "@heroicons/react/24/outline";
import { WHITEBUTTONCLASSNAMES } from "@/utils/STATIC-VARIABLES";

const UserTypeSelection = () => {
  const router = useRouter();
  const [selectedType, setSelectedType] = useState<"seller" | "buyer" | null>(
    null
  );

  const handleNext = () => {
    if (selectedType === "seller") {
      router.push("/onboarding/user-profile?type=seller");
    } else if (selectedType === "buyer") {
      router.push("/onboarding/user-profile?type=buyer");
    }
  };

  return (
    <div className="flex min-h-screen flex-col bg-light-bg pt-24">
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
            <div className="mb-6 text-center">
              <h2 className="text-2xl font-bold text-dark-text">
                Step 2: Choose Your Role
              </h2>
              <p className="text-dark-text">
                Are you here to buy or sell products?
              </p>
            </div>

            <div className="mb-6 flex flex-col gap-4 md:flex-row">
              <button
                onClick={() => setSelectedType("buyer")}
                className={`flex flex-1 flex-col items-center justify-center rounded-lg border-2 p-6 transition-all ${
                  selectedType === "buyer"
                    ? "border-accent-dark-text bg-accent-dark-text/10"
                    : "border-gray-600 hover:border-gray-400"
                }`}
              >
                <UserIcon className="mb-3 h-16 w-16 text-dark-text" />
                <h3 className="mb-2 text-xl font-bold text-dark-text">Buyer</h3>
                <p className="text-center text-sm text-dark-text">
                  Browse and purchase products from local sellers
                </p>
              </button>

              <button
                onClick={() => setSelectedType("seller")}
                className={`flex flex-1 flex-col items-center justify-center rounded-lg border-2 p-6 transition-all ${
                  selectedType === "seller"
                    ? "border-accent-dark-text bg-accent-dark-text/10"
                    : "border-gray-600 hover:border-gray-400"
                }`}
              >
                <ShoppingBagIcon className="mb-3 h-16 w-16 text-dark-text" />
                <h3 className="mb-2 text-xl font-bold text-dark-text">
                  Seller
                </h3>
                <p className="text-center text-sm text-dark-text">
                  List and sell your products to buyers
                </p>
              </button>
            </div>

            <div className="flex justify-center">
              <Button
                className={WHITEBUTTONCLASSNAMES}
                onClick={handleNext}
                isDisabled={!selectedType}
              >
                Next <ArrowLongRightIcon className="h-5 w-5" />
              </Button>
            </div>
          </CardBody>
        </Card>
      </div>
    </div>
  );
};

export default UserTypeSelection;
