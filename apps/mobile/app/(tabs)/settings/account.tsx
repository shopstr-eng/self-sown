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
import { getErrorMessage } from "@/lib/error-utils";
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
        <Text style={styles.helperText}>
          Email-based recovery setup is available in the web app settings.
        </Text>
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
  successText: {
    color: sellerThemeTokens.success,
    fontSize: 14,
    lineHeight: 20,
  },
});
