import { StyleSheet, Text, View } from "react-native";

import type {
  PopupFlowAnswer,
  PopupFlowStep,
  StorefrontEmailPopup,
} from "@self-sown/domain";

import {
  AddItemButton,
  ColorField,
  DesignHint,
  DesignSectionTitle,
  DesignTextField,
  ListItemChrome,
  NumberField,
  OptionChips,
  ToggleRow,
} from "@/components/design-controls";
import { DesignScreen } from "@/components/design-screen";
import { SellerCard } from "@/components/seller-ui";
import { moveItem } from "@/lib/storefront-design-scopes";
import { useStorefrontDesignStore } from "@/lib/storefront-design-store";
import { sellerFonts, sellerThemeTokens } from "@/theme/tokens";

let popupIdCounter = 0;
function nextPopupId(prefix: string): string {
  popupIdCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${popupIdCounter}`;
}

// Edits draft.emailPopup — the discount popup that collects visitor emails on
// the storefront. Mirrors the web popup editor; the config has no sanitizer
// by design, so these fields round-trip verbatim.
export default function PopupEditorScreen() {
  const popup = useStorefrontDesignStore((state) => state.draft.emailPopup);
  const update = useStorefrontDesignStore((state) => state.update);

  const patch = (patchValue: Partial<StorefrontEmailPopup>) => {
    update((current) => ({
      ...current,
      emailPopup: {
        enabled: current.emailPopup?.enabled ?? false,
        discountPercentage: current.emailPopup?.discountPercentage ?? 10,
        ...(current.emailPopup ?? {}),
        ...patchValue,
      },
    }));
  };

  const style = popup?.style ?? {};
  const patchStyle = (key: string, value: unknown) => {
    patch({
      style: {
        ...style,
        [key]: value,
      },
    });
  };

  const steps = popup?.flowSteps ?? [];

  const patchStep = (
    stepId: string,
    patchStepValue: Partial<PopupFlowStep>
  ) => {
    patch({
      flowSteps: steps.map((step) =>
        step.id === stepId ? { ...step, ...patchStepValue } : step
      ),
    });
  };

  return (
    <DesignScreen
      title="Email popup"
      description="Offer visitors a welcome discount in exchange for their email."
    >
      <SellerCard>
        <DesignSectionTitle title="Popup" />
        <ToggleRow
          label="Enable the email popup"
          value={popup?.enabled === true}
          onChange={(value) => patch({ enabled: value })}
        />
        {popup?.enabled ? (
          <View>
            <OptionChips
              label="Presentation"
              value={popup.displayMode}
              options={[
                { value: "modal", label: "Centered card" },
                { value: "fullscreen", label: "Full screen" },
              ]}
              onChange={(value) => patch({ displayMode: value })}
            />
            <DesignTextField
              label="Headline"
              value={popup.headline}
              onChange={(value) => patch({ headline: value })}
            />
            <DesignTextField
              label="Subtext"
              value={popup.subtext}
              multiline
              onChange={(value) => patch({ subtext: value })}
            />
            <DesignTextField
              label="Button text"
              value={popup.buttonText}
              onChange={(value) => patch({ buttonText: value })}
            />
            <DesignTextField
              label="Success message"
              value={popup.successMessage}
              multiline
              onChange={(value) => patch({ successMessage: value })}
            />
          </View>
        ) : (
          <DesignHint text="Popup settings below apply once you enable it." />
        )}
      </SellerCard>

      {popup?.enabled ? (
        <View>
          <SellerCard>
            <DesignSectionTitle
              title="Welcome discount"
              description="The code a new subscriber receives."
            />
            <NumberField
              label="Product discount (%)"
              value={popup.discountPercentage}
              min={0}
              max={100}
              integer={false}
              onChange={(value) => patch({ discountPercentage: value ?? 0 })}
            />
            <OptionChips
              label="Shipping discount"
              value={popup.shippingDiscountType}
              options={[
                { value: "none", label: "None" },
                { value: "free", label: "Free shipping" },
                { value: "percent", label: "% off" },
                { value: "fixed", label: "Fixed amount off" },
              ]}
              onChange={(value) => patch({ shippingDiscountType: value })}
            />
            {popup.shippingDiscountType === "percent" ||
            popup.shippingDiscountType === "fixed" ? (
              <NumberField
                label={
                  popup.shippingDiscountType === "percent"
                    ? "Shipping discount (%)"
                    : "Shipping discount amount"
                }
                value={popup.shippingDiscountValue}
                min={0}
                integer={false}
                description="Fixed amounts are in the buyer's display currency at checkout."
                onChange={(value) => patch({ shippingDiscountValue: value })}
              />
            ) : null}
            <ToggleRow
              label="Also ask for phone number"
              value={popup.collectPhone === true}
              onChange={(value) => patch({ collectPhone: value })}
            />
            {popup.collectPhone ? (
              <ToggleRow
                label="Require the phone number"
                value={popup.requirePhone === true}
                onChange={(value) => patch({ requirePhone: value })}
              />
            ) : null}
          </SellerCard>

          <SellerCard>
            <DesignSectionTitle title="Appearance" />
            <ColorField
              label="Background"
              value={style.backgroundColor}
              onChange={(value) => patchStyle("backgroundColor", value)}
            />
            <ColorField
              label="Text"
              value={style.textColor}
              onChange={(value) => patchStyle("textColor", value)}
            />
            <ColorField
              label="Accent"
              value={style.accentColor}
              onChange={(value) => patchStyle("accentColor", value)}
            />
            <ColorField
              label="Button"
              value={style.buttonColor}
              onChange={(value) => patchStyle("buttonColor", value)}
            />
            <ColorField
              label="Button text"
              value={style.buttonTextColor}
              onChange={(value) => patchStyle("buttonTextColor", value)}
            />
            <DesignTextField
              label="Background image URL"
              value={style.backgroundImage}
              keyboardType="url"
              placeholder="https://…"
              onChange={(value) => patchStyle("backgroundImage", value)}
            />
            <NumberField
              label="Background overlay darkness (0–100)"
              value={style.overlayOpacity}
              min={0}
              max={100}
              onChange={(value) => patchStyle("overlayOpacity", value)}
            />
            <ToggleRow
              label="Use my storefront fonts"
              description="Off uses the theme's default popup typography."
              value={style.useCustomFonts === true}
              onChange={(value) => patchStyle("useCustomFonts", value)}
            />
          </SellerCard>

          <SellerCard>
            <DesignSectionTitle
              title="Quiz flow"
              description="Optional questions before the email form — each answer can jump to another question or finish."
            />
            {steps.map((step, index) => (
              <ListItemChrome
                key={step.id}
                title={step.question || `Question ${index + 1}`}
                isFirst={index === 0}
                isLast={index === steps.length - 1}
                onMoveUp={() =>
                  patch({ flowSteps: moveItem(steps, index, -1) })
                }
                onMoveDown={() =>
                  patch({ flowSteps: moveItem(steps, index, 1) })
                }
                onDelete={() =>
                  patch({
                    flowSteps: steps
                      .filter((entry) => entry.id !== step.id)
                      .map((entry) => ({
                        ...entry,
                        // Drop answers that routed into the removed step.
                        answers: entry.answers.map((answer) =>
                          answer.nextStepId === step.id
                            ? { ...answer, nextStepId: undefined }
                            : answer
                        ),
                      })),
                  })
                }
              >
                <DesignTextField
                  label="Question"
                  value={step.question}
                  onChange={(value) =>
                    patchStep(step.id, { question: value ?? "" })
                  }
                />
                {step.answers.map((answer, answerIndex) => (
                  <View key={answer.id} style={styles.answerBlock}>
                    <DesignTextField
                      label={`Answer ${answerIndex + 1}`}
                      value={answer.label}
                      onChange={(value) =>
                        patchStep(step.id, {
                          answers: step.answers.map((entry, i) =>
                            i === answerIndex
                              ? { ...entry, label: value ?? "" }
                              : entry
                          ),
                        })
                      }
                    />
                    <OptionChips
                      label="Then go to"
                      value={answer.nextStepId}
                      options={steps
                        .filter(
                          (entry) =>
                            entry.id !== step.id && steps.indexOf(entry) > index
                        )
                        .map((entry) => ({
                          value: entry.id,
                          label: `Q${steps.indexOf(entry) + 1}: ${
                            entry.question.slice(0, 24) || "…"
                          }`,
                        }))}
                      onChange={(value) =>
                        patchStep(step.id, {
                          answers: step.answers.map((entry, i) =>
                            i === answerIndex
                              ? { ...entry, nextStepId: value }
                              : entry
                          ),
                        })
                      }
                    />
                    {step.answers.length > 1 ? (
                      <Text
                        style={styles.removeAnswer}
                        onPress={() =>
                          patchStep(step.id, {
                            answers: step.answers.filter(
                              (_entry, i) => i !== answerIndex
                            ),
                          })
                        }
                        accessibilityRole="button"
                      >
                        Remove answer
                      </Text>
                    ) : null}
                  </View>
                ))}
                <AddItemButton
                  label="Add answer"
                  onPress={() =>
                    patchStep(step.id, {
                      answers: [
                        ...step.answers,
                        {
                          id: nextPopupId("ans"),
                          label: "",
                        } as PopupFlowAnswer,
                      ],
                    })
                  }
                />
              </ListItemChrome>
            ))}
            <AddItemButton
              label="Add question"
              onPress={() =>
                patch({
                  flowSteps: [
                    ...steps,
                    {
                      id: nextPopupId("step"),
                      question: "",
                      answers: [{ id: nextPopupId("ans"), label: "" }],
                    },
                  ],
                })
              }
            />
          </SellerCard>
        </View>
      ) : null}
    </DesignScreen>
  );
}

const styles = StyleSheet.create({
  answerBlock: {
    borderLeftWidth: 2,
    borderLeftColor: sellerThemeTokens.black,
    paddingLeft: 10,
    marginBottom: 4,
  },
  removeAnswer: {
    color: "#c0392b",
    fontSize: 12,
    fontFamily: sellerFonts.bold,
    marginBottom: 10,
  },
});
