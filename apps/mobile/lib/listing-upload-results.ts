export interface SellerListingImageUploadTask {
  fileName: string;
  upload: () => Promise<string>;
}

export interface SellerListingImageUploadResult {
  uploadedUrls: string[];
  failedFileNames: string[];
}

export async function settleSellerListingImageUploads(
  tasks: SellerListingImageUploadTask[]
): Promise<SellerListingImageUploadResult> {
  const results = await Promise.allSettled(tasks.map((task) => task.upload()));

  return results.reduce<SellerListingImageUploadResult>(
    (result, uploadResult, index) => {
      if (uploadResult.status === "fulfilled") {
        result.uploadedUrls.push(uploadResult.value);
      } else {
        result.failedFileNames.push(tasks[index]!.fileName);
      }

      return result;
    },
    { uploadedUrls: [], failedFileNames: [] }
  );
}
