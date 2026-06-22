import { useState, useContext } from "react";
import type React from "react";
import { Button } from "@heroui/react";
import { WHITEBUTTONCLASSNAMES } from "@/utils/STATIC-VARIABLES";
import { SignerContext } from "./nostr-context-provider";
import {
  getLocalStorageData,
  blossomUpload,
} from "@/utils/nostr/nostr-helper-functions";
import FailureModal from "./failure-modal";

const ACCEPTED_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
];

interface LabReportUploaderButtonProps {
  children: React.ReactNode;
  fileCallbackOnUpload: (file: { url: string; name: string }) => void;
}

export function LabReportUploaderButton({
  children,
  fileCallbackOnUpload,
}: LabReportUploaderButtonProps) {
  const [isUploading, setIsUploading] = useState(false);
  const { signer } = useContext(SignerContext);

  const [showFailureModal, setShowFailureModal] = useState(false);
  const [failureText, setFailureText] = useState("");

  const handleFileUpload = async (
    event: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!ACCEPTED_TYPES.includes(file.type)) {
      setFailureText("Please upload a PDF or image file (JPEG, PNG, or WEBP).");
      setShowFailureModal(true);
      event.target.value = "";
      return;
    }

    setIsUploading(true);

    try {
      const { blossomServers } = getLocalStorageData();
      const isImage = file.type.startsWith("image/");

      const uploadTags = await blossomUpload(
        file,
        isImage,
        signer!,
        blossomServers
      );

      const urlTag = uploadTags.find((tag) => tag[0] === "url");
      if (urlTag && urlTag[1]) {
        fileCallbackOnUpload({ url: urlTag[1], name: file.name });
      } else {
        throw new Error("Failed to get upload URL");
      }
    } catch (error) {
      console.error("Error uploading lab report:", error);
      setFailureText("Failed to upload lab report. Please try again.");
      setShowFailureModal(true);
    } finally {
      setIsUploading(false);
      event.target.value = "";
    }
  };

  return (
    <>
      <div className="w-full">
        <input
          type="file"
          accept=".pdf,image/jpeg,image/png,image/webp"
          onChange={handleFileUpload}
          style={{ display: "none" }}
          id="lab-report-upload"
        />
        <Button
          as="label"
          htmlFor="lab-report-upload"
          className={`w-full cursor-pointer ${WHITEBUTTONCLASSNAMES}`}
          isLoading={isUploading}
          disabled={isUploading}
        >
          {isUploading ? "Uploading..." : children}
        </Button>
      </div>
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
