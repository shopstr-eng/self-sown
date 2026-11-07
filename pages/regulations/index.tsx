import { useRef, useState } from "react";
import Head from "next/head";
import Link from "next/link";
import { Button, Input, Spinner } from "@heroui/react";
import { PRIMARYBUTTONCLASSNAMES } from "@/utils/STATIC-VARIABLES";
import { joinClassNames } from "@/utils/class-names";
import { LEGAL_INFORMATION_DISCLAIMER } from "@/utils/regulations/schema";
import { regulationsChatLaunched } from "@/utils/regulations/golden-set";

interface Citation {
  url: string;
  title: string;
}

interface AgencyContact {
  agency_name: string;
  contact_url: string;
  phone: string | null;
  email: string | null;
}

interface ChatEntry {
  role: "user" | "assistant";
  content: string;
  status?: "answered" | "clarify" | "unknown";
  tier?: "statute_verified" | "agency_guidance" | null;
  citations?: Citation[];
  agencyContact?: AgencyContact | null;
  disclaimer?: string;
  isError?: boolean;
}

const SUGGESTIONS = [
  "Can I sell raw milk in Colorado?",
  "Can I sell jam at a farmers market in Texas?",
  "Can I ship cottage food interstate?",
];

const TIER_LABELS: Record<string, string> = {
  statute_verified: "Statute-verified",
  agency_guidance: "Agency guidance",
};

function asHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? value
      : null;
  } catch {
    return null;
  }
}

export default function RegulationsChatPage() {
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const transcriptRef = useRef<HTMLDivElement>(null);
  // Launch gate (P0 trust layer): the chat UI stays hidden until every
  // golden answer has documented attorney sign-off — the API enforces the
  // same gate server-side.
  const launched = regulationsChatLaunched();

  const send = async (preset?: string) => {
    const content = (preset ?? input).trim();
    if (!content || sending) return;
    setEntries((prev) => [...prev, { role: "user", content }]);
    setInput("");
    setSending(true);
    try {
      const response = await fetch("/api/regulations/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: content }),
      });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body?.error || "Request failed");
      }
      setEntries((prev) => [
        ...prev,
        {
          role: "assistant",
          content: body.message,
          status: body.status,
          tier: body.tier,
          citations: body.citations,
          agencyContact: body.agencyContact,
          disclaimer: body.disclaimer,
        },
      ]);
      setTimeout(
        () =>
          transcriptRef.current?.scrollTo({
            top: transcriptRef.current.scrollHeight,
          }),
        0
      );
    } catch {
      setEntries((prev) => [
        ...prev,
        {
          role: "assistant",
          content: "Something went wrong — please try again in a moment.",
          isError: true,
        },
      ]);
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <Head>
        <title>Food Regulation Answers | Self-Sown</title>
        <meta
          name="description"
          content="Ask what the food rules say where you sell. Every answer cites the statute or agency source it rests on — and when we don't know, we point you to the agency instead of guessing."
        />
      </Head>
      <div className="mx-auto max-w-3xl px-4 py-10">
        <h1 className="text-3xl font-bold text-black">
          What do the rules say where you sell?
        </h1>
        <p className="mt-2 text-sm text-zinc-600">
          Answers come from cited statutes and agency sources — never guesses.
          When a question isn&apos;t covered, you get the agency to ask instead
          of a made-up answer.
        </p>
        <p className="mt-3 rounded-md border-2 border-black bg-yellow-100 p-3 text-xs leading-relaxed text-zinc-800">
          <strong>Legal information, not legal advice.</strong>{" "}
          {LEGAL_INFORMATION_DISCLAIMER} See our{" "}
          <Link href="/terms" className="font-semibold text-blue-700 underline">
            Terms of Service
          </Link>
          .
        </p>

        {!launched && (
          <div className="shadow-neo mt-6 rounded-lg border-2 border-black bg-white p-6">
            <h2 className="text-lg font-bold text-black">
              In legal review — not live yet
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-zinc-700">
              Every answer this tool will give is being validated against the
              statutes by an independent food-law reviewer before it goes
              live. Until that review is complete, the chat stays off — we
              don&apos;t serve unreviewed legal information. In the meantime,
              your state department of agriculture is the authoritative
              contact for these questions.
            </p>
          </div>
        )}

        {launched && (
        <div className="shadow-neo mt-6 rounded-lg border-2 border-black bg-white">
          <div
            ref={transcriptRef}
            className="h-[55vh] space-y-4 overflow-y-auto p-4 md:p-6"
          >
            {entries.length === 0 && (
              <div className="space-y-3">
                <p className="text-sm text-zinc-600">
                  Ask about a product, a state, and how you want to sell. A few
                  things you can try:
                </p>
                <div className="flex flex-wrap gap-2">
                  {SUGGESTIONS.map((suggestion) => (
                    <button
                      key={suggestion}
                      onClick={() => void send(suggestion)}
                      className="rounded-full border-2 border-black bg-white px-3 py-1 text-xs font-medium text-black transition-colors hover:bg-yellow-200"
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {entries.map((entry, index) => (
              <div
                key={index}
                className={
                  entry.role === "user" ? "flex justify-end" : "flex justify-start"
                }
              >
                <div
                  className={joinClassNames(
                    "max-w-[85%] rounded-lg border-2 px-3 py-2",
                    entry.role === "user"
                      ? "border-black bg-black text-white"
                      : entry.isError
                        ? "border-red-600 bg-red-50 text-red-800"
                        : "border-black bg-zinc-50 text-zinc-800"
                  )}
                >
                  {entry.role === "assistant" && entry.tier && (
                    <span className="mb-1 inline-block rounded-full border border-black bg-yellow-200 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-black uppercase">
                      {TIER_LABELS[entry.tier] ?? entry.tier}
                    </span>
                  )}
                  <p className="text-sm leading-relaxed whitespace-pre-wrap">
                    {entry.content}
                  </p>

                  {entry.citations && entry.citations.length > 0 && (
                    <div className="mt-2 space-y-1 border-t border-zinc-300 pt-2">
                      <p className="text-xs font-semibold text-zinc-600">
                        Sources
                      </p>
                      {entry.citations.map((citation, citationIndex) => {
                        const url = asHttpUrl(citation.url);
                        return (
                          <p key={citationIndex} className="text-xs">
                            {url ? (
                              <a
                                href={url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="break-all text-blue-700 underline"
                              >
                                {citation.title}
                              </a>
                            ) : (
                              citation.title
                            )}
                          </p>
                        );
                      })}
                    </div>
                  )}

                  {entry.agencyContact && (
                    <div className="mt-2 rounded-md border-2 border-black bg-white p-2 text-xs text-zinc-800">
                      <p className="font-semibold">
                        Ask: {entry.agencyContact.agency_name}
                      </p>
                      <a
                        href={entry.agencyContact.contact_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="break-all text-blue-700 underline"
                      >
                        {entry.agencyContact.contact_url}
                      </a>
                      {entry.agencyContact.phone && (
                        <p>Phone: {entry.agencyContact.phone}</p>
                      )}
                      {entry.agencyContact.email && (
                        <p>Email: {entry.agencyContact.email}</p>
                      )}
                    </div>
                  )}

                  {entry.disclaimer && (
                    <p className="mt-2 border-t border-zinc-200 pt-1 text-[11px] text-zinc-500 italic">
                      {entry.disclaimer}
                    </p>
                  )}
                </div>
              </div>
            ))}

            {sending && (
              <div className="flex justify-start">
                <div className="flex items-center gap-2 rounded-lg border-2 border-black bg-white px-3 py-2 text-sm text-zinc-500">
                  <Spinner size="sm" /> Checking the sources…
                </div>
              </div>
            )}
          </div>

          <div className="flex gap-2 border-t-2 border-black p-3">
            <Input
              aria-label="Ask a food regulation question"
              placeholder="e.g. Can I sell raw milk in Colorado?"
              value={input}
              onValueChange={setInput}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
              isDisabled={sending}
              classNames={{
                inputWrapper: "border-2 border-black bg-white shadow-none",
              }}
            />
            <Button
              className={PRIMARYBUTTONCLASSNAMES}
              onPress={() => void send()}
              isDisabled={sending || !input.trim()}
            >
              Ask
            </Button>
          </div>
        </div>
        )}
      </div>
    </>
  );
}
