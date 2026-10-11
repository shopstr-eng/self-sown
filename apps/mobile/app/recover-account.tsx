import { useRouter } from "expo-router";
import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import { createSellerSessionFromNsec } from "@self-sown/nostr";

import {
  ActionButton,
  ScreenScrollView,
  ScreenTitle,
  SellerCard,
  SellerField,
} from "@/components/seller-ui";
import { mobileApiClient } from "@/lib/api-client";
import { validateRecoveryEmail } from "@/lib/account-recovery";
import { getErrorMessage } from "@/lib/error-utils";
import { useSessionUiStore } from "@/stores/session-ui-store";
import { useSessionStore } from "@/stores/session-store";
import { sellerThemeTokens } from "@/theme/tokens";

// Mobile port of the web recovery flow in pages/auth/recover.tsx, reusing the
// same unauthenticated endpoints: request-recovery emails a token,
// verify-recovery-token checks it, and reset-password returns the seller's
// nsec once the recovery key checks out.
type Step = "email" | "verify" | "reset" | "success";

// Sellers may paste the whole recovery link instead of just the token.
function extractToken(input: string): string {
  const trimmed = input.trim();
  const match = /[?&]token=([^&#]+)/.exec(trimmed);
  if (match?.[1]) {
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }
  return trimmed;
}

export default function RecoverAccountScreen() {
  const router = useRouter();
  const saveSession = useSessionStore((state) => state.saveSession);
  const setLastUsedAuthMethod = useSessionUiStore(
    (state) => state.setLastUsedAuthMethod
  );

  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [verifiedEmail, setVerifiedEmail] = useState("");
  const [token, setToken] = useState("");
  const [recoveryKey, setRecoveryKey] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [authType, setAuthType] = useState("email");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const credentialLabel = authType === "email" ? "password" : "passphrase";

  const handleRequestRecovery = async () => {
    const emailError = validateRecoveryEmail(email);
    if (emailError) {
      setError(emailError);
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      await mobileApiClient.requestAccountRecovery({ email: email.trim() });
      setStep("verify");
    } catch (caughtError) {
      setError(
        getErrorMessage(caughtError, "Failed to request account recovery.")
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleVerifyToken = async () => {
    const activeToken = extractToken(token);
    if (!activeToken) {
      setError("Please enter the recovery token from your email.");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const response = await mobileApiClient.verifyAccountRecoveryToken({
        token: activeToken,
      });
      setVerifiedEmail(response.email);
      setAuthType(response.authType || "email");
      setToken(activeToken);
      setStep("reset");
    } catch (caughtError) {
      setError(getErrorMessage(caughtError, "Invalid or expired token."));
    } finally {
      setSubmitting(false);
    }
  };

  const handleResetPassword = async () => {
    const activeToken = extractToken(token);
    if (!recoveryKey.trim()) {
      setError("Please enter your recovery key.");
      return;
    }
    if (!newPassword) {
      setError(`Please enter a new ${credentialLabel}.`);
      return;
    }
    if (newPassword !== confirmPassword) {
      setError(
        `${
          credentialLabel === "password" ? "Passwords" : "Passphrases"
        } do not match.`
      );
      return;
    }
    if (newPassword.length < 6) {
      setError(
        `${
          credentialLabel === "password" ? "Password" : "Passphrase"
        } must be at least 6 characters.`
      );
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const response = await mobileApiClient.resetAccountRecoveryPassword({
        token: activeToken,
        recoveryKey: recoveryKey.replace(/\s/g, ""),
        newPassword,
      });

      const recoveredAuthMethod =
        response.authType === "email" ? "email" : "nsec";
      const session = createSellerSessionFromNsec(response.nsec, {
        authMethod: recoveredAuthMethod,
        email: recoveredAuthMethod === "email" ? verifiedEmail : undefined,
      });

      await saveSession(session);
      setLastUsedAuthMethod(recoveredAuthMethod);
      setStep("success");
    } catch (caughtError) {
      setError(
        getErrorMessage(caughtError, "Failed to recover your account.")
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <ScreenScrollView>
      <ScreenTitle
        eyebrow="Vendor access"
        title="Recover your account"
        description="Use your recovery key and the link we email you to restore access on this device."
      />

      {error ? (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      {step === "email" ? (
        <SellerCard
          title="Find your account"
          description="Enter the email address you used to set up account recovery. We'll email you a recovery link."
        >
          <SellerField
            label="Email"
            value={email}
            onChangeText={(value) => {
              setEmail(value);
              if (error) setError("");
            }}
            placeholder="seller@example.com"
            keyboardType="email-address"
            autoCapitalize="none"
          />
          <ActionButton
            label="Send recovery link"
            onPress={() => void handleRequestRecovery()}
            loading={submitting}
            disabled={!email.trim()}
          />
          <ActionButton
            label="I already have a recovery token"
            onPress={() => {
              setError("");
              setStep("verify");
            }}
            variant="secondary"
          />
        </SellerCard>
      ) : null}

      {step === "verify" ? (
        <SellerCard
          title="Verify your recovery link"
          description="If an account exists for that email, a recovery link is on its way. Paste the token from the link (or the whole link) below."
        >
          <SellerField
            label="Recovery token"
            value={token}
            onChangeText={(value) => {
              setToken(value);
              if (error) setError("");
            }}
            placeholder="Paste token or recovery link"
            autoCapitalize="none"
          />
          <Text style={styles.helpText}>
            The link expires 1 hour after it was sent. Check your spam folder
            if you don&apos;t see it.
          </Text>
          <ActionButton
            label="Verify token"
            onPress={() => void handleVerifyToken()}
            loading={submitting}
            disabled={!token.trim()}
          />
          <ActionButton
            label="Request a new recovery link"
            onPress={() => {
              setError("");
              setStep("email");
            }}
            variant="secondary"
          />
        </SellerCard>
      ) : null}

      {step === "reset" ? (
        <SellerCard
          title={`Recovering ${verifiedEmail}`}
          description={`Enter your recovery key and choose a new ${credentialLabel}.`}
        >
          <SellerField
            label="Recovery key"
            value={recoveryKey}
            onChangeText={(value) => {
              setRecoveryKey(value);
              if (error) setError("");
            }}
            placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
            autoCapitalize="none"
          />
          <SellerField
            label={authType === "email" ? "New password" : "New passphrase"}
            value={newPassword}
            onChangeText={setNewPassword}
            placeholder={`Enter a new ${credentialLabel}`}
            autoCapitalize="none"
            secureTextEntry
          />
          <SellerField
            label={
              authType === "email"
                ? "Confirm new password"
                : "Confirm new passphrase"
            }
            value={confirmPassword}
            onChangeText={setConfirmPassword}
            placeholder={`Confirm your new ${credentialLabel}`}
            autoCapitalize="none"
            secureTextEntry
          />
          <ActionButton
            label={
              authType === "email"
                ? "Reset password & sign in"
                : "Reset passphrase & sign in"
            }
            onPress={() => void handleResetPassword()}
            loading={submitting}
            disabled={!recoveryKey.trim() || !newPassword || !confirmPassword}
          />
        </SellerCard>
      ) : null}

      {step === "success" ? (
        <SellerCard
          title="Account recovered"
          description={`Your ${credentialLabel} has been reset and you're signed in on this device.`}
        >
          <ActionButton
            label="Go to your seller workspace"
            onPress={() => router.replace("/")}
          />
        </SellerCard>
      ) : null}
    </ScreenScrollView>
  );
}

const styles = StyleSheet.create({
  errorBanner: {
    padding: 12,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: sellerThemeTokens.danger,
    backgroundColor: sellerThemeTokens.subduedSurface,
  },
  errorText: {
    color: sellerThemeTokens.danger,
    fontSize: 14,
    fontWeight: "600",
  },
  helpText: {
    color: sellerThemeTokens.mutedText,
    fontSize: 14,
    lineHeight: 21,
  },
});
