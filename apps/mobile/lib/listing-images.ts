import * as DocumentPicker from "expo-document-picker";

import { uploadSellerListingMedia } from "@milk-market/nostr";
import type { SellerSession } from "@milk-market/domain";

import { getApiBaseUrl } from "@/lib/api-base-url";
import {
  settleSellerListingImageUploads,
  type SellerListingImageUploadResult,
} from "@/lib/listing-upload-results";

function createUploadFileName(
  asset: DocumentPicker.DocumentPickerAsset,
  index: number
): string {
  if (asset.name?.trim()) {
    return asset.name.trim();
  }

  const extension = asset.mimeType?.split("/")[1] ?? "jpg";
  return `listing-image-${Date.now()}-${index}.${extension}`;
}

export async function pickAndUploadSellerListingImages(
  session: SellerSession
): Promise<SellerListingImageUploadResult> {
  const result = await DocumentPicker.getDocumentAsync({
    type: "image/*",
    multiple: true,
    copyToCacheDirectory: true,
  });

  if (result.canceled) {
    return { uploadedUrls: [], failedFileNames: [] };
  }

  return settleSellerListingImageUploads(
    result.assets.map((asset, index) => {
      const fileName = createUploadFileName(asset, index);

      return {
        fileName,
        upload: async () => {
          const [bytesResponse, blobResponse] = await Promise.all([
            fetch(asset.uri),
            fetch(asset.uri),
          ]);
          if (!bytesResponse.ok || !blobResponse.ok) {
            throw new Error(
              "Selected image could not be read from the device."
            );
          }

          const [arrayBuffer, uploadBody] = await Promise.all([
            bytesResponse.arrayBuffer(),
            blobResponse.blob(),
          ]);
          const uploaded = await uploadSellerListingMedia({
            baseUrl: getApiBaseUrl(),
            session,
            fileName,
            mimeType: asset.mimeType ?? "image/jpeg",
            bytes: new Uint8Array(arrayBuffer),
            uploadBody,
          });

          return uploaded.url;
        },
      };
    })
  );
}
