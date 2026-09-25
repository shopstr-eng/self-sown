import { useContext, useEffect, useRef, useState } from "react";
import { Button, Input, Spinner } from "@heroui/react";
import { SignerContext } from "@/components/utility-components/nostr-context-provider";
import { createNip98AuthorizationHeader } from "@/utils/nostr/nip98-auth";
import { PRIMARYBUTTONCLASSNAMES } from "@/utils/STATIC-VARIABLES";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface AssistantAction {
  tool: string;
  ok: boolean;
  detail: string;
}

interface DisplayMessage extends ChatMessage {
  actions?: AssistantAction[];
  isError?: boolean;
}

interface AssistantChatProps {
  onWritesStateChange?: (writesEnabled: boolean) => void;
  // Fill the parent container (floating widget) instead of the settings
  // page's fixed-height, self-bordered card.
  fillHeight?: boolean;
  // "buyer" = the storefront shopping assistant for guests/buyers on a custom
  // stall: unauthenticated, public catalog tools only, stallPubkey required.
  buyerMode?: { stallPubkey: string };
}

const SUGGESTIONS = [
  "What orders are waiting on me?",
  "Add a new listing for raw honey, 1 lb jar, $12",
  "Which products are low on stock?",
  "Pause my email flows while I'm on vacation",
];

const BUYER_SUGGESTIONS = [
  "What do you sell?",
  "What's popular right now?",
  "Do you have any discount codes?",
  "Tell me about this shop",
];

export default function AssistantChat({
  onWritesStateChange,
  fillHeight = false,
  buyerMode,
}: AssistantChatProps) {
  const { signer } = useContext(SignerContext);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const transcriptRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    transcriptRef.current?.scrollTo({
      top: transcriptRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, sending]);

  const send = async (raw?: string) => {
    const content = (raw ?? input).trim();
    // Buyer mode is unauthenticated (guests have no signer); seller mode
    // signs every request.
    if (!content || sending || (!buyerMode && !signer)) return;

    // The signed NIP-98 payload hash must cover exactly this body string.
    const history: ChatMessage[] = [
      ...messages.map(({ role, content: c }) => ({ role, content: c })),
      { role: "user", content },
    ];
    setMessages((prev) => [...prev, { role: "user", content }]);
    setInput("");
    setSending(true);

    try {
      const url = `${window.location.origin}/api/assistant/chat`;
      const body = JSON.stringify(
        buyerMode
          ? { messages: history, context: { stallPubkey: buyerMode.stallPubkey } }
          : { messages: history }
      );
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (!buyerMode && signer) {
        headers["Authorization"] = await createNip98AuthorizationHeader(
          signer,
          url,
          "POST",
          body
        );
      }
      const res = await fetch(url, { method: "POST", headers, body });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content:
              (data as { error?: string }).error ||
              `Request failed (${res.status})`,
            isError: true,
          },
        ]);
        return;
      }

      if (typeof data.writesEnabled === "boolean") {
        onWritesStateChange?.(data.writesEnabled);
      }
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: data.reply || "Done.",
          actions: Array.isArray(data.actions) ? data.actions : [],
        },
      ]);
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: "Network error — check your connection and try again.",
          isError: true,
        },
      ]);
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      className={
        fillHeight
          ? "flex h-full min-h-0 flex-col bg-white"
          : "shadow-neo rounded-lg border-2 border-black bg-white"
      }
    >
      <div
        ref={transcriptRef}
        className={
          fillHeight
            ? "min-h-0 flex-1 space-y-4 overflow-y-auto p-4"
            : "h-[55vh] space-y-4 overflow-y-auto p-4 md:p-6"
        }
      >
        {messages.length === 0 && (
          <div className="space-y-3">
            <p className="text-sm text-zinc-600">
              {buyerMode
                ? "Ask me about this shop's products, reviews, or discount codes. A few things you can try:"
                : "Ask about your orders, listings, stock, discounts, or analytics — or tell me to make a change. A few things you can try:"}
            </p>
            <div className="flex flex-wrap gap-2">
              {(buyerMode ? BUYER_SUGGESTIONS : SUGGESTIONS).map((suggestion) => (
                <button
                  key={suggestion}
                  onClick={() => send(suggestion)}
                  className="rounded-full border-2 border-black bg-white px-3 py-1 text-xs font-medium text-black transition-colors hover:bg-yellow-200"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((message, index) => (
          <div
            key={index}
            className={
              message.role === "user"
                ? "flex justify-end"
                : "flex justify-start"
            }
          >
            <div
              className={`max-w-[85%] rounded-lg border-2 px-3 py-2 ${
                message.role === "user"
                  ? "border-black bg-black text-white"
                  : message.isError
                    ? "border-red-600 bg-red-50 text-red-800"
                    : "border-black bg-zinc-50 text-zinc-800"
              }`}
            >
              <p className="text-sm leading-relaxed whitespace-pre-wrap">
                {message.content}
              </p>
              {message.actions && message.actions.length > 0 && (
                <div className="mt-2 space-y-1 border-t border-zinc-300 pt-2">
                  {message.actions.map((action, actionIndex) => (
                    <div
                      key={actionIndex}
                      className="flex items-center gap-2 text-xs text-zinc-600"
                    >
                      <span aria-hidden="true">{action.ok ? "✅" : "⚠️"}</span>
                      <span className="font-mono">{action.tool}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}

        {sending && (
          <div className="flex justify-start">
            <div className="flex items-center gap-2 rounded-lg border-2 border-black bg-white px-3 py-2 text-sm text-zinc-500">
              <Spinner size="sm" /> Working…
            </div>
          </div>
        )}
      </div>

      <div className="flex gap-2 border-t-2 border-black p-3">
        <Input
          aria-label="Message the assistant"
          placeholder={
            buyerMode ? "Ask about this shop…" : "Ask or tell me to do something…"
          }
          value={input}
          onValueChange={setInput}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              send();
            }
          }}
          isDisabled={sending}
          classNames={{
            inputWrapper: "border-2 border-black bg-white shadow-none",
          }}
        />
        <Button
          className={PRIMARYBUTTONCLASSNAMES}
          onPress={() => send()}
          isDisabled={sending || !input.trim()}
        >
          Send
        </Button>
      </div>
    </div>
  );
}
