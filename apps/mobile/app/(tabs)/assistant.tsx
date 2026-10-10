import { useCallback, useEffect, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import {
  ActionButton,
  EmptyState,
  SellerCard,
  StatusPill,
} from "@/components/seller-ui";
import LoadingScreen from "@/components/loading-screen";
import {
  enableAssistantWrites,
  getAssistantWritesEnabled,
  getMembershipStatus,
  isMembershipEntitled,
  sendAssistantChat,
  type AssistantAction,
  type AssistantChatMessage,
} from "@/lib/assistant";
import { getApiBaseUrl } from "@/lib/api-base-url";
import { getErrorMessage } from "@/lib/error-utils";
import { useSessionStore } from "@/stores/session-store";
import { neoShadow, sellerFonts, sellerThemeTokens } from "@/theme/tokens";

type ChatEntry = AssistantChatMessage & { actions?: AssistantAction[] };

export default function AssistantScreen() {
  const session = useSessionStore((state) => state.session);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [entitled, setEntitled] = useState(false);
  const [writesEnabled, setWritesEnabled] = useState<boolean | null>(null);
  const [enabling, setEnabling] = useState(false);
  const [enableError, setEnableError] = useState("");

  const [messages, setMessages] = useState<ChatEntry[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<ScrollView>(null);

  const bootstrap = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    setLoadError("");
    try {
      const membership = await getMembershipStatus(session.pubkey);
      const isEntitled = isMembershipEntitled(membership.status);
      setEntitled(isEntitled);
      if (isEntitled) {
        setWritesEnabled(await getAssistantWritesEnabled(session));
      }
    } catch (caughtError) {
      setLoadError(
        getErrorMessage(caughtError, "The assistant could not be loaded.")
      );
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  if (!session) return null;

  const handleEnableWrites = async () => {
    if (enabling) return;
    setEnabling(true);
    setEnableError("");
    try {
      await enableAssistantWrites(session);
      setWritesEnabled(true);
    } catch (caughtError) {
      setEnableError(
        getErrorMessage(caughtError, "Write actions could not be enabled.")
      );
    } finally {
      setEnabling(false);
    }
  };

  const handleSend = async () => {
    const text = input.trim();
    if (!text || sending) return;
    const nextMessages: ChatEntry[] = [
      ...messages,
      { role: "user", content: text },
    ];
    setMessages(nextMessages);
    setInput("");
    setSending(true);
    try {
      const result = await sendAssistantChat(
        session,
        nextMessages.map(({ role, content }) => ({ role, content }))
      );
      setWritesEnabled(result.writesEnabled);
      setMessages([
        ...nextMessages,
        { role: "assistant", content: result.reply, actions: result.actions },
      ]);
    } catch (caughtError) {
      setMessages([
        ...nextMessages,
        {
          role: "assistant",
          content: getErrorMessage(
            caughtError,
            "The assistant request failed."
          ),
        },
      ]);
    } finally {
      setSending(false);
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
    }
  };

  if (loading) {
    return <LoadingScreen message="Loading the assistant..." />;
  }

  if (loadError) {
    return (
      <View style={styles.centered}>
        <SellerCard title="Assistant unavailable">
          <Text style={styles.errorText}>{loadError}</Text>
          <ActionButton
            label="Retry"
            onPress={() => void bootstrap()}
            variant="secondary"
          />
        </SellerCard>
      </View>
    );
  }

  if (!entitled) {
    return (
      <View style={styles.centered}>
        <SellerCard
          title="The AI assistant is a Herd feature"
          description="Chat with your stall to answer questions about orders, listings, stock, discounts, and analytics — and let it make changes for you on the spot."
        >
          <ActionButton
            label="View membership options"
            onPress={() => void Linking.openURL(`${getApiBaseUrl()}/pro`)}
          />
        </SellerCard>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.screen}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      {writesEnabled === false ? (
        <View style={styles.enableCard}>
          <Text style={styles.enableTitle}>Enable write actions</Text>
          <Text style={styles.enableBody}>
            Right now the assistant is read-only. One tap enables changes —
            updating listings, stock, discounts, and orders — using the key
            already stored in this app. Moving money, deleting listings or
            discount codes, and messaging buyers always stay manual.
          </Text>
          {enableError ? (
            <Text style={styles.errorText}>{enableError}</Text>
          ) : null}
          <ActionButton
            label="Enable writes"
            onPress={() => void handleEnableWrites()}
            loading={enabling}
          />
        </View>
      ) : null}

      <ScrollView
        ref={scrollRef}
        style={styles.messageList}
        contentContainerStyle={styles.messageListContent}
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={() =>
          scrollRef.current?.scrollToEnd({ animated: false })
        }
      >
        {writesEnabled === true ? (
          <StatusPill tone="success" label="Write actions enabled" />
        ) : null}
        {messages.length === 0 ? (
          <EmptyState
            title="Chat with your stall"
            description="Ask about orders, listings, stock, discounts, or analytics — the assistant works through the same tools external AI agents use."
          />
        ) : (
          messages.map((message, index) => (
            <View
              key={index}
              style={[
                styles.bubble,
                message.role === "user"
                  ? styles.bubbleUser
                  : styles.bubbleAssistant,
              ]}
            >
              <Text
                style={
                  message.role === "user"
                    ? styles.bubbleTextUser
                    : styles.bubbleTextAssistant
                }
              >
                {message.content}
              </Text>
              {message.actions?.map((action, actionIndex) => (
                <View key={actionIndex} style={styles.actionRow}>
                  <Text style={styles.actionText}>
                    {action.ok ? "✓" : "✕"} {action.detail || action.tool}
                  </Text>
                  {action.label?.trackingUrl ? (
                    <Pressable
                      accessibilityRole="link"
                      onPress={() => {
                        const url = action.label?.trackingUrl;
                        if (url && /^https?:\/\//.test(url)) {
                          void Linking.openURL(url);
                        }
                      }}
                    >
                      <Text style={styles.actionLink}>
                        Track {action.label?.trackingCode ?? "shipment"}
                      </Text>
                    </Pressable>
                  ) : null}
                </View>
              ))}
            </View>
          ))
        )}
        {sending ? (
          <Text style={styles.thinkingText}>Assistant is thinking…</Text>
        ) : null}
      </ScrollView>

      <View style={styles.inputRow}>
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder="Ask about your stall..."
          placeholderTextColor={sellerThemeTokens.mutedText}
          multiline
          editable={!sending}
          accessibilityLabel="Message the assistant"
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send message"
          accessibilityState={{ disabled: sending || !input.trim() }}
          disabled={sending || !input.trim()}
          onPress={() => void handleSend()}
          style={({ pressed }) => [
            styles.sendButton,
            (sending || !input.trim()) && styles.sendButtonDisabled,
            pressed && !(sending || !input.trim()) && styles.sendButtonPressed,
          ]}
        >
          <Text style={styles.sendButtonLabel}>Send</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: sellerThemeTokens.background,
  },
  centered: {
    flex: 1,
    backgroundColor: sellerThemeTokens.background,
    justifyContent: "center",
    padding: 20,
  },
  enableCard: {
    margin: 16,
    marginBottom: 0,
    gap: 10,
    padding: 16,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: sellerThemeTokens.black,
    backgroundColor: sellerThemeTokens.subduedSurface,
    ...neoShadow,
  },
  enableTitle: {
    color: sellerThemeTokens.text,
    fontSize: 17,
    fontFamily: sellerFonts.bold,
  },
  enableBody: {
    color: sellerThemeTokens.mutedText,
    fontSize: 14,
    fontFamily: sellerFonts.regular,
    lineHeight: 21,
  },
  messageList: {
    flex: 1,
  },
  messageListContent: {
    padding: 16,
    gap: 10,
  },
  bubble: {
    maxWidth: "88%",
    padding: 12,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: sellerThemeTokens.black,
    gap: 6,
  },
  bubbleUser: {
    alignSelf: "flex-end",
    backgroundColor: sellerThemeTokens.primary,
  },
  bubbleAssistant: {
    alignSelf: "flex-start",
    backgroundColor: sellerThemeTokens.surface,
    ...neoShadow,
  },
  bubbleTextUser: {
    color: sellerThemeTokens.surface,
    fontSize: 15,
    fontFamily: sellerFonts.regular,
    lineHeight: 22,
  },
  bubbleTextAssistant: {
    color: sellerThemeTokens.text,
    fontSize: 15,
    fontFamily: sellerFonts.regular,
    lineHeight: 22,
  },
  actionRow: {
    borderTopWidth: 1,
    borderTopColor: sellerThemeTokens.black,
    paddingTop: 6,
    gap: 4,
  },
  actionText: {
    color: sellerThemeTokens.mutedText,
    fontSize: 13,
    fontFamily: sellerFonts.regular,
  },
  actionLink: {
    color: sellerThemeTokens.primary,
    fontSize: 13,
    fontFamily: sellerFonts.bold,
    textDecorationLine: "underline",
  },
  thinkingText: {
    color: sellerThemeTokens.mutedText,
    fontSize: 13,
    fontFamily: sellerFonts.regular,
    fontStyle: "italic",
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    padding: 12,
    borderTopWidth: 2,
    borderTopColor: sellerThemeTokens.black,
    backgroundColor: sellerThemeTokens.surface,
  },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 120,
    borderWidth: 2,
    borderColor: sellerThemeTokens.black,
    borderRadius: 6,
    backgroundColor: sellerThemeTokens.surface,
    paddingHorizontal: 12,
    paddingVertical: 10,
    color: sellerThemeTokens.text,
    fontSize: 15,
    fontFamily: sellerFonts.regular,
  },
  sendButton: {
    minHeight: 44,
    paddingHorizontal: 18,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: sellerThemeTokens.black,
    backgroundColor: sellerThemeTokens.primary,
    alignItems: "center",
    justifyContent: "center",
    ...neoShadow,
  },
  sendButtonDisabled: {
    opacity: 0.55,
  },
  sendButtonPressed: {
    transform: [{ translateX: 2 }, { translateY: 2 }],
  },
  sendButtonLabel: {
    color: sellerThemeTokens.surface,
    fontSize: 15,
    fontFamily: sellerFonts.bold,
  },
  errorText: {
    color: sellerThemeTokens.danger,
    fontSize: 14,
    fontFamily: sellerFonts.regular,
    lineHeight: 20,
  },
});
