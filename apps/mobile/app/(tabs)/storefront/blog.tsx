import { useCallback, useEffect, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";

import type { BlogPost, ScheduledBlogPost } from "@self-sown/domain";

import {
  ActionButton,
  EmptyState,
  ScreenScrollView,
  ScreenTitle,
  SellerCard,
  SellerField,
  StatusPill,
} from "@/components/seller-ui";
import LoadingScreen from "@/components/loading-screen";
import {
  blogDraftFromPost,
  broadcastBlogPost,
  deleteBlogPost,
  deleteScheduledBlogPost,
  getSenderDomainValid,
  listBlogPosts,
  listScheduledBlogPosts,
  newBlogDTag,
  parseHashtags,
  parseScheduleInput,
  publishBlogPost,
  saveScheduledBlogPost,
  validateBlogEditorDraft,
  type BlogEditorDraft,
} from "@/lib/blog";
import { getMembershipStatus, isMembershipEntitled } from "@/lib/assistant";
import { getErrorMessage } from "@/lib/error-utils";
import { useSessionStore } from "@/stores/session-store";
import { sellerFonts, sellerThemeTokens } from "@/theme/tokens";

type EditorState = BlogEditorDraft & {
  scheduleAt: string;
  sendAsEmail: boolean;
  // The stored draft/scheduled row being edited, so publish-now can clean it up.
  editingScheduledDTag: string | null;
};

const EMPTY_EDITOR: EditorState = {
  dTag: "",
  title: "",
  summary: "",
  imageUrl: "",
  externalUrl: "",
  hashtags: [],
  content: "",
  scheduleAt: "",
  sendAsEmail: false,
  editingScheduledDTag: null,
};

export default function BlogScreen() {
  const session = useSessionStore((state) => state.session);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [posts, setPosts] = useState<BlogPost[]>([]);
  const [scheduledItems, setScheduledItems] = useState<ScheduledBlogPost[]>([]);
  const [canEmail, setCanEmail] = useState(false);
  const [hashtagsRaw, setHashtagsRaw] = useState("");

  const [editor, setEditor] = useState<EditorState | null>(null);
  const [busy, setBusy] = useState<
    null | "publish" | "draft" | "schedule" | "email"
  >(null);
  const [notice, setNotice] = useState("");
  const [formError, setFormError] = useState("");

  const refresh = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    setLoadError("");
    try {
      const membership = await getMembershipStatus(session.pubkey);
      const isPro = isMembershipEntitled(membership.status);
      const [loadedPosts, loadedScheduled, senderValid] = await Promise.all([
        listBlogPosts(session.pubkey),
        // Drafts/scheduled are Pro-gated server-side; skip silently when not
        // entitled so free sellers can still manage published posts.
        isPro
          ? listScheduledBlogPosts(session).catch(
              () => [] as ScheduledBlogPost[]
            )
          : Promise.resolve([] as ScheduledBlogPost[]),
        isPro ? getSenderDomainValid(session.pubkey) : Promise.resolve(false),
      ]);
      setPosts(loadedPosts);
      setScheduledItems(loadedScheduled);
      setCanEmail(isPro && senderValid);
    } catch (caughtError) {
      setLoadError(
        getErrorMessage(caughtError, "Blog posts could not be loaded.")
      );
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!session) return null;

  const openEditor = (state: Partial<EditorState>) => {
    const next = { ...EMPTY_EDITOR, ...state, dTag: state.dTag || newBlogDTag() };
    setEditor(next);
    setHashtagsRaw(next.hashtags.join(", "));
    setFormError("");
    setNotice("");
  };

  const buildDraft = (): BlogEditorDraft | null => {
    if (!editor) return null;
    const validated = validateBlogEditorDraft({
      ...editor,
      hashtags: parseHashtags(hashtagsRaw),
    });
    if (typeof validated === "string") {
      setFormError(validated);
      return null;
    }
    return {
      dTag: validated.dTag,
      title: validated.title,
      summary: validated.summary ?? "",
      imageUrl: validated.image ?? "",
      externalUrl: validated.externalUrl ?? "",
      hashtags: validated.hashtags ?? [],
      content: validated.content,
    };
  };

  const handlePublish = async () => {
    const draft = buildDraft();
    if (!draft || !editor) return;
    setBusy("publish");
    setFormError("");
    setNotice("");
    try {
      const { eventId } = await publishBlogPost(session, draft);
      // Publishing supersedes any stored draft/scheduled row for this post.
      // Clean it up BEFORE attempting the email broadcast so a broadcast
      // failure can't leave the row queued for a second publication.
      if (editor.editingScheduledDTag) {
        try {
          await deleteScheduledBlogPost(session, editor.editingScheduledDTag);
        } catch {
          // best-effort cleanup; the row would just publish again at its time
        }
      }
      let emailNote = "";
      if (editor.sendAsEmail && canEmail) {
        try {
          emailNote = ` ${await broadcastBlogPost(session, {
            dTag: draft.dTag,
            eventId,
          })}`;
        } catch (caughtError) {
          emailNote = ` The post is live, but the email failed: ${getErrorMessage(
            caughtError,
            "The email could not be sent."
          )}`;
        }
      }
      setNotice(`Post published.${emailNote}`);
      setEditor(null);
      await refresh();
    } catch (caughtError) {
      setFormError(
        getErrorMessage(caughtError, "The post could not be published.")
      );
    } finally {
      setBusy(null);
    }
  };

  const handleSaveDraftOrSchedule = async (schedule: boolean) => {
    const draft = buildDraft();
    if (!draft || !editor) return;
    let scheduledAt: number | null = null;
    if (schedule) {
      const parsed = parseScheduleInput(editor.scheduleAt);
      if (typeof parsed === "string") {
        setFormError(parsed);
        return;
      }
      scheduledAt = parsed;
    }
    setBusy(schedule ? "schedule" : "draft");
    setFormError("");
    setNotice("");
    try {
      await saveScheduledBlogPost(
        session,
        draft,
        scheduledAt,
        editor.sendAsEmail && canEmail
      );
      setNotice(
        scheduledAt !== null
          ? `Post scheduled for ${new Date(
              scheduledAt * 1000
            ).toLocaleString()}.`
          : "Draft saved."
      );
      setEditor(null);
      await refresh();
    } catch (caughtError) {
      setFormError(
        getErrorMessage(caughtError, "The post could not be saved.")
      );
    } finally {
      setBusy(null);
    }
  };

  const handlePublishScheduledNow = async (item: ScheduledBlogPost) => {
    setBusy("publish");
    setFormError("");
    setNotice("");
    try {
      const { eventId } = await publishBlogPost(
        session,
        blogDraftFromPost(item.post)
      );
      // Remove the queued row before broadcasting so an email failure can't
      // leave it queued for a second publication at its scheduled time.
      try {
        await deleteScheduledBlogPost(session, item.dTag);
      } catch {
        // best-effort; harmless if it republishes at its scheduled time
      }
      let emailNote = "";
      if (item.sendAsEmail && canEmail) {
        try {
          emailNote = ` ${await broadcastBlogPost(session, {
            dTag: item.dTag,
            eventId,
          })}`;
        } catch (caughtError) {
          emailNote = ` The post is live, but the email failed: ${getErrorMessage(
            caughtError,
            "The email could not be sent."
          )}`;
        }
      }
      setNotice(`Post published.${emailNote}`);
      await refresh();
    } catch (caughtError) {
      setFormError(
        getErrorMessage(caughtError, "The post could not be published.")
      );
    } finally {
      setBusy(null);
    }
  };

  const handleDeleteScheduled = (item: ScheduledBlogPost) => {
    Alert.alert(
      item.status === "scheduled" ? "Delete scheduled post" : "Delete draft",
      `Delete "${item.post.title}"? This can't be undone.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            void (async () => {
              try {
                await deleteScheduledBlogPost(session, item.dTag);
                setNotice("Deleted.");
                await refresh();
              } catch (caughtError) {
                Alert.alert(
                  "Delete failed",
                  getErrorMessage(caughtError, "The post could not be deleted.")
                );
              }
            })();
          },
        },
      ]
    );
  };

  const handleEmailExisting = async (post: BlogPost) => {
    if (!canEmail) return;
    setBusy("email");
    setFormError("");
    setNotice("");
    try {
      const note = await broadcastBlogPost(session, {
        dTag: post.dTag,
        eventId: post.id,
      });
      setNotice(note);
    } catch (caughtError) {
      setFormError(
        getErrorMessage(caughtError, "The email could not be sent.")
      );
    } finally {
      setBusy(null);
    }
  };

  const handleDeletePost = (post: BlogPost) => {
    Alert.alert(
      "Delete post",
      `Delete "${post.title}"? This can't be undone.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            void (async () => {
              try {
                await deleteBlogPost(session, post.id);
                setNotice(`"${post.title}" deleted.`);
                await refresh();
              } catch (caughtError) {
                Alert.alert(
                  "Delete failed",
                  getErrorMessage(caughtError, "The post could not be deleted.")
                );
              }
            })();
          },
        },
      ]
    );
  };

  if (loading && posts.length === 0) {
    return <LoadingScreen message="Loading your blog..." />;
  }

  if (loadError && posts.length === 0) {
    return (
      <ScreenScrollView>
        <SellerCard title="Blog unavailable">
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
          eyebrow="Blog"
          title={editor.editingScheduledDTag ? "Edit draft" : "Edit post"}
          description="Write in Markdown. The post appears on your storefront when published."
        />
        <SellerCard title="Post">
          <SellerField
            label="Title"
            value={editor.title}
            onChangeText={(value) =>
              setEditor((current) =>
                current ? { ...current, title: value } : current
              )
            }
            placeholder="New harvest is in"
          />
          <SellerField
            label="Summary (optional)"
            value={editor.summary}
            onChangeText={(value) =>
              setEditor((current) =>
                current ? { ...current, summary: value } : current
              )
            }
            placeholder="A short teaser shown in previews."
          />
          <SellerField
            label="Image URL (optional)"
            value={editor.imageUrl}
            onChangeText={(value) =>
              setEditor((current) =>
                current ? { ...current, imageUrl: value } : current
              )
            }
            placeholder="https://..."
            autoCapitalize="none"
          />
          <SellerField
            label="Link URL (optional)"
            value={editor.externalUrl}
            onChangeText={(value) =>
              setEditor((current) =>
                current ? { ...current, externalUrl: value } : current
              )
            }
            placeholder="https://..."
            autoCapitalize="none"
          />
          <SellerField
            label="Hashtags (comma separated)"
            value={hashtagsRaw}
            onChangeText={setHashtagsRaw}
            placeholder="farm, eggs, seasonal"
            autoCapitalize="none"
          />
          <SellerField
            label="Content (Markdown)"
            value={editor.content}
            onChangeText={(value) =>
              setEditor((current) =>
                current ? { ...current, content: value } : current
              )
            }
            placeholder="Write your post..."
            multiline
          />
        </SellerCard>

        <SellerCard title="Delivery">
          <SellerField
            label="Schedule for (optional, e.g. 2026-12-31 09:00)"
            value={editor.scheduleAt}
            onChangeText={(value) =>
              setEditor((current) =>
                current ? { ...current, scheduleAt: value } : current
              )
            }
            placeholder="Leave empty to publish or save a draft now"
            autoCapitalize="none"
          />
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: editor.sendAsEmail }}
            disabled={!canEmail}
            onPress={() =>
              setEditor((current) =>
                current
                  ? { ...current, sendAsEmail: !current.sendAsEmail }
                  : current
              )
            }
            style={[
              styles.emailToggle,
              editor.sendAsEmail && canEmail && styles.emailToggleSelected,
              !canEmail && styles.emailToggleDisabled,
            ]}
          >
            <Text
              style={[
                styles.emailToggleLabel,
                editor.sendAsEmail && canEmail && styles.emailToggleLabelSelected,
              ]}
            >
              Also email this post to my audience
            </Text>
          </Pressable>
          {!canEmail ? (
            <Text style={styles.helperText}>
              Emailing posts requires Herd and a verified sender domain (set up
              on the web under Settings → Email).
            </Text>
          ) : null}
        </SellerCard>

        {formError ? <Text style={styles.errorText}>{formError}</Text> : null}
        {notice ? <Text style={styles.successText}>{notice}</Text> : null}

        <ActionButton
          label="Publish now"
          onPress={() => void handlePublish()}
          loading={busy === "publish"}
        />
        <ActionButton
          label="Save as draft"
          onPress={() => void handleSaveDraftOrSchedule(false)}
          loading={busy === "draft"}
          variant="secondary"
        />
        <ActionButton
          label="Schedule"
          onPress={() => void handleSaveDraftOrSchedule(true)}
          loading={busy === "schedule"}
          variant="secondary"
          disabled={!editor.scheduleAt.trim()}
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
        title="Blog"
        description="Long-form posts on your storefront. Publish now, save drafts, schedule ahead, or email a post to your audience."
      />

      {notice ? <Text style={styles.successText}>{notice}</Text> : null}
      {formError ? <Text style={styles.errorText}>{formError}</Text> : null}

      <SellerCard title="Write">
        <ActionButton
          label="New post"
          onPress={() => openEditor({})}
        />
      </SellerCard>

      <SellerCard
        title="Drafts and scheduled"
        description={`${scheduledItems.length} waiting`}
      >
        {scheduledItems.length === 0 ? (
          <EmptyState
            title="No drafts"
            description="Saved drafts and scheduled posts appear here."
          />
        ) : (
          scheduledItems.map((item) => (
            <View key={item.dTag} style={styles.postRow}>
              <View style={styles.postHeader}>
                <Text style={styles.postTitle}>{item.post.title}</Text>
                <StatusPill
                  tone={item.status === "scheduled" ? "success" : "neutral"}
                  label={item.status === "scheduled" ? "Scheduled" : "Draft"}
                />
              </View>
              {item.scheduledAt ? (
                <Text style={styles.postMeta}>
                  Publishes {new Date(item.scheduledAt * 1000).toLocaleString()}
                </Text>
              ) : null}
              {item.lastError ? (
                <Text style={styles.errorText}>
                  Last attempt failed: {item.lastError}
                </Text>
              ) : null}
              <View style={styles.postActions}>
                <ActionButton
                  label="Edit"
                  onPress={() =>
                    openEditor({
                      ...blogDraftFromPost(item.post),
                      scheduleAt: item.scheduledAt
                        ? new Date(item.scheduledAt * 1000)
                            .toISOString()
                            .slice(0, 16)
                            .replace("T", " ")
                        : "",
                      sendAsEmail: item.sendAsEmail,
                      editingScheduledDTag: item.dTag,
                    })
                  }
                  variant="secondary"
                />
                <ActionButton
                  label="Publish now"
                  onPress={() => void handlePublishScheduledNow(item)}
                  variant="secondary"
                  loading={busy === "publish"}
                />
                <ActionButton
                  label="Delete"
                  onPress={() => handleDeleteScheduled(item)}
                  variant="secondary"
                />
              </View>
            </View>
          ))
        )}
      </SellerCard>

      <SellerCard title="Published" description={`${posts.length} live`}>
        {posts.length === 0 ? (
          <EmptyState
            title="No posts yet"
            description="Publish your first post and it will appear here."
          />
        ) : (
          posts.map((post) => (
            <View key={post.dTag} style={styles.postRow}>
              <Text style={styles.postTitle}>{post.title}</Text>
              <Text style={styles.postMeta}>
                Published {new Date(post.publishedAt * 1000).toLocaleDateString()}
              </Text>
              <View style={styles.postActions}>
                <ActionButton
                  label="Edit"
                  onPress={() =>
                    openEditor({ ...blogDraftFromPost(post) })
                  }
                  variant="secondary"
                />
                {canEmail ? (
                  <ActionButton
                    label="Email to audience"
                    onPress={() => void handleEmailExisting(post)}
                    variant="secondary"
                    loading={busy === "email"}
                  />
                ) : null}
                <ActionButton
                  label="Delete"
                  onPress={() => handleDeletePost(post)}
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
  postRow: {
    gap: 8,
    padding: 14,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: sellerThemeTokens.black,
    backgroundColor: sellerThemeTokens.surface,
  },
  postHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  postTitle: {
    color: sellerThemeTokens.text,
    fontSize: 16,
    fontFamily: sellerFonts.bold,
    flexShrink: 1,
  },
  postMeta: {
    color: sellerThemeTokens.mutedText,
    fontSize: 13,
    fontFamily: sellerFonts.regular,
  },
  postActions: {
    gap: 8,
  },
  emailToggle: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: sellerThemeTokens.black,
    backgroundColor: sellerThemeTokens.surface,
  },
  emailToggleSelected: {
    backgroundColor: sellerThemeTokens.primary,
  },
  emailToggleDisabled: {
    opacity: 0.5,
  },
  emailToggleLabel: {
    color: sellerThemeTokens.text,
    fontSize: 14,
    fontFamily: sellerFonts.bold,
  },
  emailToggleLabelSelected: {
    color: sellerThemeTokens.surface,
  },
});
