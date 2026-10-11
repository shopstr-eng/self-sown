import { Redirect, useLocalSearchParams, type Href } from "expo-router";

// Universal-link target for the account-recovery email: the emailed URL is
// the web page https://self-sown.com/auth/recover?token=..., which devices
// with the app installed open here via the applinks/assetlinks association
// (devices without the app get the web page and never reach this file).
// Hand the token to the native recovery flow with the token step pre-filled.
export default function AuthRecoverDeepLink() {
  const { token } = useLocalSearchParams<{ token?: string }>();
  const activeToken = typeof token === "string" ? token : "";

  return (
    <Redirect
      href={
        {
          pathname: "/recover-account",
          params: { token: activeToken },
        } as Href
      }
    />
  );
}
