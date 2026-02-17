/* eslint-disable @next/next/no-img-element */

import HomeFeed from "@/components/home/home-feed";

export default function SellerView({
  focusedPubkey,
  setFocusedPubkey,
  selectedSection,
  setSelectedSection,
}: {
  focusedPubkey: string;
  setFocusedPubkey: (value: string) => void;
  selectedSection: string;
  setSelectedSection: (value: string) => void;
}) {
  return (
    <>
      {!focusedPubkey && (
        <div className="flex h-auto w-full items-center justify-center bg-black bg-cover bg-center pt-20">
          <img
            src="/free-milk.png"
            alt="Milk Market Banner"
            className="max-h-[300px] w-full items-center justify-center object-contain py-8"
          />
        </div>
      )}
      <div
        className={`flex h-full min-h-screen flex-col bg-white ${
          focusedPubkey ? "pt-20" : ""
        }`}
      >
        <HomeFeed
          focusedPubkey={focusedPubkey}
          setFocusedPubkey={setFocusedPubkey}
          selectedSection={selectedSection}
          setSelectedSection={setSelectedSection}
        />
      </div>
    </>
  );
}
