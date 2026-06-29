import { useState, useEffect, useContext, useCallback, useMemo } from "react";
import { Button, Input, Textarea, Spinner, Switch } from "@heroui/react";
import { SettingsBreadCrumbs } from "@/components/settings/settings-bread-crumbs";
import {
  SignerContext,
  NostrContext,
} from "@/components/utility-components/nostr-context-provider";
import { useProMembership } from "@/components/utility-components/pro-membership-context";
import UpgradeBanner from "@/components/pro/upgrade-banner";
import BlogMarkdown from "@/components/storefront/blog/blog-markdown";
import {
  BLACKBUTTONCLASSNAMES,
  BLUEBUTTONCLASSNAMES,
  WHITEBUTTONCLASSNAMES,
  DANGERBUTTONCLASSNAMES,
} from "@/utils/STATIC-VARIABLES";
import {
  PlusIcon,
  PencilIcon,
  TrashIcon,
  ArrowLeftIcon,
  CheckCircleIcon,
  ExclamationCircleIcon,
  EyeIcon,
  PaperAirplaneIcon,
  NewspaperIcon,
  ClockIcon,
  DocumentTextIcon,
} from "@heroicons/react/24/outline";
import {
  createNostrBlogPost,
  signNostrBlogPost,
  deleteEvent,
} from "@/utils/nostr/nostr-helper-functions";
import { createSellerActionAuthEventTemplate } from "@milk-market/nostr";
import {
  BLOG_POST_KIND,
  parseBlogPostEvent,
  dedupeLatestBlogPosts,
  isHttpUrl,
  type BlogPost,
  type BlogPostDraft,
  type ScheduledBlogPost,
} from "@milk-market/domain";

const BROADCAST_PATH = "/api/email/broadcast-blog-post";
const SCHEDULED_POST_PATH = "/api/storefront/blog/scheduled-post";
const SCHEDULED_POSTS_PATH = "/api/storefront/blog/scheduled-posts";
// Scheduled time must be at least this far out (mirrors the server guard).
const MIN_SCHEDULE_LEAD_MS = 60 * 1000;
// A scheduled post that has failed this many times is treated as stuck/"failed"
// rather than merely "retrying" so the seller knows to step in.
const FAILED_ATTEMPT_THRESHOLD = 5;

// Classify a scheduled post's publishing health for the drafts list. Returns
// "failed" once the cron has exhausted enough retries, "retrying" when it has
// failed at least once or has missed its scheduled time, else null (on track).
function scheduledPostHealth(
  item: ScheduledBlogPost,
  nowMs: number
): "retrying" | "failed" | null {
  if (item.status !== "scheduled") return null;
  if (item.attemptCount >= FAILED_ATTEMPT_THRESHOLD) return "failed";
  const overdue = item.scheduledAt != null && item.scheduledAt * 1000 < nowMs;
  if (item.attemptCount > 0 || overdue) return "retrying";
  return null;
}

// Epoch seconds <-> the value format a <input type="datetime-local"> expects
// ("YYYY-MM-DDTHH:mm" in the browser's local time).
function epochToLocalInput(epoch: number): string {
  const d = new Date(epoch * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

function localInputToEpoch(value: string): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 1000);
}

const INPUT_CLASSNAMES = {
  label: "text-black",
  input: "!text-black",
  inputWrapper:
    "rounded-md border-2 border-black bg-white shadow-none data-[hover=true]:bg-white data-[focus=true]:bg-white group-data-[focus=true]:bg-white group-data-[focus=true]:border-black",
};

function newDTag(): string {
  try {
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      return crypto.randomUUID();
    }
  } catch {
    // fall through
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function parseHashtags(raw: string): string[] {
  return raw
    .split(/[,\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

const BlogSettingsPage = () => {
  const { pubkey, signer, isLoggedIn } = useContext(SignerContext);
  const { nostr } = useContext(NostrContext);
  const { membership } = useProMembership();

  const [posts, setPosts] = useState<BlogPost[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  const [senderDomainVerified, setSenderDomainVerified] = useState(false);

  const [scheduledItems, setScheduledItems] = useState<ScheduledBlogPost[]>([]);

  const [showEditor, setShowEditor] = useState(false);
  const [editingPost, setEditingPost] = useState<BlogPost | null>(null);
  // The draft/scheduled row being edited (null when editing a live post or
  // creating from scratch). Lets us clean up the stored row after publish-now.
  const [editingScheduled, setEditingScheduled] =
    useState<ScheduledBlogPost | null>(null);
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [externalUrl, setExternalUrl] = useState("");
  const [hashtags, setHashtags] = useState("");
  const [content, setContent] = useState("");
  const [scheduleAt, setScheduleAt] = useState("");
  const [showPreview, setShowPreview] = useState(false);
  const [sendAsEmail, setSendAsEmail] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);
  const [isSavingDraft, setIsSavingDraft] = useState(false);
  const [isScheduling, setIsScheduling] = useState(false);
  const [emailingDTag, setEmailingDTag] = useState<string | null>(null);
  const [publishingDTag, setPublishingDTag] = useState<string | null>(null);
  // Per-post chosen audience for the manual "email this post" action. Defaults
  // to "all" (the full audience) until the seller narrows it.
  const [emailAudienceByDTag, setEmailAudienceByDTag] = useState<
    Record<string, "all" | "popup" | "subscription">
  >({});

  const canEmail = membership.isPro && senderDomainVerified;

  const fetchPosts = useCallback(async () => {
    if (!pubkey) return;
    setIsLoading(true);
    try {
      const res = await fetch(
        `/api/storefront/blog-posts?pubkey=${encodeURIComponent(pubkey)}`
      );
      const data = await res.json();
      const parsed = (Array.isArray(data) ? data : [])
        .map((e: unknown) => parseBlogPostEvent(e as any))
        .filter((p: BlogPost | null): p is BlogPost => p !== null);
      setPosts(dedupeLatestBlogPosts(parsed));
    } catch {
      setError("Failed to load your blog posts.");
    } finally {
      setIsLoading(false);
    }
  }, [pubkey]);

  const fetchSenderDomain = useCallback(async () => {
    if (!pubkey || !membership.isPro) {
      setSenderDomainVerified(false);
      return;
    }
    try {
      const res = await fetch(
        `/api/email/sender-domain?pubkey=${encodeURIComponent(pubkey)}`
      );
      const data = await res.json();
      setSenderDomainVerified(!!data?.valid);
    } catch {
      setSenderDomainVerified(false);
    }
  }, [pubkey, membership.isPro]);

  // Drafts + scheduled posts live server-side and are never broadcast to relays
  // until they go live, so reading them requires a signed auth event proving
  // ownership (passed as a base64 `auth` query param). Failures are silent —
  // the seller just sees no drafts.
  const fetchScheduledPosts = useCallback(async () => {
    if (!pubkey || !signer) {
      setScheduledItems([]);
      return;
    }
    try {
      const signedAuth = await signer.sign(
        createSellerActionAuthEventTemplate(
          pubkey,
          "blog-scheduled-read" as any,
          { method: "GET", path: SCHEDULED_POSTS_PATH }
        )
      );
      const auth = btoa(JSON.stringify(signedAuth));
      const res = await fetch(
        `${SCHEDULED_POSTS_PATH}?pubkey=${encodeURIComponent(
          pubkey
        )}&auth=${encodeURIComponent(auth)}`
      );
      if (!res.ok) {
        setScheduledItems([]);
        return;
      }
      const data = await res.json();
      setScheduledItems(Array.isArray(data) ? data : []);
    } catch {
      setScheduledItems([]);
    }
  }, [pubkey, signer]);

  useEffect(() => {
    if (pubkey) {
      fetchPosts();
      fetchSenderDomain();
      fetchScheduledPosts();
    }
  }, [pubkey, fetchPosts, fetchSenderDomain, fetchScheduledPosts]);

  useEffect(() => {
    if (successMessage) {
      const timer = setTimeout(() => setSuccessMessage(null), 6000);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [successMessage]);

  useEffect(() => {
    if (error) {
      const timer = setTimeout(() => setError(null), 8000);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [error]);

  const resetForm = () => {
    setTitle("");
    setSummary("");
    setImageUrl("");
    setExternalUrl("");
    setHashtags("");
    setContent("");
    setScheduleAt("");
    setShowPreview(false);
    setSendAsEmail(false);
  };

  const fillForm = (post: BlogPost) => {
    setTitle(post.title);
    setSummary(post.summary || "");
    setImageUrl(post.image || "");
    setExternalUrl(post.externalUrl || "");
    setHashtags(post.hashtags.join(", "));
    setContent(post.content);
    setShowPreview(false);
  };

  const openCreate = () => {
    setEditingPost(null);
    setEditingScheduled(null);
    resetForm();
    setShowEditor(true);
  };

  const openEdit = (post: BlogPost) => {
    setEditingPost(post);
    setEditingScheduled(null);
    fillForm(post);
    setScheduleAt("");
    setSendAsEmail(false);
    setShowEditor(true);
  };

  // Edit an existing draft / scheduled entry: prefill its content, schedule
  // time, and email choice so the seller can adjust before saving or publishing.
  const openEditScheduled = (item: ScheduledBlogPost) => {
    setEditingPost(item.post);
    setEditingScheduled(item);
    fillForm(item.post);
    setScheduleAt(item.scheduledAt ? epochToLocalInput(item.scheduledAt) : "");
    setSendAsEmail(item.sendAsEmail);
    setShowEditor(true);
  };

  const closeEditor = () => {
    setShowEditor(false);
    setEditingPost(null);
    setEditingScheduled(null);
    resetForm();
  };

  // Shared form validation for publish / draft / schedule. Returns the trimmed
  // draft on success, or null after setting an error message.
  const buildValidatedDraft = (): BlogPostDraft | null => {
    const t = title.trim();
    if (!t) {
      setError("Add a title.");
      return null;
    }
    if (!content.trim()) {
      setError("Add some content.");
      return null;
    }
    if (imageUrl.trim() && !isHttpUrl(imageUrl.trim())) {
      setError("Cover image must be a valid http(s) URL.");
      return null;
    }
    if (externalUrl.trim() && !isHttpUrl(externalUrl.trim())) {
      setError("External link must be a valid http(s) URL.");
      return null;
    }
    const dTag = editingPost ? editingPost.dTag : newDTag();
    return {
      dTag,
      title: t,
      content,
      ...(summary.trim() ? { summary: summary.trim() } : {}),
      ...(imageUrl.trim() ? { image: imageUrl.trim() } : {}),
      ...(externalUrl.trim() ? { externalUrl: externalUrl.trim() } : {}),
      hashtags: parseHashtags(hashtags),
    };
  };

  const draftFromPost = (post: BlogPost): BlogPostDraft => ({
    dTag: post.dTag,
    title: post.title,
    content: post.content,
    ...(post.summary ? { summary: post.summary } : {}),
    ...(post.image ? { image: post.image } : {}),
    ...(post.externalUrl ? { externalUrl: post.externalUrl } : {}),
    hashtags: post.hashtags,
  });

  // Remove a stored draft/scheduled row by d-tag (authed). Used after a
  // publish-now and from the drafts list delete button.
  const deleteScheduledRow = useCallback(
    async (dTag: string): Promise<boolean> => {
      if (!signer || !pubkey) return false;
      const signedEvent = await signer.sign(
        createSellerActionAuthEventTemplate(
          pubkey,
          "blog-scheduled-write" as any,
          { method: "DELETE", path: SCHEDULED_POST_PATH, fields: { dTag } }
        )
      );
      const res = await fetch(SCHEDULED_POST_PATH, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pubkey, dTag, signedEvent }),
      });
      return res.ok;
    },
    [signer, pubkey]
  );

  // Email a published post version to the seller's audience. Returns a short
  // human note describing the outcome (appended to the success banner). The
  // server is fail-closed: it only sends from a verified sender domain, only
  // once per version, and to the seller's own server-derived audience.
  const broadcastPost = useCallback(
    async (
      dTag: string,
      eventId: string,
      audienceSource?: "popup" | "subscription"
    ): Promise<string> => {
      if (!signer || !pubkey) return "";

      const attempt = async (): Promise<Response> => {
        const signedEvent = await signer.sign(
          createSellerActionAuthEventTemplate(
            pubkey,
            "blog-broadcast-write" as any,
            {
              method: "POST",
              path: BROADCAST_PATH,
              fields: {
                dTag,
                eventId,
                ...(audienceSource ? { audienceSource } : {}),
              },
            }
          )
        );
        return fetch(BROADCAST_PATH, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            pubkey,
            dTag,
            eventId,
            signedEvent,
            ...(audienceSource ? { audienceSource } : {}),
          }),
        });
      };

      // The just-published event is cached before publish resolves, but allow
      // one retry in case the read-after-write hasn't settled (409 retryable).
      let res = await attempt();
      if (res.status === 409) {
        await new Promise((r) => setTimeout(r, 1500));
        res = await attempt();
      }

      let data: any = {};
      try {
        data = await res.json();
      } catch {
        // ignore
      }

      if (!res.ok) {
        return `Email not sent: ${
          data.error || "please try again from the post list"
        }.`;
      }
      if (data.skipped) {
        switch (data.reason) {
          case "no-verified-sender-domain":
            return "Email not sent — verify a sender domain in Email settings first.";
          case "already-sent":
            return "Email for this version was already sent.";
          case "unsubscribe-unavailable":
            return "Email not sent — email isn't fully configured yet.";
          default:
            return "Email not sent.";
        }
      }
      if ((data.total ?? 0) === 0) {
        return "No audience emails to send to yet.";
      }
      const failNote = data.failed ? ` (${data.failed} failed)` : "";
      return `Emailed ${data.sent} subscriber${
        data.sent === 1 ? "" : "s"
      }${failNote}.`;
    },
    [signer, pubkey]
  );

  const handlePublish = async () => {
    if (!signer || !pubkey || !nostr) {
      setError("Please sign in first.");
      return;
    }
    setError(null);
    const draft = buildValidatedDraft();
    if (!draft) return;

    setIsPublishing(true);
    try {
      const signed = await createNostrBlogPost(nostr, signer, draft);
      const eventId = (signed as { id?: string } | undefined)?.id;

      let emailNote = "";
      if (sendAsEmail && canEmail && eventId) {
        emailNote = await broadcastPost(draft.dTag, eventId);
      }

      // Publishing supersedes any stored draft/scheduled row for this post.
      if (editingScheduled) {
        try {
          await deleteScheduledRow(draft.dTag);
        } catch {
          // best-effort cleanup; the row would just publish again at its time
        }
      }

      setSuccessMessage(
        `Post ${editingPost && !editingScheduled ? "updated" : "published"}.${
          emailNote ? ` ${emailNote}` : ""
        }`
      );
      closeEditor();
      await Promise.all([fetchPosts(), fetchScheduledPosts()]);
    } catch (err: any) {
      setError(err?.message || "Failed to publish post.");
    } finally {
      setIsPublishing(false);
    }
  };

  // Save the current editor content as a DRAFT or SCHEDULED post. Neither is
  // broadcast to relays now: a draft waits indefinitely; a scheduled post is
  // published (and emailed, if opted in) by the cron at its time. We pre-sign
  // the kind:30023 event client-side (server holds no key); for a scheduled post
  // we stamp created_at/published_at at the scheduled time so it sorts correctly
  // once live.
  const handleSave = async (scheduledEpoch: number | null) => {
    if (!signer || !pubkey) {
      setError("Please sign in first.");
      return;
    }
    setError(null);
    const draft = buildValidatedDraft();
    if (!draft) return;

    if (scheduledEpoch !== null) {
      if (scheduledEpoch * 1000 < Date.now() + MIN_SCHEDULE_LEAD_MS) {
        setError("Pick a schedule time at least a minute in the future.");
        return;
      }
    }

    const setBusy =
      scheduledEpoch !== null ? setIsScheduling : setIsSavingDraft;
    setBusy(true);
    try {
      const blogEvent = await signNostrBlogPost(
        signer,
        draft,
        scheduledEpoch ?? undefined
      );
      const eventId = (blogEvent as { id?: string } | undefined)?.id;
      if (!eventId) throw new Error("Failed to sign post.");

      const signedEvent = await signer.sign(
        createSellerActionAuthEventTemplate(
          pubkey,
          "blog-scheduled-write" as any,
          {
            method: "POST",
            path: SCHEDULED_POST_PATH,
            fields: { dTag: draft.dTag, eventId },
          }
        )
      );

      const res = await fetch(SCHEDULED_POST_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pubkey,
          signedEvent,
          blogEvent,
          scheduledAt: scheduledEpoch,
          sendAsEmail: sendAsEmail && canEmail,
        }),
      });
      let data: any = {};
      try {
        data = await res.json();
      } catch {
        // ignore
      }
      if (!res.ok) {
        setError(data.error || "Failed to save post.");
        return;
      }

      const emailNote =
        sendAsEmail && canEmail
          ? scheduledEpoch !== null
            ? " It will be emailed to your audience when it publishes."
            : " It will be emailed when you publish it."
          : "";
      setSuccessMessage(
        (scheduledEpoch !== null
          ? `Post scheduled for ${new Date(
              scheduledEpoch * 1000
            ).toLocaleString()}.`
          : "Draft saved.") + emailNote
      );
      closeEditor();
      await fetchScheduledPosts();
    } catch (err: any) {
      setError(err?.message || "Failed to save post.");
    } finally {
      setBusy(false);
    }
  };

  // Publish a stored draft / scheduled post immediately (broadcast to relays +
  // optional email now), then drop its stored row.
  const handlePublishNow = async (item: ScheduledBlogPost) => {
    if (!signer || !pubkey || !nostr) {
      setError("Please sign in first.");
      return;
    }
    setPublishingDTag(item.dTag);
    setError(null);
    try {
      const signed = await createNostrBlogPost(
        nostr,
        signer,
        draftFromPost(item.post)
      );
      const eventId = (signed as { id?: string } | undefined)?.id;

      let emailNote = "";
      if (item.sendAsEmail && canEmail && eventId) {
        emailNote = await broadcastPost(item.dTag, eventId);
      }

      try {
        await deleteScheduledRow(item.dTag);
      } catch {
        // best-effort; harmless if it republishes at its scheduled time
      }

      setSuccessMessage(`Post published.${emailNote ? ` ${emailNote}` : ""}`);
      await Promise.all([fetchPosts(), fetchScheduledPosts()]);
    } catch (err: any) {
      setError(err?.message || "Failed to publish post.");
    } finally {
      setPublishingDTag(null);
    }
  };

  const handleDeleteScheduled = async (item: ScheduledBlogPost) => {
    if (!signer || !pubkey) {
      setError("Please sign in first.");
      return;
    }
    if (
      typeof window !== "undefined" &&
      !window.confirm(
        `Delete ${item.status === "scheduled" ? "scheduled post" : "draft"} "${
          item.post.title
        }"? This can't be undone.`
      )
    ) {
      return;
    }
    setError(null);
    try {
      const ok = await deleteScheduledRow(item.dTag);
      if (!ok) {
        setError("Failed to delete.");
        return;
      }
      setSuccessMessage(
        `${item.status === "scheduled" ? "Scheduled post" : "Draft"} deleted.`
      );
      await fetchScheduledPosts();
    } catch (err: any) {
      setError(err?.message || "Failed to delete.");
    }
  };

  const handleEmailExisting = async (post: BlogPost) => {
    if (!canEmail) return;
    setEmailingDTag(post.dTag);
    setError(null);
    try {
      const choice = emailAudienceByDTag[post.dTag] || "all";
      const note = await broadcastPost(
        post.dTag,
        post.id,
        choice === "all" ? undefined : choice
      );
      setSuccessMessage(note || "Done.");
    } catch (err: any) {
      setError(err?.message || "Failed to send email.");
    } finally {
      setEmailingDTag(null);
    }
  };

  const handleDelete = async (post: BlogPost) => {
    if (!signer || !nostr) {
      setError("Please sign in first.");
      return;
    }
    if (
      typeof window !== "undefined" &&
      !window.confirm(`Delete "${post.title}"? This can't be undone.`)
    ) {
      return;
    }
    setError(null);
    try {
      await deleteEvent(nostr, signer, [post.id], BLOG_POST_KIND);
      setSuccessMessage(`"${post.title}" deleted.`);
      await fetchPosts();
    } catch (err: any) {
      setError(err?.message || "Failed to delete post.");
    }
  };

  const sortedPosts = useMemo(
    () => [...posts].sort((a, b) => b.publishedAt - a.publishedAt),
    [posts]
  );

  if (!isLoggedIn) {
    return (
      <div className="flex min-h-screen flex-col bg-white pt-24 pb-20">
        <div className="mx-auto w-full px-4 lg:w-1/2 xl:w-2/5">
          <SettingsBreadCrumbs />
          <div className="shadow-neo mt-8 rounded-md border-2 border-black bg-yellow-50 p-6">
            <p className="text-center text-lg font-bold text-black">
              Please sign in to manage your blog.
            </p>
          </div>
        </div>
      </div>
    );
  }

  const banner = (
    <>
      {error && (
        <div className="shadow-neo mb-4 flex items-center rounded-md border-2 border-black bg-red-100 p-3 text-red-700">
          <ExclamationCircleIcon className="mr-2 h-5 w-5 flex-shrink-0" />
          <span className="text-sm">{error}</span>
        </div>
      )}
      {successMessage && (
        <div className="shadow-neo mb-4 flex items-center rounded-md border-2 border-black bg-green-100 p-3 text-green-700">
          <CheckCircleIcon className="mr-2 h-5 w-5 flex-shrink-0" />
          <span className="text-sm">{successMessage}</span>
        </div>
      )}
    </>
  );

  if (showEditor) {
    return (
      <div className="flex min-h-screen flex-col bg-white pt-24 pb-20">
        <div className="mx-auto w-full px-4 lg:w-2/3 xl:w-1/2">
          <SettingsBreadCrumbs />

          <button
            onClick={closeEditor}
            className="mb-4 flex items-center gap-1 text-sm font-bold text-gray-600 hover:text-black"
          >
            <ArrowLeftIcon className="h-4 w-4" />
            Back to posts
          </button>

          {banner}

          <h2 className="mb-6 text-2xl font-bold text-black">
            {editingPost ? "Edit post" : "New post"}
          </h2>

          <div className="space-y-4">
            <fieldset
              disabled={!membership.isPro}
              className="m-0 space-y-4 border-0 p-0 disabled:opacity-60"
            >
              <Input
                label="Title"
                placeholder="Post title"
                value={title}
                onValueChange={setTitle}
                isRequired
                classNames={INPUT_CLASSNAMES}
              />
              <Textarea
                label="Summary"
                placeholder="A short summary shown in cards and previews (optional)"
                value={summary}
                onValueChange={setSummary}
                minRows={2}
                classNames={INPUT_CLASSNAMES}
              />
              <Input
                label="Cover image URL"
                placeholder="https://… (optional)"
                value={imageUrl}
                onValueChange={setImageUrl}
                classNames={INPUT_CLASSNAMES}
              />
              <Input
                label="External link URL"
                placeholder="https://… link out to another page (optional)"
                value={externalUrl}
                onValueChange={setExternalUrl}
                classNames={INPUT_CLASSNAMES}
              />
              <Input
                label="Hashtags"
                placeholder="comma or space separated, e.g. recipes, farm-news"
                value={hashtags}
                onValueChange={setHashtags}
                classNames={INPUT_CLASSNAMES}
              />

              <div>
                <div className="mb-2 flex items-center justify-between">
                  <label className="text-sm font-bold text-black">
                    Content (Markdown)
                  </label>
                  <Button
                    size="sm"
                    className={WHITEBUTTONCLASSNAMES}
                    onClick={() => setShowPreview((p) => !p)}
                  >
                    <EyeIcon className="h-4 w-4" />
                    {showPreview ? "Edit" : "Preview"}
                  </Button>
                </div>
                {showPreview ? (
                  <div className="min-h-[12rem] rounded-md border-2 border-black bg-white p-4">
                    {content.trim() ? (
                      <BlogMarkdown content={content} />
                    ) : (
                      <p className="text-sm text-gray-400">
                        Nothing to preview.
                      </p>
                    )}
                  </div>
                ) : (
                  <Textarea
                    placeholder="Write your post in Markdown. Raw HTML is not allowed."
                    value={content}
                    onValueChange={setContent}
                    minRows={12}
                    classNames={INPUT_CLASSNAMES}
                  />
                )}
              </div>

              {membership.isPro ? (
                canEmail ? (
                  <div className="shadow-neo flex items-start justify-between gap-3 rounded-md border-2 border-black bg-gray-50 p-4">
                    <div>
                      <p className="text-sm font-bold text-black">
                        Email this post to your audience
                      </p>
                      <p className="text-xs text-gray-600">
                        Sends from your verified domain to buyers and
                        subscribers who haven&apos;t unsubscribed. Sent once per
                        version, at publish time (or the scheduled time below).
                      </p>
                    </div>
                    <Switch
                      isSelected={sendAsEmail}
                      onValueChange={setSendAsEmail}
                    />
                  </div>
                ) : (
                  <div className="shadow-neo rounded-md border-2 border-black bg-gray-50 p-4 text-sm text-gray-700">
                    Want to email this post to your customers? Connect and
                    verify a sender domain in{" "}
                    <a
                      href="/settings/email-flows"
                      className="font-bold underline"
                    >
                      Email settings
                    </a>{" "}
                    first.
                  </div>
                )
              ) : null}

              {membership.isPro && (
                <div className="shadow-neo rounded-md border-2 border-black bg-gray-50 p-4">
                  <label
                    htmlFor="blog-schedule-at"
                    className="text-sm font-bold text-black"
                  >
                    Schedule publish time (optional)
                  </label>
                  <p className="mb-2 text-xs text-gray-600">
                    Leave empty to publish now or save as a draft. Set a time to
                    automatically publish
                    {canEmail && sendAsEmail ? " and email" : ""} later.
                  </p>
                  <input
                    id="blog-schedule-at"
                    type="datetime-local"
                    value={scheduleAt}
                    onChange={(e) => setScheduleAt(e.target.value)}
                    className="w-full rounded-md border-2 border-black bg-white p-2 text-sm text-black"
                  />
                </div>
              )}
            </fieldset>

            <div className="flex flex-wrap gap-2 pt-2">
              <Button
                className={BLUEBUTTONCLASSNAMES}
                onClick={handlePublish}
                isLoading={isPublishing}
                isDisabled={
                  !membership.isPro ||
                  !title.trim() ||
                  !content.trim() ||
                  isSavingDraft ||
                  isScheduling
                }
              >
                {editingPost && !editingScheduled
                  ? "Update post"
                  : "Publish now"}
              </Button>
              {membership.isPro && scheduleAt && (
                <Button
                  className={BLACKBUTTONCLASSNAMES}
                  onClick={() => handleSave(localInputToEpoch(scheduleAt))}
                  isLoading={isScheduling}
                  isDisabled={
                    !title.trim() ||
                    !content.trim() ||
                    isPublishing ||
                    isSavingDraft
                  }
                >
                  <ClockIcon className="h-4 w-4" />
                  Schedule
                </Button>
              )}
              {membership.isPro && (
                <Button
                  className={WHITEBUTTONCLASSNAMES}
                  onClick={() => handleSave(null)}
                  isLoading={isSavingDraft}
                  isDisabled={
                    !title.trim() ||
                    !content.trim() ||
                    isPublishing ||
                    isScheduling
                  }
                >
                  <DocumentTextIcon className="h-4 w-4" />
                  Save draft
                </Button>
              )}
              <Button className={WHITEBUTTONCLASSNAMES} onClick={closeEditor}>
                Cancel
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col bg-white pt-24 pb-20">
      <div className="mx-auto w-full px-4 lg:w-2/3 xl:w-1/2">
        <SettingsBreadCrumbs />

        {banner}

        <div className="shadow-neo mb-6 flex items-start gap-2 rounded-md border-2 border-black bg-gray-50 p-4">
          <NewspaperIcon className="mt-0.5 h-5 w-5 flex-shrink-0 text-gray-600" />
          <div className="text-sm text-gray-700">
            <p>
              Write blog posts that appear on your storefront. Posts are
              published to Nostr as long-form (NIP-23) content. Pro sellers with
              a verified sender domain can also email new posts to their
              audience.
            </p>
          </div>
        </div>

        {!membership.isPro && (
          <UpgradeBanner className="mb-6" feature="Storefront blog + email" />
        )}

        <fieldset
          disabled={!membership.isPro}
          className="m-0 block border-0 p-0 disabled:opacity-60"
        >
          {scheduledItems.length > 0 && (
            <div className="mb-8">
              <h2 className="mb-4 text-2xl font-bold text-black">
                Drafts &amp; scheduled
              </h2>
              <div className="space-y-3">
                {scheduledItems.map((item) => {
                  const health = scheduledPostHealth(item, Date.now());
                  return (
                    <div
                      key={item.dTag}
                      className={`shadow-neo rounded-md border-2 border-black p-4 ${
                        health === "failed" ? "bg-red-50" : "bg-yellow-50"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span
                              className={`inline-flex items-center gap-1 rounded border-2 border-black px-2 py-0.5 text-xs font-bold ${
                                item.status === "scheduled"
                                  ? "bg-blue-100 text-blue-800"
                                  : "bg-gray-100 text-gray-700"
                              }`}
                            >
                              {item.status === "scheduled" ? (
                                <ClockIcon className="h-3 w-3" />
                              ) : (
                                <DocumentTextIcon className="h-3 w-3" />
                              )}
                              {item.status === "scheduled"
                                ? "Scheduled"
                                : "Draft"}
                            </span>
                            {item.sendAsEmail && (
                              <span className="inline-flex items-center gap-1 rounded border-2 border-black bg-green-100 px-2 py-0.5 text-xs font-bold text-green-800">
                                <PaperAirplaneIcon className="h-3 w-3" />
                                Email
                              </span>
                            )}
                            {health && (
                              <span
                                className={`inline-flex items-center gap-1 rounded border-2 border-black px-2 py-0.5 text-xs font-bold ${
                                  health === "failed"
                                    ? "bg-red-200 text-red-900"
                                    : "bg-orange-100 text-orange-800"
                                }`}
                              >
                                <ExclamationCircleIcon className="h-3 w-3" />
                                {health === "failed" ? "Failed" : "Retrying"}
                              </span>
                            )}
                          </div>
                          <span className="mt-2 block truncate font-bold text-black">
                            {item.post.title || "Untitled"}
                          </span>
                          {item.post.summary && (
                            <p className="mt-1 line-clamp-2 text-sm text-gray-600">
                              {item.post.summary}
                            </p>
                          )}
                          {item.status === "scheduled" && item.scheduledAt && (
                            <p className="mt-1 text-xs text-gray-600">
                              Publishes{" "}
                              {new Date(
                                item.scheduledAt * 1000
                              ).toLocaleString()}
                            </p>
                          )}
                          {health && (
                            <p
                              className={`mt-1 text-xs font-semibold ${
                                health === "failed"
                                  ? "text-red-700"
                                  : "text-orange-700"
                              }`}
                            >
                              {health === "failed"
                                ? `Couldn't publish after ${item.attemptCount} tries. `
                                : item.attemptCount > 0
                                  ? `Last attempt failed (${item.attemptCount} so far). Will keep retrying. `
                                  : "Past its scheduled time — will publish on the next run. "}
                              {item.lastError ? item.lastError : null}
                              {" Try Publish now, or edit and re-save."}
                            </p>
                          )}
                        </div>
                        <div className="flex flex-shrink-0 gap-2">
                          <Button
                            className={BLUEBUTTONCLASSNAMES}
                            size="sm"
                            isLoading={publishingDTag === item.dTag}
                            onClick={() => handlePublishNow(item)}
                            title="Publish now"
                          >
                            <PaperAirplaneIcon className="h-4 w-4" />
                          </Button>
                          <Button
                            className={WHITEBUTTONCLASSNAMES}
                            size="sm"
                            onClick={() => openEditScheduled(item)}
                            title="Edit"
                          >
                            <PencilIcon className="h-4 w-4" />
                          </Button>
                          <Button
                            className={DANGERBUTTONCLASSNAMES}
                            size="sm"
                            onClick={() => handleDeleteScheduled(item)}
                            title="Delete"
                          >
                            <TrashIcon className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-2xl font-bold text-black">Your posts</h2>
            <Button className={BLACKBUTTONCLASSNAMES} onClick={openCreate}>
              <PlusIcon className="h-4 w-4" />
              New post
            </Button>
          </div>

          {isLoading ? (
            <div className="flex justify-center py-8">
              <Spinner size="lg" />
            </div>
          ) : sortedPosts.length === 0 ? (
            <div className="rounded-md border-2 border-dashed border-gray-300 p-8 text-center">
              <NewspaperIcon className="mx-auto mb-3 h-10 w-10 text-gray-400" />
              <p className="mb-2 font-bold text-gray-600">No posts yet</p>
              <p className="mb-4 text-sm text-gray-500">
                Write your first blog post to share news, recipes, or updates
                with your customers.
              </p>
              <Button className={BLUEBUTTONCLASSNAMES} onClick={openCreate}>
                <PlusIcon className="h-4 w-4" />
                Write your first post
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              {sortedPosts.map((post) => (
                <div
                  key={post.dTag}
                  className="shadow-neo rounded-md border-2 border-black bg-white p-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <span className="block truncate font-bold text-black">
                        {post.title}
                      </span>
                      {post.summary && (
                        <p className="mt-1 line-clamp-2 text-sm text-gray-600">
                          {post.summary}
                        </p>
                      )}
                      <p className="mt-1 text-xs text-gray-500">
                        {new Date(post.publishedAt * 1000).toLocaleDateString(
                          undefined,
                          { month: "short", day: "numeric", year: "numeric" }
                        )}
                        {post.hashtags.length > 0 &&
                          ` · ${post.hashtags.map((h) => `#${h}`).join(" ")}`}
                      </p>
                    </div>
                    <div className="flex flex-shrink-0 gap-2">
                      {canEmail && (
                        <>
                          <select
                            aria-label="Choose who to email this post to"
                            title="Choose who to email this post to"
                            value={emailAudienceByDTag[post.dTag] || "all"}
                            onChange={(e) =>
                              setEmailAudienceByDTag((prev) => ({
                                ...prev,
                                [post.dTag]: e.target.value as
                                  | "all"
                                  | "popup"
                                  | "subscription",
                              }))
                            }
                            className="shadow-neo rounded-md border-2 border-black bg-white px-2 text-xs font-medium text-black"
                          >
                            <option value="all">All contacts</option>
                            <option value="popup">Popup only</option>
                            <option value="subscription">
                              Subscription only
                            </option>
                          </select>
                          <Button
                            className={BLUEBUTTONCLASSNAMES}
                            size="sm"
                            isLoading={emailingDTag === post.dTag}
                            onClick={() => handleEmailExisting(post)}
                            title="Email this post to the chosen audience"
                          >
                            <PaperAirplaneIcon className="h-4 w-4" />
                          </Button>
                        </>
                      )}
                      <Button
                        className={WHITEBUTTONCLASSNAMES}
                        size="sm"
                        onClick={() => openEdit(post)}
                        title="Edit"
                      >
                        <PencilIcon className="h-4 w-4" />
                      </Button>
                      <Button
                        className={DANGERBUTTONCLASSNAMES}
                        size="sm"
                        onClick={() => handleDelete(post)}
                        title="Delete"
                      >
                        <TrashIcon className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </fieldset>
      </div>
    </div>
  );
};

export default BlogSettingsPage;
