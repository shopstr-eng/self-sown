import { useState } from "react";
import { Modal, StyleSheet, Text, View } from "react-native";

import { ActionButton } from "@/components/seller-ui";
import { TAP_TO_PAY_EDUCATION_SLIDES } from "@/lib/tap-to-pay-education";
import { sellerFonts, sellerThemeTokens } from "@/theme/tokens";

// Apple Tap to Pay checklist 4.2/4.3: the merchant education screens. Shown
// automatically right after the seller accepts Apple's Terms & Conditions
// (awareness moment, Settings enable path, first checkout connect) and
// reopenable anytime from Settings. Text hero only — Req 4.4 restricts
// imagery to Apple's approved Marketing Toolkit assets, so no self-made
// iPhone artwork here; toolkit art can replace the hero without touching the
// pager.

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
        <View style={styles.hero}>
          <Text style={styles.heroSymbol}>)))</Text>
        </View>
        {slide ? (
          <>
            <Text style={styles.title}>{slide.title}</Text>
            <Text style={styles.body}>{slide.body}</Text>
          </>
        ) : null}

        <View style={styles.dots}>
          {TAP_TO_PAY_EDUCATION_SLIDES.map((s, dotIndex) => (
            <View
              key={s.id}
              style={[styles.dot, dotIndex === index && styles.dotActive]}
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
            <ActionButton
              label="Skip"
              variant="secondary"
              onPress={finish}
            />
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
  hero: {
    alignSelf: "center",
    width: 96,
    height: 96,
    borderWidth: 3,
    borderColor: sellerThemeTokens.black,
    borderRadius: 20,
    backgroundColor: sellerThemeTokens.surface,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 24,
  },
  heroSymbol: {
    fontFamily: sellerFonts.extrabold,
    fontSize: 34,
    color: sellerThemeTokens.primary,
    transform: [{ rotate: "90deg" }],
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
