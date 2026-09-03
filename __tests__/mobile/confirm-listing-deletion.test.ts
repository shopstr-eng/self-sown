/** @jest-environment node */

jest.mock("react-native", () => ({
  Alert: { alert: jest.fn() },
}));

import { confirmSellerListingDeletion } from "../../apps/mobile/lib/confirm-listing-deletion";

describe("seller listing deletion confirmation", () => {
  test("does not delete before the destructive confirmation is pressed", () => {
    const onConfirm = jest.fn();
    const showAlert = jest.fn();

    confirmSellerListingDeletion(onConfirm, showAlert);

    expect(onConfirm).not.toHaveBeenCalled();
  });

  test("deletes exactly once after destructive confirmation", () => {
    const onConfirm = jest.fn();
    const showAlert = jest.fn((_title, _message, buttons) => {
      buttons
        ?.find(
          (button: { style?: string; onPress?: () => void }) =>
            button.style === "destructive"
        )
        ?.onPress?.();
    });

    confirmSellerListingDeletion(onConfirm, showAlert);

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  test("presents cancel and destructive actions", () => {
    const showAlert = jest.fn();

    confirmSellerListingDeletion(jest.fn(), showAlert);

    expect(showAlert).toHaveBeenCalledWith(
      "Delete listing?",
      "This listing will be removed from your seller inventory. This action cannot be undone.",
      expect.arrayContaining([
        expect.objectContaining({ text: "Cancel", style: "cancel" }),
        expect.objectContaining({ text: "Delete", style: "destructive" }),
      ])
    );
  });
});
