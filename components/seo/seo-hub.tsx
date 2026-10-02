// Shared hub renderer for /vs, /alternatives, /best — a linked index of the
// pages in each family so every programmatic page is reachable by crawling
// (hub-and-spoke internal linking).

import Link from "next/link";
import { useRouter } from "next/router";
import { WHITEBUTTONCLASSNAMES } from "@/utils/STATIC-VARIABLES";
import { SEO_CTA } from "@/utils/seo/model";

export interface SeoHubLink {
  href: string;
  label: string;
  description: string;
}

export default function SeoHub({
  h1,
  blurb,
  links,
}: {
  h1: string;
  blurb: string;
  links: SeoHubLink[];
}) {
  const router = useRouter();
  return (
    <div className="bg-grid-pattern flex min-h-screen flex-col bg-white py-8 md:pb-20">
      <div className="container mx-auto max-w-4xl px-4">
        <div className="mb-10">
          <button
            onClick={() => router.back()}
            className={`${WHITEBUTTONCLASSNAMES} mb-8 flex items-center gap-2`}
          >
            <span aria-hidden="true" className="text-sm leading-none">
              ⬅️
            </span>
            Back
          </button>
          <h1 className="text-4xl font-bold text-black md:text-5xl">{h1}</h1>
          <p className="mt-4 text-lg text-zinc-600">{blurb}</p>
        </div>

        <div className="space-y-4">
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="shadow-neo block rounded-lg border-2 border-black bg-white p-6 transition-transform hover:-translate-y-0.5"
            >
              <h2 className="text-xl font-bold text-black">{l.label}</h2>
              <p className="mt-1 text-zinc-700">{l.description}</p>
            </Link>
          ))}
        </div>

        <section className="shadow-neo bg-primary-yellow mt-12 rounded-lg border-2 border-black p-8 text-center">
          <h2 className="text-2xl font-bold text-black">{SEO_CTA.heading}</h2>
          <p className="mx-auto mt-3 max-w-2xl text-lg text-zinc-800">
            {SEO_CTA.body}
          </p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-4">
            <Link
              href={SEO_CTA.buttonHref}
              className="shadow-neo inline-block rounded-lg border-2 border-black bg-black px-6 py-3 font-bold text-white transition-transform hover:-translate-y-0.5"
            >
              {SEO_CTA.buttonLabel}
            </Link>
            <Link
              href={SEO_CTA.secondaryHref}
              className="shadow-neo inline-block rounded-lg border-2 border-black bg-white px-6 py-3 font-bold text-black transition-transform hover:-translate-y-0.5"
            >
              {SEO_CTA.secondaryLabel}
            </Link>
          </div>
        </section>
      </div>
    </div>
  );
}
