import { useState, useContext, useRef } from "react";
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
  const hiddenFileInput = useRef<HTMLInputElement>(null);

  const [showFailureModal, setShowFailureModal] = useState(false);
  const [failureText, setFailureText] = useState("");

  const handleClick = () => {
    if (isUploading) return;
    hiddenFileInput.current?.click();
  };

  const handleFileUpload = async (
    event: React.ChangeEvent<HTMLInputElement>
  ) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;

    const selected = Array.from(files);
    const invalid = selected.some(
      (file) => !ACCEPTED_TYPES.includes(file.type)
    );
    if (invalid) {
      setFailureText("Please upload PDF or image files (JPEG, PNG, or WEBP).");
      setShowFailureModal(true);
      event.target.value = "";
      return;
    }

    setIsUploading(true);

    let anyFailed = false;
    try {
      const { blossomServers } = getLocalStorageData();
      for (const file of selected) {
        try {
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
            anyFailed = true;
          }
        } catch (error) {
          console.error("Error uploading lab report:", error);
          anyFailed = true;
        }
      }
    } finally {
      setIsUploading(false);
      event.target.value = "";
    }

    if (anyFailed) {
      setFailureText(
        "One or more lab test files failed to upload. Please try again."
      );
      setShowFailureModal(true);
    }
  };

  return (
    <>
      <div className="w-full">
        <input
          type="file"
          accept=".pdf,image/jpeg,image/png,image/webp"
          multiple
          ref={hiddenFileInput}
          onChange={handleFileUpload}
          className="hidden"
        />
        <Button
          type="button"
          onClick={handleClick}
          className={`w-full ${WHITEBUTTONCLASSNAMES}`}
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
