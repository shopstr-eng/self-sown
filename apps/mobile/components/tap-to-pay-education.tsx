import { useState } from "react";
import { Image, Modal, StyleSheet, Text, View } from "react-native";

import { ActionButton } from "@/components/seller-ui";
import { ApplePayMark } from "@/components/apple-pay-mark";
import {
  TAP_TO_PAY_HERO_ACCESSIBILITY_LABEL,
  TAP_TO_PAY_HERO_IMAGE,
} from "@/lib/tap-to-pay-artwork";
import { TAP_TO_PAY_EDUCATION_SLIDES } from "@/lib/tap-to-pay-education";
import { sellerFonts, sellerThemeTokens } from "@/theme/tokens";

// Apple Tap to Pay checklist 4.2/4.3: the merchant education screens. Shown
// automatically right after the seller accepts Apple's Terms & Conditions
// (awareness moment, Settings enable path, first checkout connect) and
// reopenable anytime from Settings. The pager hero is Apple's own approved
// Tap to Pay on iPhone artwork (Req 4.4 — never self-made iPhone imagery);
// see lib/tap-to-pay-artwork.ts.

export function TapToPayEducationModal({
  visible,
  onDone,
}: {
  visible: boolean;
  onDone: () => void;
}) {
  const [index, setIndex] = useState(0);
  const slide = TAP_TO_PAY_EDUCATION_SLIDES[index];
  const isLast = index === TAP_TO_PAY_EDUCATION_SLIDES.length - 1;
  // VoiceOver summary for the progress dots: one announcement per slide
  // instead of N unlabeled dot elements (Req 4.7 accessibility bar — the
  // slides themselves tell merchants about VoiceOver users).
  const stepLabel = `Step ${index + 1} of ${TAP_TO_PAY_EDUCATION_SLIDES.length}`;

  // The caller owns "seen" persistence; every exit path (Next through the
  // end, Skip, Android back) lands on finish so the flow can't wedge open.
  const finish = () => {
    setIndex(0);
    onDone();
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={finish}
    >
      <View style={styles.container}>
        <Image
          source={TAP_TO_PAY_HERO_IMAGE}
          style={styles.hero}
          resizeMode="contain"
          accessibilityLabel={TAP_TO_PAY_HERO_ACCESSIBILITY_LABEL}
        />
        {slide ? (
          <>
            <Text style={styles.title} accessibilityRole="header">
              {slide.title}
            </Text>
            {slide.applePayMark ? (
              // Slides that advertise Apple Pay acceptance carry Apple's own
              // mark (unmodified toolkit SVG — no crop/recolor/overlay).
              <View style={styles.markRow}>
                <ApplePayMark width={48} />
              </View>
            ) : null}
            <Text style={styles.body}>{slide.body}</Text>
          </>
        ) : null}

        {/* The dots are a purely visual pager: expose them to assistive
            tech as ONE element announcing the position ("Step 2 of 4"),
            and hide the individual dots so VoiceOver never walks four
            unlabeled specks. */}
        <View
          style={styles.dots}
          accessible
          accessibilityRole="text"
          accessibilityLabel={stepLabel}
        >
          {TAP_TO_PAY_EDUCATION_SLIDES.map((s, dotIndex) => (
            <View
              key={s.id}
              style={[styles.dot, dotIndex === index && styles.dotActive]}
              accessibilityElementsHidden
              importantForAccessibility="no"
            />
          ))}
        </View>

        <View style={styles.actions}>
          <View style={styles.actionGap}>
            <ActionButton
              label={isLast ? "Done" : "Next"}
              onPress={() => {
                if (isLast) {
                  finish();
                } else {
                  setIndex(index + 1);
                }
              }}
            />
          </View>
          {!isLast ? (
            <ActionButton label="Skip" variant="secondary" onPress={finish} />
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: sellerThemeTokens.background,
    justifyContent: "center",
    paddingHorizontal: 24,
    paddingVertical: 32,
  },
  // Apple's approved artwork renders unmodified (no border/crop) per the Tap
  // to Pay marketing rules — only size and placement are ours.
  hero: {
    alignSelf: "center",
    width: "100%",
    height: 160,
    marginBottom: 24,
  },
  markRow: {
    alignItems: "center",
    marginBottom: 12,
  },
  title: {
    fontFamily: sellerFonts.extrabold,
    fontSize: 24,
    color: sellerThemeTokens.text,
    textAlign: "center",
    marginBottom: 16,
  },
  body: {
    fontFamily: sellerFonts.regular,
    fontSize: 15,
    lineHeight: 22,
    color: sellerThemeTokens.mutedText,
    textAlign: "center",
    marginBottom: 12,
  },
  dots: {
    flexDirection: "row",
    justifyContent: "center",
    marginTop: 16,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: sellerThemeTokens.mutedText,
    opacity: 0.3,
    marginHorizontal: 4,
  },
  dotActive: {
    opacity: 1,
    backgroundColor: sellerThemeTokens.primary,
  },
  actions: { marginTop: 28 },
  actionGap: { marginBottom: 10 },
});
