import { Alert, type AlertButton } from "react-native";

export type SellerListingDeletionAlert = (
  title: string,
  message: string,
  buttons: AlertButton[]
) => void;

export function confirmSellerListingDeletion(
  onConfirm: () => void,
  showAlert: SellerListingDeletionAlert = Alert.alert
): void {
  showAlert(
    "Delete listing?",
    "This listing will be removed from your seller inventory. This action cannot be undone.",
    [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: onConfirm },
    ]
  );
}
