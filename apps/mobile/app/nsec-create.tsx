import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import {
  createSellerSessionFromNsec,
  generateSellerNsecCredentials,
} from "@self-sown/nostr";

import {
  ActionButton,
  ScreenScrollView,
  ScreenTitle,
  SellerCard,
} from "@/components/seller-ui";
import { getErrorMessage } from "@/lib/error-utils";
import { useSessionUiStore } from "@/stores/session-ui-store";
import { useSessionStore } from "@/stores/session-store";
import { sellerThemeTokens } from "@/theme/tokens";

export default function NsecCreateScreen() {
  const router = useRouter();
  const saveSession = useSessionStore((state) => state.saveSession);
  const setLastUsedAuthMethod = useSessionUiStore(
    (state) => state.setLastUsedAuthMethod
  );

  const [nsec, setNsec] = useState("");
  const [pubkey, setPubkey] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [generationError, setGenerationError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState("");

  const generateFreshCredentials = () => {
    try {
      const nextCredentials = generateSellerNsecCredentials();
      setNsec(nextCredentials.nsec);
      setPubkey(nextCredentials.pubkey);
      setGenerationError(null);
    } catch (error) {
      setNsec("");
      setPubkey("");
      setGenerationError(
        error instanceof Error
          ? error.message
          : "Unable to generate a seller key on this device right now."
      );
    }
  };

  useEffect(() => {
    generateFreshCredentials();
  }, []);

  const handleContinue = async () => {
    setSubmitting(true);
    setSaveError("");
    try {
      await saveSession(
        createSellerSessionFromNsec(nsec, {
          authMethod: "nsec",
        })
      );
      setLastUsedAuthMethod("nsec");
      router.replace("/");
    } catch (caughtError) {
      setSaveError(
        getErrorMessage(caughtError, "Could not save the seller key.")
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ScreenScrollView>
      <ScreenTitle
        eyebrow="Vendor access"
        title="Create a new seller key"
        description="Create a seller key on this device. Save it securely to use this identity on the web or another device."
      />

      <SellerCard title="Generated seller key">
        {generationError ? (
          <Text style={styles.errorText}>{generationError}</Text>
        ) : null}
        {saveError ? <Text style={styles.errorText}>{saveError}</Text> : null}
        <View style={styles.secretBox}>
          <Text style={styles.secretLabel}>nsec</Text>
          <Text style={styles.secretValue}>{nsec}</Text>
        </View>
        <View style={styles.secretBox}>
          <Text style={styles.secretLabel}>pubkey</Text>
          <Text style={styles.secretValue}>{pubkey}</Text>
        </View>
        <Text style={styles.note}>
          Keep this nsec somewhere safe before continuing. Self-sown does not
          include key export or recovery tooling yet.
        </Text>
        <ActionButton
          label="Generate another key"
          onPress={generateFreshCredentials}
          variant="secondary"
        />
        <ActionButton
          label="Continue with this seller key"
          onPress={() => void handleContinue()}
          loading={submitting}
          disabled={!nsec || !pubkey}
        />
      </SellerCard>
    </ScreenScrollView>
  );
}

const styles = StyleSheet.create({
  secretBox: {
    gap: 6,
    padding: 14,
    borderRadius: 14,
    backgroundColor: sellerThemeTokens.subduedSurface,
  },
  secretLabel: {
    color: sellerThemeTokens.primary,
    fontSize: 13,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
  secretValue: {
    color: sellerThemeTokens.text,
    fontSize: 14,
    lineHeight: 21,
  },
  note: {
    color: sellerThemeTokens.warning,
    fontSize: 14,
    lineHeight: 21,
  },
  errorText: {
    color: sellerThemeTokens.danger,
    fontSize: 14,
    lineHeight: 21,
  },
});
