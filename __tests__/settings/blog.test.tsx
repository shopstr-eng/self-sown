import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import BlogSettingsPage from "@/pages/settings/blog";
import {
  SignerContext,
  NostrContext,
} from "@/components/utility-components/nostr-context-provider";
import {
  createNostrBlogPost,
  signNostrBlogPost,
} from "@/utils/nostr/nostr-helper-functions";
import { parseBlogPostEvent } from "@milk-market/domain";

jest.mock("@/components/settings/settings-bread-crumbs", () => ({
  SettingsBreadCrumbs: () => <div data-testid="breadcrumbs" />,
}));

jest.mock("@/components/pro/upgrade-banner", () => ({
  __esModule: true,
  default: () => <div data-testid="upgrade-banner" />,
}));

jest.mock("@/components/storefront/blog/blog-markdown", () => ({
  __esModule: true,
  default: ({ content }: { content: string }) => <div>{content}</div>,
}));

let mockIsPro = true;
jest.mock("@/components/utility-components/pro-membership-context", () => ({
  useProMembership: () => ({ membership: { isPro: mockIsPro } }),
}));

jest.mock("@/utils/nostr/nostr-helper-functions", () => ({
  createNostrBlogPost: jest.fn(),
  signNostrBlogPost: jest.fn(),
  deleteEvent: jest.fn(),
}));

jest.mock("@milk-market/nostr", () => ({
  createSellerActionAuthEventTemplate: jest.fn(() => ({ kind: 27235 })),
}));

jest.mock("@milk-market/domain", () => ({
  BLOG_POST_KIND: 30023,
  parseBlogPostEvent: jest.fn(() => null),
  dedupeLatestBlogPosts: jest.fn((posts: unknown[]) => posts),
  isHttpUrl: (v: unknown) =>
    typeof v === "string" && /^https?:\/\//.test(v.trim()),
}));

jest.mock(
  "@heroicons/react/24/outline",
  () =>
    new Proxy(
      {},
      {
        get: () => () => null,
      }
    )
);

jest.mock("@heroui/react", () => ({
  Button: ({ children, onClick, isDisabled, title, type }: any) => (
    <button
      disabled={isDisabled}
      onClick={onClick}
      title={title}
      type={type || "button"}
    >
      {children}
    </button>
  ),
  Input: ({ label, value, onValueChange, placeholder }: any) => (
    <input
      aria-label={label || placeholder}
      value={value || ""}
      onChange={(e) => onValueChange?.(e.target.value)}
    />
  ),
  Textarea: ({ label, value, onValueChange, placeholder }: any) => (
    <textarea
      aria-label={label || placeholder}
      value={value || ""}
      onChange={(e) => onValueChange?.(e.target.value)}
    />
  ),
  Switch: ({ isSelected, onValueChange }: any) => (
    <input
      type="checkbox"
      role="switch"
      checked={!!isSelected}
      onChange={(e) => onValueChange?.(e.target.checked)}
    />
  ),
  Spinner: () => <div>Loading...</div>,
}));

const mocked = {
  createNostrBlogPost: createNostrBlogPost as jest.Mock,
  signNostrBlogPost: signNostrBlogPost as jest.Mock,
};

const PUBKEY = "f".repeat(64);

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body };
}

let fetchMock: jest.Mock;
let senderValid: boolean;
let scheduledList: any[];
let postsList: any[];
let broadcastImpl: jest.Mock;

const sign = jest.fn();

const livePost = {
  id: "evt-live",
  pubkey: PUBKEY,
  dTag: "live-1",
  title: "Live Post",
  summary: "",
  content: "live body",
  publishedAt: 1000,
  updatedAt: 1000,
  hashtags: [],
};

function scheduledItem(overrides: Record<string, unknown> = {}) {
  return {
    dTag: "sched-1",
    status: "scheduled",
    eventId: "evt-sched",
    scheduledAt: Math.floor(Date.now() / 1000) + 3600,
    sendAsEmail: true,
    updatedAt: 1000,
    post: {
      id: "evt-sched",
      pubkey: PUBKEY,
      dTag: "sched-1",
      title: "Scheduled Title",
      summary: "",
      content: "scheduled body",
      publishedAt: 1000,
      updatedAt: 1000,
      hashtags: [],
    },
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIsPro = true;
  senderValid = false;
  scheduledList = [];
  postsList = [];
  (parseBlogPostEvent as jest.Mock).mockReturnValue(null);
  broadcastImpl = jest
    .fn()
    .mockResolvedValue(
      jsonResponse({ sent: 3, total: 3, failed: 0, skipped: false })
    );

  sign.mockResolvedValue({
    id: "auth-id",
    pubkey: PUBKEY,
    kind: 27235,
    created_at: 1710000000,
    tags: [],
    content: "",
    sig: "sig",
  });

  mocked.signNostrBlogPost.mockResolvedValue({
    id: "evt-signed",
    pubkey: PUBKEY,
    kind: 30023,
    created_at: 2000,
    tags: [["d", "new-tag"]],
    content: "body",
    sig: "x",
  });
  mocked.createNostrBlogPost.mockResolvedValue({ id: "evt-published" });

  fetchMock = jest.fn((url: string) => {
    const u = String(url);
    if (u.includes("/api/storefront/blog-posts")) {
      return Promise.resolve(jsonResponse(postsList));
    }
    if (u.includes("/api/email/sender-domain")) {
      return Promise.resolve(jsonResponse({ valid: senderValid }));
    }
    if (u.includes("/api/storefront/blog/scheduled-posts")) {
      return Promise.resolve(jsonResponse(scheduledList));
    }
    if (u.includes("/api/storefront/blog/scheduled-post")) {
      return Promise.resolve(
        jsonResponse({ status: "draft", dTag: "new-tag" })
      );
    }
    if (u.includes("/api/email/broadcast-blog-post")) {
      return broadcastImpl();
    }
    return Promise.resolve(jsonResponse({}));
  });
  (global as any).fetch = fetchMock;
});

function renderPage() {
  return render(
    <SignerContext.Provider
      value={
        {
          pubkey: PUBKEY,
          isLoggedIn: true,
          signer: { sign } as any,
        } as any
      }
    >
      <NostrContext.Provider value={{ nostr: {} } as any}>
        <BlogSettingsPage />
      </NostrContext.Provider>
    </SignerContext.Provider>
  );
}

async function openNewEditor() {
  renderPage();
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.some((c) =>
        String(c[0]).includes("/api/storefront/blog-posts")
      )
    ).toBe(true)
  );
  fireEvent.click(screen.getByRole("button", { name: /new post/i }));
  fireEvent.change(screen.getByLabelText("Title"), {
    target: { value: "My Post" },
  });
  fireEvent.change(
    screen.getByLabelText(
      "Write your post in Markdown. Raw HTML is not allowed."
    ),
    { target: { value: "Hello world body" } }
  );
}

function saveCalls() {
  return fetchMock.mock.calls.filter(
    (c) =>
      c[1]?.method === "POST" &&
      String(c[0]).includes("/scheduled-post") &&
      !String(c[0]).includes("/scheduled-posts")
  );
}

describe("blog editor handlers", () => {
  test("save draft signs the post but never broadcasts it to relays", async () => {
    await openNewEditor();

    fireEvent.click(screen.getByRole("button", { name: /save draft/i }));

    await waitFor(() => expect(saveCalls().length).toBe(1));

    // Draft path signs only — it must NOT publish to relays.
    expect(mocked.signNostrBlogPost).toHaveBeenCalledTimes(1);
    expect(mocked.createNostrBlogPost).not.toHaveBeenCalled();

    const body = JSON.parse(saveCalls()[0]![1].body);
    expect(body).toMatchObject({
      pubkey: PUBKEY,
      scheduledAt: null,
      sendAsEmail: false,
    });
    expect(body.blogEvent).toMatchObject({ id: "evt-signed" });

    expect(await screen.findByText(/Draft saved\./i)).toBeInTheDocument();
  });

  test("scheduling stamps the future epoch and never broadcasts to relays", async () => {
    await openNewEditor();

    const future = Math.floor(Date.now() / 1000) + 3 * 24 * 60 * 60;
    const futureLocal = (() => {
      const d = new Date(future * 1000);
      const pad = (n: number) => String(n).padStart(2, "0");
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(
        d.getDate()
      )}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    })();

    fireEvent.change(screen.getByLabelText(/Schedule publish time/i), {
      target: { value: futureLocal },
    });

    fireEvent.click(screen.getByRole("button", { name: /schedule/i }));

    await waitFor(() => expect(saveCalls().length).toBe(1));

    expect(mocked.signNostrBlogPost).toHaveBeenCalledTimes(1);
    expect(mocked.createNostrBlogPost).not.toHaveBeenCalled();

    const body = JSON.parse(saveCalls()[0]![1].body);
    // The future epoch is stamped (within a minute of what we picked).
    expect(Math.abs(body.scheduledAt - future)).toBeLessThanOrEqual(60);
    // The pre-signed event is stamped at the scheduled time too.
    expect(mocked.signNostrBlogPost).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      body.scheduledAt
    );

    expect(await screen.findByText(/Post scheduled for/i)).toBeInTheDocument();
  });

  test("scheduling a past time is rejected before any save call", async () => {
    await openNewEditor();

    const past = new Date(Date.now() - 60 * 60 * 1000);
    const pad = (n: number) => String(n).padStart(2, "0");
    const pastLocal = `${past.getFullYear()}-${pad(
      past.getMonth() + 1
    )}-${pad(past.getDate())}T${pad(past.getHours())}:${pad(
      past.getMinutes()
    )}`;

    fireEvent.change(screen.getByLabelText(/Schedule publish time/i), {
      target: { value: pastLocal },
    });

    fireEvent.click(screen.getByRole("button", { name: /schedule/i }));

    expect(
      await screen.findByText(
        /Pick a schedule time at least a minute in the future\./i
      )
    ).toBeInTheDocument();
    expect(saveCalls().length).toBe(0);
    expect(mocked.signNostrBlogPost).not.toHaveBeenCalled();
  });

  test("publish-now broadcasts the post and fires the email at publish time", async () => {
    senderValid = true; // sender domain verified -> canEmail true
    scheduledList = [scheduledItem({ sendAsEmail: true })];

    renderPage();

    // Wait for the scheduled item to render in the drafts/scheduled list.
    const card = await screen.findByText("Scheduled Title");
    const row = card.closest("div")!.parentElement!.parentElement!;

    fireEvent.click(within(row).getByRole("button", { name: /publish now/i }));

    // Publish-now DOES broadcast to relays (unlike draft/schedule).
    await waitFor(() =>
      expect(mocked.createNostrBlogPost).toHaveBeenCalledTimes(1)
    );

    // And it fires the email broadcast at publish time.
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some((c) =>
          String(c[0]).includes("/api/email/broadcast-blog-post")
        )
      ).toBe(true)
    );

    // Then it cleans up the stored row.
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          (c) =>
            c[1]?.method === "DELETE" &&
            String(c[0]).includes("/scheduled-post")
        )
      ).toBe(true)
    );

    expect(await screen.findByText(/Post published\./i)).toBeInTheDocument();
  });

  test("publish-now without a verified sender domain skips the email", async () => {
    senderValid = false; // canEmail false
    scheduledList = [scheduledItem({ sendAsEmail: true })];

    renderPage();

    const card = await screen.findByText("Scheduled Title");
    const row = card.closest("div")!.parentElement!.parentElement!;

    fireEvent.click(within(row).getByRole("button", { name: /publish now/i }));

    await waitFor(() =>
      expect(mocked.createNostrBlogPost).toHaveBeenCalledTimes(1)
    );

    expect(
      fetchMock.mock.calls.some((c) =>
        String(c[0]).includes("/api/email/broadcast-blog-post")
      )
    ).toBe(false);
  });
});

describe("scheduled post health indicators (drafts & scheduled list)", () => {
  test("an overdue scheduled post shows the Retrying badge and the past-its-time line", async () => {
    scheduledList = [
      scheduledItem({
        scheduledAt: Math.floor(Date.now() / 1000) - 3600, // an hour ago
      }),
    ];

    renderPage();

    await screen.findByText("Scheduled Title");

    expect(await screen.findByText("Retrying")).toBeInTheDocument();
    expect(screen.getByText(/Past its scheduled time/i)).toBeInTheDocument();
    expect(screen.queryByText("Failed")).not.toBeInTheDocument();
  });

  test("a post with failed attempts shows Retrying plus the attempt count and last error", async () => {
    scheduledList = [
      scheduledItem({
        scheduledAt: Math.floor(Date.now() / 1000) - 3600,
        attemptCount: 2,
        lastError: "relay timed out",
        lastAttemptAt: Math.floor(Date.now() / 1000) - 300,
      }),
    ];

    renderPage();

    await screen.findByText("Scheduled Title");

    expect(await screen.findByText("Retrying")).toBeInTheDocument();
    expect(
      screen.getByText(/Last attempt failed \(2 so far\)/i)
    ).toBeInTheDocument();
    expect(screen.getByText(/relay timed out/i)).toBeInTheDocument();
  });

  test("a post past the failure threshold shows the Failed badge with red styling", async () => {
    scheduledList = [
      scheduledItem({
        scheduledAt: Math.floor(Date.now() / 1000) - 3600,
        attemptCount: 5,
        lastError: "mint unreachable",
      }),
    ];

    renderPage();

    await screen.findByText("Scheduled Title");

    const failedBadge = await screen.findByText("Failed");
    expect(failedBadge).toBeInTheDocument();
    // The badge carries the red styling so the warning reads as urgent.
    expect(failedBadge.className).toMatch(/text-red-900/);

    expect(
      screen.getByText(/Couldn't publish after 5 tries/i)
    ).toBeInTheDocument();
    expect(screen.getByText(/mint unreachable/i)).toBeInTheDocument();
    expect(screen.queryByText("Retrying")).not.toBeInTheDocument();
  });

  test("an on-track future-dated scheduled post shows no health warning", async () => {
    scheduledList = [
      scheduledItem({
        scheduledAt: Math.floor(Date.now() / 1000) + 3600, // an hour from now
      }),
    ];

    renderPage();

    await screen.findByText("Scheduled Title");

    expect(screen.queryByText("Retrying")).not.toBeInTheDocument();
    expect(screen.queryByText("Failed")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Past its scheduled time/i)
    ).not.toBeInTheDocument();
  });
});

describe("broadcastPost status banners (Email this post button)", () => {
  // Render the live-posts list with one post and click its "Email this post"
  // button, which routes through handleEmailExisting -> broadcastPost. The
  // returned note is surfaced in the success banner (or error banner on throw).
  async function emailLivePost() {
    senderValid = true; // verified sender domain -> canEmail true
    postsList = [livePost];
    (parseBlogPostEvent as jest.Mock).mockImplementation((e: any) => e);

    renderPage();

    const btn = await screen.findByTitle(
      "Email this post to the chosen audience"
    );
    fireEvent.click(btn);
    return btn;
  }

  function broadcastCallCount() {
    return fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes("/api/email/broadcast-blog-post")
    ).length;
  }

  test("reports the plural subscriber count on success", async () => {
    broadcastImpl.mockResolvedValue(
      jsonResponse({ sent: 3, total: 3, failed: 0, skipped: false })
    );

    await emailLivePost();

    expect(
      await screen.findByText("Emailed 3 subscribers.")
    ).toBeInTheDocument();
  });

  test("uses the singular noun when exactly one was emailed", async () => {
    broadcastImpl.mockResolvedValue(
      jsonResponse({ sent: 1, total: 1, failed: 0, skipped: false })
    );

    await emailLivePost();

    expect(
      await screen.findByText("Emailed 1 subscriber.")
    ).toBeInTheDocument();
  });

  test("appends the (N failed) note on a partial failure", async () => {
    broadcastImpl.mockResolvedValue(
      jsonResponse({ sent: 2, total: 3, failed: 1, skipped: false })
    );

    await emailLivePost();

    expect(
      await screen.findByText("Emailed 2 subscribers (1 failed).")
    ).toBeInTheDocument();
  });

  test("says there is no audience when total is zero", async () => {
    broadcastImpl.mockResolvedValue(
      jsonResponse({ sent: 0, total: 0, failed: 0, skipped: false })
    );

    await emailLivePost();

    expect(
      await screen.findByText("No audience emails to send to yet.")
    ).toBeInTheDocument();
  });

  test("skipped: no-verified-sender-domain points the seller at Email settings", async () => {
    broadcastImpl.mockResolvedValue(
      jsonResponse({ skipped: true, reason: "no-verified-sender-domain" })
    );

    await emailLivePost();

    expect(
      await screen.findByText(
        "Email not sent — verify a sender domain in Email settings first."
      )
    ).toBeInTheDocument();
  });

  test("skipped: already-sent reports the version was already emailed", async () => {
    broadcastImpl.mockResolvedValue(
      jsonResponse({ skipped: true, reason: "already-sent" })
    );

    await emailLivePost();

    expect(
      await screen.findByText("Email for this version was already sent.")
    ).toBeInTheDocument();
  });

  test("skipped: unsubscribe-unavailable reports email isn't configured", async () => {
    broadcastImpl.mockResolvedValue(
      jsonResponse({ skipped: true, reason: "unsubscribe-unavailable" })
    );

    await emailLivePost();

    expect(
      await screen.findByText(
        "Email not sent — email isn't fully configured yet."
      )
    ).toBeInTheDocument();
  });

  test("skipped: an unknown reason falls back to a generic not-sent note", async () => {
    broadcastImpl.mockResolvedValue(
      jsonResponse({ skipped: true, reason: "something-new" })
    );

    await emailLivePost();

    expect(await screen.findByText("Email not sent.")).toBeInTheDocument();
  });

  test("non-OK response surfaces the server error string", async () => {
    broadcastImpl.mockResolvedValue(
      jsonResponse({ error: "sender domain unverified" }, false, 500)
    );

    await emailLivePost();

    expect(
      await screen.findByText("Email not sent: sender domain unverified.")
    ).toBeInTheDocument();
  });

  test("non-OK response without an error uses the generic retry note", async () => {
    broadcastImpl.mockResolvedValue(jsonResponse({}, false, 500));

    await emailLivePost();

    expect(
      await screen.findByText(
        "Email not sent: please try again from the post list."
      )
    ).toBeInTheDocument();
  });

  test("a 409 retries once after the read-after-write settles", async () => {
    broadcastImpl
      .mockResolvedValueOnce(jsonResponse({}, false, 409))
      .mockResolvedValueOnce(
        jsonResponse({ sent: 5, total: 5, failed: 0, skipped: false })
      );

    await emailLivePost();

    // The retry path waits 1.5s before re-attempting, so allow extra time.
    expect(
      await screen.findByText("Emailed 5 subscribers.", undefined, {
        timeout: 4000,
      })
    ).toBeInTheDocument();
    expect(broadcastCallCount()).toBe(2);
  }, 10000);

  test("a thrown fetch falls through to the error banner", async () => {
    broadcastImpl.mockRejectedValue(new Error("network down"));

    await emailLivePost();

    expect(await screen.findByText("network down")).toBeInTheDocument();
  });
});
