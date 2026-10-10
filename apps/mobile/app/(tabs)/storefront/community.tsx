import { useCallback, useEffect, useState } from "react";
import { Alert, StyleSheet, Text, View } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";

import {
  ActionButton,
  EmptyState,
  ScreenScrollView,
  ScreenTitle,
  SellerCard,
  SellerField,
} from "@/components/seller-ui";
import LoadingScreen from "@/components/loading-screen";
import {
  deleteCommunity,
  getCommunityPasswordGateInfo,
  listSellerCommunities,
  newCommunityDTag,
  saveCommunity,
  validateCommunityPassword,
  type SellerCommunity,
} from "@/lib/communities";
import { getErrorMessage } from "@/lib/error-utils";
import { useSessionStore } from "@/stores/session-store";
import { sellerFonts, sellerThemeTokens } from "@/theme/tokens";

type EditorState = {
  d: string;
  name: string;
  description: string;
  image: string;
  existingId: string | null;
};

const EMPTY_EDITOR: Omit<EditorState, "d"> = {
  name: "",
  description: "",
  image: "",
  existingId: null,
};

export default function CommunityScreen() {
  const session = useSessionStore((state) => state.session);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [communities, setCommunities] = useState<SellerCommunity[]>([]);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [formError, setFormError] = useState("");

  // Listing-password gate for creating NEW communities (mirrors the web
  // settings page; intentional anti-bot friction, not a security boundary).
  const [gateAuthenticated, setGateAuthenticated] = useState(false);
  const [gateStorageKey, setGateStorageKey] = useState<string | null>(null);
  const [gateHint, setGateHint] = useState<string | null>(null);
  const [showPasswordPrompt, setShowPasswordPrompt] = useState(false);
  const [passwordInput, setPasswordInput] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [passwordChecking, setPasswordChecking] = useState(false);

  useEffect(() => {
    void (async () => {
      const info = await getCommunityPasswordGateInfo();
      setGateStorageKey(info.storageKey);
      setGateHint(info.hint);
      if (info.storageKey) {
        try {
          const stored = await AsyncStorage.getItem(info.storageKey);
          if (stored === "true") setGateAuthenticated(true);
        } catch {
          // storage read failure just means we ask again
        }
      }
    })();
  }, []);

  const refresh = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    setLoadError("");
    try {
      setCommunities(await listSellerCommunities(session));
    } catch (caughtError) {
      setLoadError(
        getErrorMessage(caughtError, "Communities could not be loaded.")
      );
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!session) return null;

  const handleCreateNew = () => {
    if (gateAuthenticated) {
      setEditor({ ...EMPTY_EDITOR, d: newCommunityDTag() });
    } else {
      setPasswordInput("");
      setPasswordError("");
      setShowPasswordPrompt(true);
    }
  };

  const handlePasswordSubmit = async () => {
    if (!passwordInput.trim()) {
      setPasswordError("Enter the listing password.");
      return;
    }
    setPasswordChecking(true);
    setPasswordError("");
    try {
      const valid = await validateCommunityPassword(
        passwordInput,
        session.pubkey
      );
      if (valid) {
        setGateAuthenticated(true);
        if (gateStorageKey) {
          try {
            await AsyncStorage.setItem(gateStorageKey, "true");
          } catch {
            // non-fatal: we'll just ask again next session
          }
        }
        setShowPasswordPrompt(false);
        setEditor({ ...EMPTY_EDITOR, d: newCommunityDTag() });
      } else {
        setPasswordError("Incorrect password. Please try again.");
      }
    } catch {
      setPasswordError("An error occurred. Please try again.");
    } finally {
      setPasswordChecking(false);
    }
  };

  const handleSave = async () => {
    if (!editor) return;
    if (!editor.name.trim()) {
      setFormError("Give the community a name.");
      return;
    }
    setSaving(true);
    setFormError("");
    setNotice("");
    try {
      await saveCommunity(session, {
        d: editor.d,
        name: editor.name,
        description: editor.description,
        image: editor.image,
      });
      setNotice(`"${editor.name.trim()}" saved.`);
      setEditor(null);
      await refresh();
    } catch (caughtError) {
      setFormError(
        getErrorMessage(caughtError, "The community could not be saved.")
      );
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = (community: SellerCommunity) => {
    Alert.alert(
      "Delete community",
      `Delete "${community.name}"? This can't be undone.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            void (async () => {
              try {
                await deleteCommunity(session, community.id);
                setNotice(`"${community.name}" deleted.`);
                await refresh();
              } catch (caughtError) {
                Alert.alert(
                  "Delete failed",
                  getErrorMessage(
                    caughtError,
                    "The community could not be deleted."
                  )
                );
              }
            })();
          },
        },
      ]
    );
  };

  if (loading && communities.length === 0) {
    return <LoadingScreen message="Loading communities..." />;
  }

  if (loadError && communities.length === 0) {
    return (
      <ScreenScrollView>
        <SellerCard title="Communities unavailable">
          <Text style={styles.errorText}>{loadError}</Text>
          <ActionButton
            label="Retry"
            onPress={() => void refresh()}
            variant="secondary"
          />
        </SellerCard>
      </ScreenScrollView>
    );
  }

  if (editor) {
    return (
      <ScreenScrollView>
        <ScreenTitle
          eyebrow="Community"
          title={editor.existingId ? "Edit community" : "New community"}
          description="Communities are NIP-72 groups linked to your storefront where buyers can gather."
        />
        <SellerCard title="Details">
          <SellerField
            label="Name"
            value={editor.name}
            onChangeText={(value) =>
              setEditor((current) =>
                current ? { ...current, name: value } : current
              )
            }
            placeholder="Valley CSA Members"
          />
          <SellerField
            label="Description"
            value={editor.description}
            onChangeText={(value) =>
              setEditor((current) =>
                current ? { ...current, description: value } : current
              )
            }
            placeholder="What this community is about..."
            multiline
          />
          <SellerField
            label="Image URL (optional)"
            value={editor.image}
            onChangeText={(value) =>
              setEditor((current) =>
                current ? { ...current, image: value } : current
              )
            }
            placeholder="https://..."
            autoCapitalize="none"
          />
        </SellerCard>
        {formError ? <Text style={styles.errorText}>{formError}</Text> : null}
        <ActionButton
          label="Save community"
          onPress={() => void handleSave()}
          loading={saving}
        />
        <ActionButton
          label="Cancel"
          onPress={() => setEditor(null)}
          variant="secondary"
        />
      </ScreenScrollView>
    );
  }

  return (
    <ScreenScrollView>
      <ScreenTitle
        eyebrow="Marketing"
        title="Communities"
        description="Create and manage the communities attached to your shop."
      />

      {notice ? <Text style={styles.successText}>{notice}</Text> : null}
      {formError ? <Text style={styles.errorText}>{formError}</Text> : null}

      <SellerCard title="Create">
        {showPasswordPrompt ? (
          <>
            {gateHint ? (
              <Text style={styles.helperText}>Hint: {gateHint}</Text>
            ) : null}
            <SellerField
              label="Listing password"
              value={passwordInput}
              onChangeText={setPasswordInput}
              placeholder="Enter the listing password"
              secureTextEntry
              autoCapitalize="none"
              error={passwordError || undefined}
            />
            <ActionButton
              label="Unlock"
              onPress={() => void handlePasswordSubmit()}
              loading={passwordChecking}
            />
            <ActionButton
              label="Cancel"
              onPress={() => setShowPasswordPrompt(false)}
              variant="secondary"
            />
          </>
        ) : (
          <ActionButton label="New community" onPress={handleCreateNew} />
        )}
      </SellerCard>

      <SellerCard
        title="Your communities"
        description={`${communities.length} total`}
      >
        {communities.length === 0 ? (
          <EmptyState
            title="No communities yet"
            description="Create your first community above and it will appear here."
          />
        ) : (
          communities.map((community) => (
            <View key={community.d} style={styles.communityRow}>
              <Text style={styles.communityName}>{community.name}</Text>
              {community.description ? (
                <Text style={styles.communityMeta} numberOfLines={2}>
                  {community.description}
                </Text>
              ) : null}
              <View style={styles.communityActions}>
                <ActionButton
                  label="Edit"
                  onPress={() =>
                    setEditor({
                      d: community.d,
                      name: community.name,
                      description: community.description,
                      image: community.image,
                      existingId: community.id,
                    })
                  }
                  variant="secondary"
                />
                <ActionButton
                  label="Delete"
                  onPress={() => handleDelete(community)}
                  variant="secondary"
                />
              </View>
            </View>
          ))
        )}
      </SellerCard>
    </ScreenScrollView>
  );
}

const styles = StyleSheet.create({
  helperText: {
    color: sellerThemeTokens.mutedText,
    fontSize: 14,
    fontFamily: sellerFonts.regular,
    lineHeight: 21,
  },
  errorText: {
    color: sellerThemeTokens.danger,
    fontSize: 14,
    fontFamily: sellerFonts.regular,
    lineHeight: 20,
  },
  successText: {
    color: sellerThemeTokens.success,
    fontSize: 14,
    fontFamily: sellerFonts.regular,
    lineHeight: 20,
  },
  communityRow: {
    gap: 8,
    padding: 14,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: sellerThemeTokens.black,
    backgroundColor: sellerThemeTokens.surface,
  },
  communityName: {
    color: sellerThemeTokens.text,
    fontSize: 17,
    fontFamily: sellerFonts.bold,
  },
  communityMeta: {
    color: sellerThemeTokens.mutedText,
    fontSize: 13,
    fontFamily: sellerFonts.regular,
    lineHeight: 19,
  },
  communityActions: {
    gap: 8,
  },
});
