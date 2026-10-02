import Head from "next/head";
import SeoPage from "@/components/seo/seo-page";
import { GUIDES } from "@/utils/seo/guides";
import {
  buildSeoFaqJsonLd,
  makeSeoGetStaticPaths,
  makeSeoGetStaticProps,
} from "@/utils/seo/static-props";
import { safeJsonLdString } from "@/utils/safe-json-ld";
import type { SeoPageContent } from "@/utils/seo/model";

export const getStaticPaths = makeSeoGetStaticPaths(GUIDES);
export const getStaticProps = makeSeoGetStaticProps(GUIDES);

export default function BestGuidePage({ page }: { page: SeoPageContent }) {
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
