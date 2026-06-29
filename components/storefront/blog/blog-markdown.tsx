"use client";

import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { isHttpUrl } from "@milk-market/domain";

// Renders a blog post's Markdown body. Raw HTML is NOT enabled (react-markdown
// strips it by default — we never add rehype-raw), and every link/image URL is
// http(s)-validated before it reaches an href/src because the underlying
// kind:30023 event is permissionless and attacker-controllable.
function safeUrl(url: string): string {
  return isHttpUrl(url) ? url : "";
}

export default function BlogMarkdown({ content }: { content: string }) {
  return (
    <div className="blog-markdown font-body max-w-none leading-relaxed">
      <Markdown
        remarkPlugins={[remarkGfm]}
        urlTransform={safeUrl}
        components={{
          h1: ({ children }) => (
            <h1 className="font-heading mt-8 mb-4 text-3xl font-bold">
              {children}
            </h1>
          ),
          h2: ({ children }) => (
            <h2 className="font-heading mt-8 mb-3 text-2xl font-bold">
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="font-heading mt-6 mb-2 text-xl font-bold">
              {children}
            </h3>
          ),
          p: ({ children }) => (
            <p className="my-4 text-base opacity-90 sm:text-lg">{children}</p>
          ),
          a: ({ href, children }) =>
            href ? (
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer nofollow ugc"
                className="font-semibold underline"
                style={{ color: "var(--sf-accent)" }}
              >
                {children}
              </a>
            ) : (
              <span>{children}</span>
            ),
          ul: ({ children }) => (
            <ul className="my-4 list-disc space-y-1 pl-6 opacity-90">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="my-4 list-decimal space-y-1 pl-6 opacity-90">
              {children}
            </ol>
          ),
          blockquote: ({ children }) => (
            <blockquote
              className="my-6 border-l-4 pl-4 italic opacity-80"
              style={{ borderColor: "var(--sf-accent)" }}
            >
              {children}
            </blockquote>
          ),
          code: ({ children }) => (
            <code className="rounded bg-black/10 px-1.5 py-0.5 font-mono text-sm">
              {children}
            </code>
          ),
          pre: ({ children }) => (
            <pre className="my-4 overflow-x-auto rounded-lg bg-black/90 p-4 text-sm text-white">
              {children}
            </pre>
          ),
          img: ({ src, alt }) =>
            typeof src === "string" && isHttpUrl(src) ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={src}
                alt={alt || ""}
                className="my-6 h-auto max-w-full rounded-lg"
                loading="lazy"
              />
            ) : null,
          hr: () => <hr className="my-8 border-black/10" />,
          table: ({ children }) => (
            <div className="my-6 overflow-x-auto">
              <table className="w-full border-collapse text-left text-sm">
                {children}
              </table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border-b-2 border-black/20 px-3 py-2 font-bold">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border-b border-black/10 px-3 py-2">{children}</td>
          ),
        }}
      >
        {content}
      </Markdown>
    </div>
  );
}
