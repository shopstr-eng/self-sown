/** @jest-environment node */

import {
  renderFlowEmail,
  replaceMergeTags,
  type MergeTagData,
} from "@/utils/email/flow-email-templates";

// enrollment_data is mutable JSON: the TS interface claims string values, but
// a malformed row can carry numbers, booleans, objects, or arrays. The
// templates must render (with coercion/fallback) instead of throwing
// "x.replace is not a function" and silently dropping the email.
describe("flow email templates with malformed merge data", () => {
  test("coerces numeric and boolean merge-tag values", () => {
    const out = replaceMergeTags("Hi {{buyer_name}}, order {{order_id}}", {
      buyer_name: 42,
      order_id: true,
    } as unknown as MergeTagData);
    expect(out).toBe("Hi 42, order true");
  });

  test("object-shaped values fall back to the merge-tag default", () => {
    const out = replaceMergeTags("Welcome to {{shop_name}}!", {
      shop_name: { name: "oops" },
    } as unknown as MergeTagData);
    expect(out).toBe("Welcome to Self-sown!");
  });

  test("array-shaped values with no default render empty, never throw", () => {
    const out = replaceMergeTags("[{{unknown_field}}]", {
      unknown_field: [1, 2, 3],
    } as unknown as MergeTagData);
    expect(out).toBe("[]");
  });

  test("renderFlowEmail survives a fully malformed enrollment_data payload", () => {
    const data = {
      buyer_name: { first: "Ada" },
      shop_name: ["not", "a", "string"],
      product_title: 99,
      order_id: null,
      product_image: undefined,
      shop_url: false,
    } as unknown as MergeTagData;

    let result: { subject: string; html: string } | undefined;
    expect(() => {
      result = renderFlowEmail(
        "You left {{product_title}} at {{shop_name}}",
        "<p>Hi {{buyer_name}}, your {{product_title}} ({{order_id}}) waits at {{shop_url}}.</p>",
        data
      );
    }).not.toThrow();

    // Numbers/booleans are coerced; objects/arrays/null drop to the default
    // (or empty when no default exists) — never "[object Object]".
    expect(result!.subject).toBe("You left 99 at Self-sown");
    expect(result!.html).toContain("your 99 () waits at false.");
    expect(result!.html).not.toContain("[object Object]");
    // The header/footer shop name fell back rather than rendering an object.
    expect(result!.html).toContain("Self-sown");
  });

  test("escapes coerced scalar values", () => {
    const out = replaceMergeTags("{{buyer_name}}", {
      buyer_name: "<script>alert(1)</script>",
    });
    expect(out).toContain("&lt;script&gt;");
    expect(out).not.toContain("<script>");
  });

  test("malformed storefront style colors don't kill the render", () => {
    expect(() =>
      renderFlowEmail("Hi {{buyer_name}}", "<p>body</p>", {}, {
        background: 123,
        secondary: { rgb: "0,0,0" },
        text: null,
        primary: true,
      } as never)
    ).not.toThrow();
  });
});
