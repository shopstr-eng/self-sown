import { Pressable, StyleSheet, Text, View } from "react-native";
import * as WebBrowser from "expo-web-browser";

import { getApiBaseUrl } from "@/lib/api-base-url";
import {
  APPLE_PAY_SERVICE_DISCLAIMER,
  TAP_TO_PAY_PRODUCT_PAGE_PATH,
  TAP_TO_PAY_SHORT_DISCLAIMER,
} from "@self-sown/domain";
import { sellerFonts, sellerThemeTokens } from "@/theme/tokens";

// Apple requires the legal disclaimers to accompany ALL Tap to Pay on iPhone
// advertising (see packages/domain/src/tap-to-pay-marketing-copy.ts for the verbatim text and
// provenance). These in-app placements are tight, so Apple permits the short
// form — but only because it clicks through to the Tap to Pay on iPhone
// product page, which displays the full disclaimer. Every screen that pitches
// or teaches Tap to Pay (awareness moment, education pager) renders this
// footer so the pairing can never silently drop off a placement.
export function TapToPayDisclaimerFooter({
  // Apple's rules require the Apple Pay service disclaimer wherever Apple Pay
  // is named. Pass true when the surrounding copy mentions Apple Pay (the
  // awareness pitch always does; an education slide flags it via
  // slide.applePayMark).
  mentionsApplePay = false,
}: {
  mentionsApplePay?: boolean;
}) {
  const openProductPage = () => {
    // The API base URL IS the platform site origin in release builds
    // (resolveMobileApiBaseUrl enforces public https); in dev it points at
    // the local dev server, which serves the same page.
    void WebBrowser.openBrowserAsync(
      `${getApiBaseUrl()}${TAP_TO_PAY_PRODUCT_PAGE_PATH}`
    ).catch(() => {
      // Non-fatal: the disclaimer text itself is already on screen.
    });
  };

  return (
    <View style={styles.container}>
      <Pressable
        onPress={openProductPage}
        accessibilityRole="link"
        accessibilityLabel={`${TAP_TO_PAY_SHORT_DISCLAIMER} Opens the Tap to Pay on iPhone product page with the full terms.`}
      >
        <Text style={styles.shortDisclaimer}>
          {TAP_TO_PAY_SHORT_DISCLAIMER}
        </Text>
      </Pressable>
      {mentionsApplePay ? (
        <Text style={styles.serviceDisclaimer}>
          {APPLE_PAY_SERVICE_DISCLAIMER}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginTop: 20,
    alignItems: "center",
  },
  shortDisclaimer: {
    fontFamily: sellerFonts.semibold,
    fontSize: 12,
    color: sellerThemeTokens.primary,
    textAlign: "center",
    textDecorationLine: "underline",
  },
  serviceDisclaimer: {
    fontFamily: sellerFonts.regular,
    fontSize: 11,
    lineHeight: 15,
    color: sellerThemeTokens.mutedText,
    textAlign: "center",
    marginTop: 8,
  },
});
