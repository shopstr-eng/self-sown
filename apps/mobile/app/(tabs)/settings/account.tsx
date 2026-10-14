import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import { encodeSellerNpub } from "@self-sown/nostr";

import {
  ActionButton,
  ScreenScrollView,
  ScreenTitle,
  SellerCard,
  SellerField,
  StatusPill,
} from "@/components/seller-ui";
import LoadingScreen from "@/components/loading-screen";
import {
  loadAccountPreferences,
  moveMintToFront,
  publishBlossomServers,
  publishMints,
  publishRelayLists,
  validateBlossomServerUrl,
  validateMintUrl,
  validateRelayUrl,
  verifyBlossomServerReachable,
  verifyMintReachable,
  type RelayLists,
} from "@/lib/account-settings";
import {
  checkRecoveryStatus,
  confirmRecoverySetup,
  maskRecoveryEmail,
  sendRecoveryVerificationCode,
  validateRecoveryEmail,
} from "@/lib/account-recovery";
import { getErrorMessage } from "@/lib/error-utils";
import {
  clearNwcConnection,
  fetchNwcWalletSnapshot,
  loadNwcConnection,
  parseNwcConnectionString,
  saveNwcConnection,
  validateNwcConnectionString,
  type NwcWalletInfo,
} from "@/lib/nwc";
import { useSessionStore } from "@/stores/session-store";
import { sellerThemeTokens } from "@/theme/tokens";

type RelayListKey = keyof RelayLists;

const RELAY_SECTIONS: ReadonlyArray<{
  key: RelayListKey;
  title: string;
  emptyText: string;
}> = [
  { key: "all", title: "Read/Write Relays", emptyText: "No relays added..." },
  { key: "read", title: "Read Only Relays", emptyText: "No relays added..." },
  { key: "write", title: "Write Only Relays", emptyText: "No relays added..." },
];

export default function AccountSettingsScreen() {
  const session = useSessionStore((state) => state.session);
  const saveSession = useSessionStore((state) => state.saveSession);

  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState("");

  const [nsecVisible, setNsecVisible] = useState(false);

  const [recoveryStatusError, setRecoveryStatusError] = useState("");
  const [hasRecovery, setHasRecovery] = useState(false);
  const [maskedRecoveryEmail, setMaskedRecoveryEmail] = useState("");
  const [showRecoverySetup, setShowRecoverySetup] = useState(false);
  const [recoveryEmail, setRecoveryEmail] = useState("");
  const [verificationCode, setVerificationCode] = useState("");
  const [verificationSent, setVerificationSent] = useState(false);
  const [recoveryError, setRecoveryError] = useState("");
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [generatedRecoveryKey, setGeneratedRecoveryKey] = useState("");

  const [mints, setMints] = useState<string[]>([]);
  const [mintInput, setMintInput] = useState("");
  const [mintError, setMintError] = useState("");
  const [mintBusy, setMintBusy] = useState(false);

  const [relayLists, setRelayLists] = useState<RelayLists>({
    all: [],
    read: [],
    write: [],
  });
  const [relayInputs, setRelayInputs] = useState<Record<RelayListKey, string>>({
    all: "",
    read: "",
    write: "",
  });
  const [relayErrors, setRelayErrors] = useState<
    Partial<Record<RelayListKey, string>>
  >({});
  const [relaysAreChanged, setRelaysAreChanged] = useState(false);
  const [relayPublishError, setRelayPublishError] = useState("");
  const [relayPublishMessage, setRelayPublishMessage] = useState("");
  const [relayBusy, setRelayBusy] = useState(false);

  const [nwcInput, setNwcInput] = useState("");
  const [nwcInfo, setNwcInfo] = useState<NwcWalletInfo | null>(null);
  const [nwcBalanceSats, setNwcBalanceSats] = useState<number | null>(null);
  const [nwcError, setNwcError] = useState("");
  const [nwcSaved, setNwcSaved] = useState(false);
  const [nwcBusy, setNwcBusy] = useState(false);

  const [blossomServers, setBlossomServers] = useState<string[]>([]);
  const [blossomInput, setBlossomInput] = useState("");
  const [blossomError, setBlossomError] = useState("");
  const [blossomPublishError, setBlossomPublishError] = useState("");
  const [blossomPublishMessage, setBlossomPublishMessage] = useState("");
  const [blossomsAreChanged, setBlossomsAreChanged] = useState(false);
  const [blossomBusy, setBlossomBusy] = useState(false);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    // Recovery status load is independent of preferences: a failure here
    // must not block the rest of the screen (and vice versa).
    checkRecoveryStatus(session)
      .then((status) => {
        if (cancelled) return;
        setHasRecovery(status.hasRecovery);
        setMaskedRecoveryEmail(status.maskedEmail ?? "");
      })
      .catch((caughtError) => {
        if (cancelled) return;
        setRecoveryStatusError(
          getErrorMessage(caughtError, "Recovery status could not be loaded.")
        );
      });
    // The saved wallet connection is local-only; a reload failure must not
    // block the rest of the screen either.
    loadNwcConnection(session.pubkey)
      .then((saved) => {
        if (cancelled || !saved) return;
        setNwcInput(saved.connectionString);
        setNwcInfo(saved.info);
        if (saved.info) {
          setNwcSaved(true);
          if (saved.info.methods.includes("get_balance")) {
            // Refresh the balance live; a dead wallet just shows no balance.
            fetchNwcWalletSnapshot(
              parseNwcConnectionString(saved.connectionString)
            )
              .then((snapshot) => {
                if (!cancelled) setNwcBalanceSats(snapshot.balanceSats);
              })
              .catch(() => {});
          }
        }
      })
      .catch(() => {});
    loadAccountPreferences(session)
      .then((preferences) => {
        if (cancelled) return;
        setMints(preferences.mints);
        setRelayLists({
          all: session.relays,
          read: preferences.readRelays,
          write: preferences.writeRelays,
        });
        setBlossomServers(preferences.blossomServers);
        setLoaded(true);
      })
      .catch((caughtError) => {
        if (cancelled) return;
        setLoadError(
          getErrorMessage(
            caughtError,
            "Account preferences could not be loaded."
          )
        );
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [session]);

  if (!session) {
    return null;
  }

  if (!loaded) {
    return <LoadingScreen message="Loading account settings..." />;
  }

  const resetRecoveryForm = () => {
    setShowRecoverySetup(false);
    setRecoveryEmail("");
    setVerificationCode("");
    setVerificationSent(false);
    setRecoveryError("");
  };

  const handleSendRecoveryCode = async () => {
    const email = recoveryEmail.trim();
    const validationError = validateRecoveryEmail(email);
    if (validationError) {
      setRecoveryError(validationError);
      return;
    }
    setRecoveryBusy(true);
    setRecoveryError("");
    try {
      await sendRecoveryVerificationCode(session, email);
      setVerificationSent(true);
    } catch (caughtError) {
      setRecoveryError(
        getErrorMessage(caughtError, "Failed to send verification.")
      );
    } finally {
      setRecoveryBusy(false);
    }
  };

  const handleConfirmRecovery = async () => {
    const email = recoveryEmail.trim();
    const code = verificationCode.trim();
    if (!code) {
      setRecoveryError("Please enter the verification code.");
      return;
    }
    setRecoveryBusy(true);
    setRecoveryError("");
    try {
      const { recoveryKey } = await confirmRecoverySetup(session, email, code);
      // The key is shown exactly once — surface it before resetting anything.
      setGeneratedRecoveryKey(recoveryKey);
      setHasRecovery(true);
      setMaskedRecoveryEmail(maskRecoveryEmail(email));
      resetRecoveryForm();
    } catch (caughtError) {
      setRecoveryError(
        getErrorMessage(caughtError, "Failed to set up recovery.")
      );
    } finally {
      setRecoveryBusy(false);
    }
  };

  const handleAddMint = async () => {
    const trimmed = mintInput.trim();
    const validationError = validateMintUrl(trimmed);
    if (validationError) {
      setMintError(validationError);
      return;
    }
    setMintBusy(true);
    setMintError("");
    try {
      await verifyMintReachable(trimmed);
      const next = moveMintToFront(mints, trimmed);
      await publishMints(session, next);
      setMints(next);
      setMintInput("");
    } catch (caughtError) {
      setMintError(getErrorMessage(caughtError, "Failed to add mint."));
    } finally {
      setMintBusy(false);
    }
  };

  const handleDeleteMint = async (mint: string) => {
    setMintBusy(true);
    setMintError("");
    try {
      const next = mints.filter((existing) => existing !== mint);
      await publishMints(session, next);
      setMints(next);
    } catch (caughtError) {
      setMintError(getErrorMessage(caughtError, "Failed to remove mint."));
    } finally {
      setMintBusy(false);
    }
  };

  const handleAddRelay = (type: RelayListKey) => {
    const trimmed = relayInputs[type].trim();
    const validationError = validateRelayUrl(trimmed);
    if (validationError) {
      setRelayErrors((current) => ({ ...current, [type]: validationError }));
      return;
    }
    setRelayErrors((current) => ({ ...current, [type]: undefined }));
    setRelayLists((current) =>
      current[type].includes(trimmed)
        ? current
        : { ...current, [type]: [...current[type], trimmed] }
    );
    setRelayInputs((current) => ({ ...current, [type]: "" }));
    setRelaysAreChanged(true);
    setRelayPublishMessage("");
    setRelayPublishError("");
  };

  const handleDeleteRelay = (type: RelayListKey, relay: string) => {
    setRelayLists((current) => ({
      ...current,
      [type]: current[type].filter((existing) => existing !== relay),
    }));
    setRelaysAreChanged(true);
    setRelayPublishMessage("");
    setRelayPublishError("");
  };

  const handlePublishRelays = async () => {
    setRelayBusy(true);
    setRelayPublishError("");
    setRelayPublishMessage("");
    try {
      await publishRelayLists(session, relayLists);
      // Relay edits drive where future publishes go, so keep the signed-in
      // session in sync. Publish targets = shared relays plus write-only
      // relays (never read-only); with no write-only list this equals the
      // shared list, matching the fresh sign-in convention.
      const nextWriteRelays = Array.from(
        new Set([...relayLists.all, ...relayLists.write])
      );
      await saveSession({
        ...session,
        relays: relayLists.all,
        writeRelays: nextWriteRelays,
      });
      setRelaysAreChanged(false);
      setRelayPublishMessage("Relay list published.");
    } catch (caughtError) {
      setRelayPublishError(
        getErrorMessage(caughtError, "Relay list could not be published.")
      );
    } finally {
      setRelayBusy(false);
    }
  };

  const handleSaveNwc = async () => {
    const trimmed = nwcInput.trim();
    const validationError = validateNwcConnectionString(trimmed);
    if (validationError) {
      setNwcError(validationError);
      return;
    }
    setNwcBusy(true);
    setNwcError("");
    setNwcSaved(false);
    setNwcInfo(null);
    setNwcBalanceSats(null);
    try {
      // Connect before persisting so a typo'd or dead connection string never
      // becomes the saved one (web handleSave parity).
      const snapshot = await fetchNwcWalletSnapshot(
        parseNwcConnectionString(trimmed)
      );
      await saveNwcConnection(session.pubkey, trimmed, snapshot.info);
      setNwcInput(trimmed);
      setNwcInfo(snapshot.info);
      setNwcBalanceSats(snapshot.balanceSats);
      setNwcSaved(true);
    } catch (caughtError) {
      setNwcError(
        `Failed to connect: ${getErrorMessage(
          caughtError,
          "Please check the connection string and wallet permissions."
        )}`
      );
      await clearNwcConnection(session.pubkey).catch(() => {});
    } finally {
      setNwcBusy(false);
    }
  };

  const handleRemoveNwc = async () => {
    setNwcInput("");
    setNwcInfo(null);
    setNwcBalanceSats(null);
    setNwcError("");
    setNwcSaved(false);
    await clearNwcConnection(session.pubkey).catch(() => {});
  };

  const handleAddBlossomServer = async () => {
    const trimmed = blossomInput.trim();
    const validationError = validateBlossomServerUrl(trimmed);
    if (validationError) {
      setBlossomError(validationError);
      return;
    }
    setBlossomBusy(true);
    setBlossomError("");
    try {
      await verifyBlossomServerReachable(trimmed);
      setBlossomServers((current) => [
        trimmed,
        ...current.filter((existing) => existing !== trimmed),
      ]);
      setBlossomInput("");
      setBlossomsAreChanged(true);
      setBlossomPublishMessage("");
      setBlossomPublishError("");
    } catch (caughtError) {
      setBlossomError(
        getErrorMessage(caughtError, "Failed to add Blossom server.")
      );
    } finally {
      setBlossomBusy(false);
    }
  };

  const handleDeleteBlossomServer = (server: string) => {
    setBlossomServers((current) =>
      current.filter((existing) => existing !== server)
    );
    setBlossomsAreChanged(true);
    setBlossomPublishMessage("");
    setBlossomPublishError("");
  };

  const handlePublishBlossomServers = async () => {
    setBlossomBusy(true);
    setBlossomPublishError("");
    setBlossomPublishMessage("");
    try {
      await publishBlossomServers(session, blossomServers);
      setBlossomsAreChanged(false);
      setBlossomPublishMessage("Blossom server list published.");
    } catch (caughtError) {
      setBlossomPublishError(
        getErrorMessage(
          caughtError,
          "Blossom server list could not be published."
        )
      );
    } finally {
      setBlossomBusy(false);
    }
  };

  return (
    <ScreenScrollView>
      <ScreenTitle
        eyebrow="Account"
        title="Account settings & preferences"
        description="Back up your account, manage your payment settings, and configure your data storage."
      />

      {loadError ? <Text style={styles.errorText}>{loadError}</Text> : null}

      <SellerCard
        title="Key backup"
        description="Your keys are your account. Store the secret key somewhere safe; anyone with it controls your account."
      >
        <View style={styles.metaBlock}>
          <Text style={styles.metaLabel}>Public key (npub)</Text>
          <Text selectable style={styles.metaValue}>
            {encodeSellerNpub(session.pubkey)}
          </Text>
        </View>
        {nsecVisible ? (
          <View style={styles.metaBlock}>
            <Text style={styles.metaLabel}>Secret key (nsec)</Text>
            <Text selectable style={styles.metaValue}>
              {session.nsec}
            </Text>
          </View>
        ) : null}
        <ActionButton
          label={nsecVisible ? "Hide secret key" : "Reveal secret key"}
          onPress={() => setNsecVisible((current) => !current)}
          variant="secondary"
        />
      </SellerCard>

      <SellerCard
        title="Account recovery"
        description="Set up email-based recovery so you can get back into your account if you lose this device or forget your passphrase."
      >
        {recoveryStatusError ? (
          <>
            <Text style={styles.errorText}>{recoveryStatusError}</Text>
            <ActionButton
              label="Retry"
              onPress={() => {
                setRecoveryStatusError("");
                checkRecoveryStatus(session)
                  .then((status) => {
                    setHasRecovery(status.hasRecovery);
                    setMaskedRecoveryEmail(status.maskedEmail ?? "");
                  })
                  .catch((caughtError) => {
                    setRecoveryStatusError(
                      getErrorMessage(
                        caughtError,
                        "Recovery status could not be loaded."
                      )
                    );
                  });
              }}
              variant="secondary"
            />
          </>
        ) : null}

        {!recoveryStatusError && hasRecovery && !showRecoverySetup ? (
          <>
            <Text style={styles.helperText}>
              Recovery is set up for {maskedRecoveryEmail}. If you forget your
              passphrase, you can recover your account using your recovery key
              and email verification.
            </Text>
            <ActionButton
              label="Generate new recovery key"
              onPress={() => {
                resetRecoveryForm();
                setShowRecoverySetup(true);
              }}
              variant="secondary"
            />
          </>
        ) : null}

        {!recoveryStatusError && !hasRecovery && !showRecoverySetup ? (
          <ActionButton
            label="Set up recovery"
            onPress={() => {
              resetRecoveryForm();
              setShowRecoverySetup(true);
            }}
          />
        ) : null}

        {showRecoverySetup ? (
          <>
            <Text style={styles.helperText}>
              {hasRecovery
                ? "Enter your recovery email to verify ownership, then a new recovery key will be generated."
                : "Enter the email address you'd like to use for recovery. We'll send a verification code to confirm you own it."}
            </Text>
            <SellerField
              label="Recovery email"
              value={recoveryEmail}
              onChangeText={(value) => {
                setRecoveryEmail(value);
                setRecoveryError("");
              }}
              placeholder="you@example.com"
              keyboardType="email-address"
              autoCapitalize="none"
              editable={!verificationSent && !recoveryBusy}
            />
            {verificationSent ? (
              <SellerField
                label="Verification code"
                value={verificationCode}
                onChangeText={(value) => {
                  setVerificationCode(value);
                  setRecoveryError("");
                }}
                placeholder="Enter 6-digit code"
                keyboardType="number-pad"
                autoCapitalize="none"
                editable={!recoveryBusy}
              />
            ) : null}
            {recoveryError ? (
              <Text style={styles.errorText}>{recoveryError}</Text>
            ) : null}
            <ActionButton
              label={
                verificationSent
                  ? hasRecovery
                    ? "Verify & generate key"
                    : "Verify & set up recovery"
                  : "Send verification code"
              }
              onPress={() =>
                void (verificationSent
                  ? handleConfirmRecovery()
                  : handleSendRecoveryCode())
              }
              loading={recoveryBusy}
              disabled={recoveryBusy}
            />
            <ActionButton
              label="Cancel"
              onPress={resetRecoveryForm}
              variant="secondary"
              disabled={recoveryBusy}
            />
            {hasRecovery ? (
              <Text style={styles.warningText}>
                Generating a new key will invalidate your previous recovery key.
              </Text>
            ) : null}
          </>
        ) : null}

        {generatedRecoveryKey ? (
          <View style={styles.recoveryKeyBlock}>
            <Text style={styles.recoveryKeyTitle}>Save your recovery key</Text>
            <Text style={styles.helperText}>
              This key is the only way to recover your account if you forget
              your passphrase. Save it somewhere safe — it will not be shown
              again.
            </Text>
            <Text selectable style={styles.recoveryKeyValue}>
              {generatedRecoveryKey}
            </Text>
            <ActionButton
              label="I've saved my recovery key"
              onPress={() => setGeneratedRecoveryKey("")}
            />
          </View>
        ) : null}
      </SellerCard>

      <SellerCard
        title="Mint"
        description="This mint is used to handle Cashu tokens within your wallet and to send to the seller upon purchase."
      >
        {mints.length === 0 ? (
          <Text style={styles.helperText}>No mint added...</Text>
        ) : (
          mints.map((mint, index) => (
            <View key={mint} style={styles.listRow}>
              <View style={styles.listRowText}>
                <Text style={styles.listRowValue}>{mint}</Text>
                {index === 0 ? (
                  <Text style={styles.listRowHint}>Active Mint</Text>
                ) : null}
              </View>
              {mints.length > 1 ? (
                <ActionButton
                  label="Remove"
                  onPress={() => void handleDeleteMint(mint)}
                  variant="secondary"
                  disabled={mintBusy}
                />
              ) : null}
            </View>
          ))
        )}
        <SellerField
          label="New mint URL"
          value={mintInput}
          onChangeText={(value) => {
            setMintInput(value);
            setMintError("");
          }}
          placeholder="https://..."
          autoCapitalize="none"
          error={mintError}
        />
        <ActionButton
          label="Change active mint"
          onPress={() => void handleAddMint()}
          loading={mintBusy}
          disabled={mintBusy}
        />
      </SellerCard>

      <SellerCard
        title="Nostr Wallet Connect"
        description="Connect your wallet using a Nostr Wallet Connect (NIP-47) connection string (e.g., from Alby, Mutiny, or Umbrel). This allows Self-sown to request payments directly from your wallet."
      >
        <SellerField
          label="Connection string"
          value={nwcInput}
          onChangeText={(value) => {
            setNwcInput(value);
            setNwcError("");
            // Editing after saving reverts the button to "Save connection"
            // until the user saves again (web parity).
            if (nwcSaved) setNwcSaved(false);
          }}
          placeholder="nostr+walletconnect://..."
          autoCapitalize="none"
          error={nwcError}
          editable={!nwcBusy}
        />
        {nwcSaved && !nwcError ? (
          <Text style={styles.successText}>Wallet connected successfully!</Text>
        ) : null}
        <ActionButton
          label={
            nwcBusy ? "Connecting..." : nwcSaved ? "Saved!" : "Save connection"
          }
          onPress={() => void handleSaveNwc()}
          loading={nwcBusy}
          disabled={nwcBusy}
        />
        {nwcInfo ? (
          <>
            <View style={styles.metaBlock}>
              <Text style={styles.metaLabel}>Connected wallet</Text>
              <Text style={styles.metaValue}>
                {typeof nwcInfo.alias === "string" && nwcInfo.alias
                  ? nwcInfo.alias
                  : "Unknown"}
              </Text>
            </View>
            {nwcBalanceSats !== null ? (
              <Text style={styles.metaValue}>
                Balance: {Math.round(nwcBalanceSats).toLocaleString()} sats
              </Text>
            ) : nwcInfo.methods.includes("get_balance") ? (
              <Text style={styles.helperText}>Balance: loading...</Text>
            ) : (
              <Text style={styles.helperText}>Balance: Not available</Text>
            )}
            {nwcInfo.methods.length > 0 ? (
              <Text style={styles.helperText}>
                Supports: {nwcInfo.methods.join(", ")}
              </Text>
            ) : null}
            <ActionButton
              label="Disconnect wallet"
              onPress={() => void handleRemoveNwc()}
              variant="secondary"
              disabled={nwcBusy}
            />
          </>
        ) : null}
      </SellerCard>

      {RELAY_SECTIONS.map((section) => (
        <SellerCard key={section.key} title={section.title}>
          {relayLists[section.key].length === 0 ? (
            <Text style={styles.helperText}>{section.emptyText}</Text>
          ) : (
            relayLists[section.key].map((relay) => (
              <View key={relay} style={styles.listRow}>
                <View style={styles.listRowText}>
                  <Text style={styles.listRowValue}>{relay}</Text>
                </View>
                {relayLists[section.key].length > 1 ? (
                  <ActionButton
                    label="Remove"
                    onPress={() => handleDeleteRelay(section.key, relay)}
                    variant="secondary"
                  />
                ) : null}
              </View>
            ))
          )}
          <SellerField
            label="New relay URL"
            value={relayInputs[section.key]}
            onChangeText={(value) => {
              setRelayInputs((current) => ({
                ...current,
                [section.key]: value,
              }));
              setRelayErrors((current) => ({
                ...current,
                [section.key]: undefined,
              }));
            }}
            placeholder="wss://..."
            autoCapitalize="none"
            error={relayErrors[section.key]}
          />
          <ActionButton
            label="Add relay"
            onPress={() => handleAddRelay(section.key)}
            variant="secondary"
          />
        </SellerCard>
      ))}

      <SellerCard title="Relay publishing">
        {relayPublishError ? (
          <Text style={styles.errorText}>{relayPublishError}</Text>
        ) : null}
        {relayPublishMessage ? (
          <Text style={styles.successText}>{relayPublishMessage}</Text>
        ) : null}
        {relaysAreChanged ? (
          <ActionButton
            label="Save & publish relays"
            onPress={() => void handlePublishRelays()}
            loading={relayBusy}
          />
        ) : (
          <Text style={styles.helperText}>
            Relay changes are published to Nostr (NIP-65) so your other apps
            pick them up.
          </Text>
        )}
      </SellerCard>

      <SellerCard
        title="Blossom media servers"
        description="Servers used to store listing and profile media. The first entry is the primary server."
      >
        {blossomServers.length === 0 ? (
          <Text style={styles.helperText}>No servers added...</Text>
        ) : (
          blossomServers.map((server, index) => (
            <View key={server} style={styles.listRow}>
              <View style={styles.listRowText}>
                <Text style={styles.listRowValue}>{server}</Text>
                {index === 0 ? (
                  <Text style={styles.listRowHint}>Primary Server</Text>
                ) : null}
              </View>
              {blossomServers.length > 1 ? (
                <ActionButton
                  label="Remove"
                  onPress={() => handleDeleteBlossomServer(server)}
                  variant="secondary"
                />
              ) : null}
            </View>
          ))
        )}
        <SellerField
          label="New server URL"
          value={blossomInput}
          onChangeText={(value) => {
            setBlossomInput(value);
            setBlossomError("");
          }}
          placeholder="https://..."
          autoCapitalize="none"
          error={blossomError}
        />
        <ActionButton
          label="Add server"
          onPress={() => void handleAddBlossomServer()}
          variant="secondary"
          loading={blossomBusy}
          disabled={blossomBusy}
        />
        {blossomPublishError ? (
          <Text style={styles.errorText}>{blossomPublishError}</Text>
        ) : null}
        {blossomPublishMessage ? (
          <Text style={styles.successText}>{blossomPublishMessage}</Text>
        ) : null}
        {blossomsAreChanged ? (
          <ActionButton
            label="Save & publish servers"
            onPress={() => void handlePublishBlossomServers()}
            loading={blossomBusy}
          />
        ) : null}
      </SellerCard>

      <SellerCard title="Session">
        <View style={styles.rowBetween}>
          <Text style={styles.metaLabel}>Signed in as</Text>
          <StatusPill tone="success" label={session.authMethod} />
        </View>
      </SellerCard>
    </ScreenScrollView>
  );
}

const styles = StyleSheet.create({
  metaBlock: {
    gap: 4,
  },
  metaLabel: {
    color: sellerThemeTokens.mutedText,
    fontSize: 13,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  metaValue: {
    color: sellerThemeTokens.text,
    fontSize: 14,
    lineHeight: 20,
  },
  listRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
    borderWidth: 2,
    borderColor: sellerThemeTokens.border,
    borderRadius: 6,
    backgroundColor: sellerThemeTokens.surface,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  listRowText: {
    flex: 1,
    gap: 2,
  },
  listRowValue: {
    color: sellerThemeTokens.text,
    fontSize: 14,
  },
  listRowHint: {
    color: sellerThemeTokens.mutedText,
    fontSize: 12,
  },
  rowBetween: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  helperText: {
    color: sellerThemeTokens.mutedText,
    fontSize: 14,
    lineHeight: 21,
  },
  errorText: {
    color: sellerThemeTokens.danger,
    fontSize: 14,
    lineHeight: 20,
  },
  warningText: {
    color: sellerThemeTokens.warning,
    fontSize: 13,
    lineHeight: 19,
  },
  recoveryKeyBlock: {
    gap: 10,
    borderWidth: 2,
    borderColor: sellerThemeTokens.border,
    borderRadius: 6,
    backgroundColor: sellerThemeTokens.surface,
    padding: 12,
  },
  recoveryKeyTitle: {
    color: sellerThemeTokens.text,
    fontSize: 15,
    fontWeight: "700",
  },
  recoveryKeyValue: {
    color: sellerThemeTokens.text,
    fontFamily: "monospace",
    fontSize: 15,
    fontWeight: "700",
    letterSpacing: 1,
    textAlign: "center",
    paddingVertical: 8,
  },
  successText: {
    color: sellerThemeTokens.success,
    fontSize: 14,
    lineHeight: 20,
  },
});
