import { Platform } from "react-native";
import { resolveMobileApiBaseUrl } from "./api-configuration";
export function getApiBaseUrl(): string {
  return resolveMobileApiBaseUrl(
    process.env.EXPO_PUBLIC_API_BASE_URL,
    Platform.OS,
    __DEV__
  );
}
