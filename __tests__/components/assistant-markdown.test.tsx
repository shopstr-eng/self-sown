/** @jest-environment jsdom */

import { render } from "@testing-library/react";

// react-markdown and remark-gfm are ESM-only and crash Jest's CJS loader (the
// transform allowlist intentionally stays small — see jest.config.cjs). The
// upstream renderer's correctness is its own tested domain; this suite
// verifies OUR wrapper's contract: raw Markdown content flows through, GFM is
// enabled, and the URL transform strips non-http(s) URLs.
const mockMarkdownProps: { current: Record<string, unknown> | null } = {
  current: null,
};

jest.mock("react-markdown", () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => {
    mockMarkdownProps.current = props;
    return <div data-testid="markdown">{props.children as string}</div>;
  },
}));

jest.mock("remark-gfm", () => ({ __esModule: true, default: "gfm" }));

import AssistantMarkdown from "@/components/assistant/assistant-markdown";

describe("AssistantMarkdown", () => {
  it("passes raw Markdown content through with GFM enabled", () => {
    render(<AssistantMarkdown content={"**bold**\n\n- one\n- two"} />);
    expect(mockMarkdownProps.current?.children).toBe(
      "**bold**\n\n- one\n- two"
    );
    expect(mockMarkdownProps.current?.remarkPlugins).toEqual(["gfm"]);
  });

  it("strips non-http(s) URLs and keeps real links", () => {
    render(<AssistantMarkdown content="x" />);
    const urlTransform = mockMarkdownProps.current?.urlTransform as (
      url: string
    ) => string;
    expect(urlTransform).toBeInstanceOf(Function);
    expect(urlTransform("javascript:alert(1)")).toBe("");
    expect(urlTransform("data:text/html,<script>alert(1)</script>")).toBe("");
    expect(urlTransform("https://selfsown.com/path")).toBe(
      "https://selfsown.com/path"
    );
    expect(urlTransform("http://example.com")).toBe("http://example.com");
  });

  it("does not enable raw HTML rendering", () => {
    render(<AssistantMarkdown content="<script>alert(1)</script>" />);
    // No rehypePlugins prop — rehype-raw is never added, so react-markdown
    // escapes raw HTML (its default) and hostile markup renders as text.
    expect(mockMarkdownProps.current?.rehypePlugins).toBeUndefined();
    expect(mockMarkdownProps.current?.children).toBe(
      "<script>alert(1)</script>"
    );
  });
});
