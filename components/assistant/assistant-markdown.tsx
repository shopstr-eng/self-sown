import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { isHttpUrl } from "@self-sown/domain";

// Assistant replies are LLM-generated Markdown; rendering them raw shows
// literal ** and ## to the user. Same sanitization discipline as blog posts
// (the model quotes permissionless listing content): no raw HTML, and only
// real http(s) URLs survive into links.
function safeUrl(url: string): string {
  return isHttpUrl(url) ? url : "";
}

// Kept in its own module (not inline in assistant-chat) so tests can import it
// without pulling the chat's session/Nostr dependency chain into Jest.
export default function AssistantMarkdown({ content }: { content: string }) {
  return (
    <div className="text-sm leading-relaxed">
      <Markdown
        remarkPlugins={[remarkGfm]}
        urlTransform={safeUrl}
        components={{
          p: ({ children }) => (
            <p className="my-1.5 first:mt-0 last:mb-0">{children}</p>
          ),
          a: ({ href, children }) =>
            href ? (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                className="font-semibold underline"
              >
                {children}
              </a>
            ) : (
              <span>{children}</span>
            ),
          ul: ({ children }) => (
            <ul className="my-1.5 list-disc space-y-0.5 pl-5">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="my-1.5 list-decimal space-y-0.5 pl-5">{children}</ol>
          ),
          h1: ({ children }) => (
            <h3 className="mt-2 mb-1 text-base font-bold">{children}</h3>
          ),
          h2: ({ children }) => (
            <h3 className="mt-2 mb-1 text-base font-bold">{children}</h3>
          ),
          h3: ({ children }) => (
            <h3 className="mt-2 mb-1 text-base font-bold">{children}</h3>
          ),
          blockquote: ({ children }) => (
            <blockquote className="my-1.5 border-l-2 border-black/20 pl-2 italic">
              {children}
            </blockquote>
          ),
          code: ({ children }) => (
            <code className="rounded bg-black/10 px-1 py-0.5 font-mono text-[13px]">
              {children}
            </code>
          ),
          pre: ({ children }) => (
            <pre className="my-2 overflow-x-auto rounded-md bg-black/90 p-2.5 text-[13px] text-white">
              {children}
            </pre>
          ),
          hr: () => <hr className="my-2 border-black/10" />,
          table: ({ children }) => (
            <div className="my-2 overflow-x-auto">
              <table className="w-full border-collapse text-left text-xs">
                {children}
              </table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border-b-2 border-black/20 px-2 py-1 font-bold">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border-b border-black/10 px-2 py-1">{children}</td>
          ),
        }}
      >
        {content}
      </Markdown>
    </div>
  );
}
