// Shared SSG helpers for the /vs/[slug], /alternatives/[slug], /best/[slug]
// routes. Content is static, so everything pre-renders at build time.

import type { GetStaticPaths, GetStaticProps } from "next";
import type { SeoPageContent } from "./model";

export function makeSeoGetStaticPaths(
  pages: Record<string, SeoPageContent>
): GetStaticPaths {
  return () => ({
    paths: Object.keys(pages).map((slug) => ({ params: { slug } })),
    fallback: false,
  });
}

export function makeSeoGetStaticProps(
  pages: Record<string, SeoPageContent>
): GetStaticProps<{ page: SeoPageContent }> {
  return ({ params }) => {
    const slug = typeof params?.slug === "string" ? params.slug : "";
    const page = pages[slug];
    if (!page) return { notFound: true };
    return { props: { page } };
  };
}

/** FAQPage JSON-LD for the guide/comparison pages. */
export function buildSeoFaqJsonLd(
  page: SeoPageContent
): Record<string, unknown> | null {
  if (page.faq.length === 0) return null;
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: page.faq.map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: { "@type": "Answer", text: f.a },
    })),
  };
}
