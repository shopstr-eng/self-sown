/** @jest-environment node */

import { settleSellerListingImageUploads } from "../../apps/mobile/lib/listing-upload-results";

describe("seller listing image upload settlement", () => {
  test("keeps successful image URLs when another upload fails", async () => {
    const result = await settleSellerListingImageUploads([
      {
        fileName: "first.jpg",
        upload: async () => "https://cdn.example/first.jpg",
      },
      {
        fileName: "second.jpg",
        upload: async () => {
          throw new Error("private upload response");
        },
      },
      {
        fileName: "third.jpg",
        upload: async () => "https://cdn.example/third.jpg",
      },
    ]);

    expect(result).toEqual({
      uploadedUrls: [
        "https://cdn.example/first.jpg",
        "https://cdn.example/third.jpg",
      ],
      failedFileNames: ["second.jpg"],
    });
    expect(JSON.stringify(result)).not.toContain("private upload response");
  });

  test("attempts every selected image when earlier uploads fail", async () => {
    const attemptedFileNames: string[] = [];
    const createUpload = (fileName: string, succeeds: boolean) => async () => {
      attemptedFileNames.push(fileName);
      if (!succeeds) {
        throw new Error("upload failed");
      }

      return `https://cdn.example/${fileName}`;
    };

    await settleSellerListingImageUploads([
      { fileName: "first.jpg", upload: createUpload("first.jpg", false) },
      { fileName: "second.jpg", upload: createUpload("second.jpg", true) },
      { fileName: "third.jpg", upload: createUpload("third.jpg", false) },
    ]);

    expect(attemptedFileNames).toEqual([
      "first.jpg",
      "second.jpg",
      "third.jpg",
    ]);
  });
});
