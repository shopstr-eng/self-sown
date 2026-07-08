import { extractSiteSignals } from "@/utils/migrations/site-design-extractor";
import { safeFetch } from "@/utils/url-safety";

jest.mock("@/utils/url-safety", () => ({
  safeFetch: jest.fn(),
  SafeFetchError: class SafeFetchError extends Error {},
}));

const mockFetch = safeFetch as jest.Mock;

const fakeResponse = (
  body: string,
  url: string,
  contentType = "text/html"
) => ({
  ok: true,
  status: 200,
  url,
  headers: {
    get: (k: string) =>
      k.toLowerCase() === "content-type" ? contentType : null,
  },
  body: null,
  arrayBuffer: async () => new TextEncoder().encode(body).buffer,
});

const BASE = "https://steensma.example/";

const page = (bodyHtml: string, headHtml = "") =>
  `<!doctype html><html><head><title>Steensma Creamery</title>${headHtml}</head><body>${bodyHtml}</body></html>`;

const serve = (html: string, cssByUrl: Record<string, string> = {}) => {
  mockFetch.mockReset();
  mockFetch.mockImplementation(async (url: string) => {
    if (url === BASE) return fakeResponse(html, BASE);
    if (cssByUrl[url]) return fakeResponse(cssByUrl[url], url, "text/css");
    return fakeResponse("", url, "text/css");
  });
};

describe("extractSiteSignals image junk filter", () => {
  test("keeps real photos wrapped in lazy-load markup (class names never disqualify)", async () => {
    serve(
      page(`
        <img class="loader placeholder-image" data-src="/images/DSC09713.jpg" alt="Cows at pasture">
        <img data-src="/images/P1010037.JPG" class="thumb-image loader">
        <img src="/images/NMPF_Logo.png" alt="association">
        <img src="/images/farm-shed.jpg" alt="Our shop logo">
      `)
    );
    const signals = await extractSiteSignals(BASE);
    const urls = signals.images.map((i) => i.url);
    expect(urls).toContain(`${BASE}images/DSC09713.jpg`);
    expect(urls).toContain(`${BASE}images/P1010037.JPG`);
    // Filename says logo -> junk.
    expect(urls).not.toContain(`${BASE}images/NMPF_Logo.png`);
    // Alt says logo -> junk.
    expect(urls).not.toContain(`${BASE}images/farm-shed.jpg`);
  });

  test("records each image's source position", async () => {
    serve(
      page(`
        <img src="/a-first.jpg" alt="First">
        <p>middle</p>
        <img src="/b-second.jpg" alt="Second">
      `)
    );
    const signals = await extractSiteSignals(BASE);
    expect(signals.images).toHaveLength(2);
    expect(signals.images[0]!.pos).toBeLessThan(signals.images[1]!.pos!);
  });
});

describe("extractSiteSignals header theme", () => {
  test("detects an explicitly dark platform header theme", async () => {
    serve(
      page(
        `<header data-section-theme="black" class="header"><a href="/">Home</a></header><p>content</p>`
      )
    );
    const signals = await extractSiteSignals(BASE);
    expect(signals.headerTheme).toBe("dark");
  });

  test("detects a dark inline header background", async () => {
    serve(
      page(
        `<header style="background-color:#101010"><a href="/">Home</a></header>`
      )
    );
    const signals = await extractSiteSignals(BASE);
    expect(signals.headerTheme).toBe("dark");
  });

  test("stays undefined for a light header", async () => {
    serve(page(`<header class="header"><a href="/">Home</a></header>`));
    const signals = await extractSiteSignals(BASE);
    expect(signals.headerTheme).toBeUndefined();
  });
});

describe("extractSiteSignals testimonials", () => {
  test("collects quote-leading headings under a reviews heading, stripping quote marks and splitting trailing authors", async () => {
    serve(
      page(`
        <h2>Customer Reviews</h2>
        <h4>\u201cThe best raw milk we have ever had, truly outstanding.\u201d \u2014Alice</h4>
        <h4>\u201cOur family drives an hour every week just for this milk.\u201d</h4>
        <h4>\u201cCreamy, fresh \u2014 and the kids love it every single time.\u201d</h4>
      `)
    );
    const signals = await extractSiteSignals(BASE);
    expect(signals.testimonials).toBeDefined();
    expect(signals.testimonials!.heading).toBe("Customer Reviews");
    expect(signals.testimonials!.quotes).toHaveLength(3);
    expect(signals.testimonials!.quotes[0]).toEqual({
      quote: "The best raw milk we have ever had, truly outstanding.",
      author: "Alice",
    });
    expect(signals.testimonials!.quotes[1]!.author).toBeUndefined();
    // A dash INSIDE the quote (no closing quote before it) never splits.
    expect(signals.testimonials!.quotes[2]!.quote).toBe(
      "Creamy, fresh \u2014 and the kids love it every single time."
    );
    expect(signals.testimonials!.quotes[2]!.author).toBeUndefined();
    expect(signals.testimonials!.pos).toBeGreaterThan(0);
  });

  test("requires at least two quotes (a lone quoted heading is not a review wall)", async () => {
    serve(page(`<h4>\u201cA single stray quotation on the page.\u201d</h4>`));
    const signals = await extractSiteSignals(BASE);
    expect(signals.testimonials).toBeUndefined();
  });

  test("quote-leading headings do not become content-block headings", async () => {
    serve(
      page(`
        <h4>\u201cThe best raw milk we have ever had, truly outstanding.\u201d</h4>
        <p>This paragraph follows a testimonial quote and is long enough to count as body.</p>
        <h4>\u201cOur family drives an hour every week just for this milk.\u201d</h4>
      `)
    );
    const signals = await extractSiteSignals(BASE);
    expect(
      signals.contentBlocks.some((b) => b.heading.includes("best raw milk"))
    ).toBe(false);
  });
});

describe("extractSiteSignals content blocks", () => {
  test("pairs h4 headings with their paragraphs and records positions", async () => {
    serve(
      page(`
        <h4>Our Creamery</h4>
        <p>We bottle fresh raw milk every morning from our own herd of cows.</p>
        <h2>Visit Us</h2>
        <p>The farm store is open seven days a week from dawn until dusk daily.</p>
      `)
    );
    const signals = await extractSiteSignals(BASE);
    const headings = signals.contentBlocks.map((b) => b.heading);
    expect(headings).toContain("Our Creamery");
    expect(headings).toContain("Visit Us");
    const ours = signals.contentBlocks.find(
      (b) => b.heading === "Our Creamery"
    )!;
    const visit = signals.contentBlocks.find((b) => b.heading === "Visit Us")!;
    expect(ours.pos).toBeLessThan(visit.pos!);
  });
});

describe("extractSiteSignals platform stylesheets", () => {
  test("never fetches shared platform CSS but still fetches site CSS", async () => {
    const siteCss = `${BASE}assets/site.css`;
    serve(
      page(
        `<p>hello</p>`,
        `<link rel="stylesheet" href="https://assets.squarespace.com/universal/styles-compressed/commerce-abc.css">
         <link rel="stylesheet" href="https://definitions.sqspcdn.com/components/def.css">
         <link rel="stylesheet" href="https://static1.squarespace.com/static/versioned-site-css/abc/96/def/ghi/1804/site.css?nocustom=true">
         <link rel="stylesheet" href="https://static1.squarespace.com/static/vta/abc/versioned-assets/123-XYZ/static.css">
         <link rel="stylesheet" href="/assets/site.css">`
      ),
      { [siteCss]: "body { color: #123456; }" }
    );
    const signals = await extractSiteSignals(BASE);
    const fetched = mockFetch.mock.calls.map((c) => c[0] as string);
    expect(fetched).toContain(siteCss);
    expect(
      fetched.some(
        (u) => u.includes("assets.squarespace.com") || u.includes("sqspcdn.com")
      )
    ).toBe(false);
    expect(signals.colors).toContain("#123456");
  });
});
