// Shared renderer for the /vs/*, /alternatives/*, /best/* pages.
// Content structure follows the rhinovoice.app/best/* layout: disclosure,
// comparison table, narrative, numbered picks, "our pick", action steps,
// FAQ, CTA. Styled in the site's neo-brutalist marketing-page language
// (grid bg, shadow-neo cards) per /terms and /producer-guide precedent.

import Link from "next/link";
import { useRouter } from "next/router";
import { WHITEBUTTONCLASSNAMES } from "@/utils/STATIC-VARIABLES";
import {
  PRICING_DISCLAIMER,
  SEO_CTA,
  type SeoPageContent,
} from "@/utils/seo/model";

export default function SeoPage({ page }: { page: SeoPageContent }) {
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
          <h1 className="text-4xl font-bold text-black md:text-5xl">
            {page.h1}
          </h1>
          <p className="mt-4 text-lg text-zinc-600 italic">{page.disclosure}</p>
        </div>

        <div className="space-y-4">
          {page.intro.map((p, i) => (
            <p key={i} className="text-lg leading-relaxed text-zinc-800">
              {p}
            </p>
          ))}
        </div>

        {page.table && (
          <div className="shadow-neo mt-8 overflow-x-auto rounded-lg border-2 border-black bg-white">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="bg-primary-yellow border-b-2 border-black">
                  {page.table.columns.map((c, i) => (
                    <th
                      key={i}
                      className="px-4 py-3 font-bold text-black"
                      scope="col"
                    >
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {page.table.rows.map((row, i) => (
                  <tr
                    key={i}
                    className="border-b border-zinc-200 last:border-0"
                  >
                    {row.map((cell, j) => (
                      <td
                        key={j}
                        className={`px-4 py-3 align-top ${
                          j === 0 ? "font-bold text-black" : "text-zinc-700"
                        }`}
                      >
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {page.sections.map((section, i) => (
          <section key={i} className="mt-10">
            <h2 className="mb-4 text-2xl font-bold text-black">
              {section.heading}
            </h2>
            <div className="space-y-4">
              {section.paragraphs?.map((p, j) => (
                <p key={j} className="text-lg leading-relaxed text-zinc-800">
                  {p}
                </p>
              ))}
            </div>
            {section.bullets && (
              <ul className="mt-3 list-disc space-y-2 pl-6 text-lg text-zinc-800">
                {section.bullets.map((b, j) => (
                  <li key={j}>{b}</li>
                ))}
              </ul>
            )}
          </section>
        ))}

        {page.picks && (
          <section className="mt-10">
            <h2 className="mb-6 text-2xl font-bold text-black">The picks</h2>
            <div className="space-y-6">
              {page.picks.map((pick, i) => (
                <article
                  key={i}
                  className={`shadow-neo rounded-lg border-2 border-black p-6 ${
                    pick.ours ? "bg-primary-yellow/20" : "bg-white"
                  }`}
                >
                  {/* H1 -> H2 ("The picks") -> H3 (pick name): sequential
                      heading order for crawlers; names are headings here
                      because each is a full section, not a list item. */}
                  <h3 className="text-xl font-bold text-black">
                    {i + 1}. {pick.name}
                  </h3>
                  <dl className="mt-3 space-y-1 text-sm">
                    <div className="flex gap-2">
                      <dt className="font-bold text-black">Best for:</dt>
                      <dd className="text-zinc-700">{pick.bestFor}</dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="font-bold text-black">Price:</dt>
                      <dd className="text-zinc-700">{pick.price}</dd>
                    </div>
                    {pick.fact && (
                      <div className="flex gap-2">
                        <dt className="font-bold text-black">
                          {pick.fact.label}:
                        </dt>
                        <dd className="text-zinc-700">{pick.fact.value}</dd>
                      </div>
                    )}
                  </dl>
                  <div className="mt-4 space-y-3">
                    {pick.paragraphs.map((p, j) => (
                      <p key={j} className="leading-relaxed text-zinc-800">
                        {p}
                      </p>
                    ))}
                  </div>
                  {pick.link &&
                    (pick.link.href.startsWith("/") ? (
                      <Link
                        href={pick.link.href}
                        className="text-primary-blue mt-4 inline-block font-bold underline"
                      >
                        {pick.link.label}
                      </Link>
                    ) : (
                      <a
                        href={pick.link.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary-blue mt-4 inline-block font-bold underline"
                      >
                        {pick.link.label}
                      </a>
                    ))}
                </article>
              ))}
            </div>
          </section>
        )}

        {page.myPick && (
          <section className="mt-10">
            <h2 className="mb-4 text-2xl font-bold text-black">Our pick</h2>
            <div className="space-y-4">
              {page.myPick.map((p, i) => (
                <p key={i} className="text-lg leading-relaxed text-zinc-800">
                  {p}
                </p>
              ))}
            </div>
          </section>
        )}

        {page.actionSteps && (
          <section className="mt-10">
            <h2 className="mb-4 text-2xl font-bold text-black">
              What to do today
            </h2>
            <ol className="list-decimal space-y-2 pl-6 text-lg text-zinc-800">
              {page.actionSteps.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ol>
          </section>
        )}

        {page.faq.length > 0 && (
          <section className="mt-10">
            <h2 className="mb-6 text-2xl font-bold text-black">Questions</h2>
            <div className="space-y-4">
              {page.faq.map((f, i) => (
                <div
                  key={i}
                  className="shadow-neo rounded-lg border-2 border-black bg-white p-6"
                >
                  <h3 className="text-lg font-bold text-black">{f.q}</h3>
                  <p className="mt-2 leading-relaxed text-zinc-700">{f.a}</p>
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="mt-10">
          <h2 className="mb-4 text-2xl font-bold text-black">Related</h2>
          <ul className="list-disc space-y-2 pl-6 text-lg">
            {page.related.map((r, i) => (
              <li key={i}>
                <Link
                  href={r.href}
                  className="text-primary-blue font-bold underline"
                >
                  {r.label}
                </Link>
              </li>
            ))}
          </ul>
        </section>

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

        <p className="mt-8 text-center text-sm text-zinc-500">
          {PRICING_DISCLAIMER}
        </p>
      </div>
    </div>
  );
}
