import Head from "next/head";
import SeoPage from "@/components/seo/seo-page";
import { VS_PAGES } from "@/utils/seo/vs-pages";
import {
  buildSeoFaqJsonLd,
  makeSeoGetStaticPaths,
  makeSeoGetStaticProps,
} from "@/utils/seo/static-props";
import { safeJsonLdString } from "@/utils/safe-json-ld";
import type { SeoPageContent } from "@/utils/seo/model";

export const getStaticPaths = makeSeoGetStaticPaths(VS_PAGES);
export const getStaticProps = makeSeoGetStaticProps(VS_PAGES);

export default function VsPage({ page }: { page: SeoPageContent }) {
  const faqJsonLd = buildSeoFaqJsonLd(page);
  return (
    <>
      {faqJsonLd && (
        <Head>
          <script
            type="application/ld+json"
            dangerouslySetInnerHTML={{ __html: safeJsonLdString(faqJsonLd) }}
          />
        </Head>
      )}
      <SeoPage page={page} />
    </>
  );
}
