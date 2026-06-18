import { useCallback, useContext, useState } from "react";
import { Button, Spinner } from "@heroui/react";
import {
  ArrowDownTrayIcon,
  ServerStackIcon,
  CheckCircleIcon,
  ExclamationCircleIcon,
} from "@heroicons/react/24/outline";
import { useRouter } from "next/router";
import ProtectedRoute from "@/components/utility-components/protected-route";
import { SettingsBreadCrumbs } from "@/components/settings/settings-bread-crumbs";
import { SignerContext } from "@/components/utility-components/nostr-context-provider";
import { ShopMapContext } from "@/utils/context/context";
import { useProMembership } from "@/components/utility-components/pro-membership-context";
import { getLocalStorageData } from "@/utils/nostr/nostr-helper-functions";
import {
  PRIMARYBUTTONCLASSNAMES,
  BLACKBUTTONCLASSNAMES,
} from "@/utils/STATIC-VARIABLES";

const BUNDLE_CONTENTS = [
  "milk-market.config.json — your store config (pubkey, slug, relays, Blossom servers, branding). No secrets.",
  ".env.example — environment template with placeholders only. Copy to .env and fill in.",
  "setup.sh — clones the public code and drops your config in place.",
  "README.md & SETUP.md — step-by-step instructions to get running.",
  "manifest.json — bundle details.",
];

const SelfHostPage = () => {
  const router = useRouter();
  const { pubkey } = useContext(SignerContext);
  const shopMapContext = useContext(ShopMapContext);
  const { membership, loading, exportSelfHostStore } = useProMembership();

  const [downloading, setDownloading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleDownload = useCallback(async () => {
    setError(null);
    setDone(false);
    setDownloading(true);
    try {
      const { relays, blossomServers } = getLocalStorageData();
      const shop = pubkey ? shopMapContext.shopData.get(pubkey) : undefined;
      const branding = shop?.content?.storefront ?? undefined;

      const { blob, filename } = await exportSelfHostStore({
        relays,
        blossomServers,
        branding,
      });

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setDone(true);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not download your bundle."
      );
    } finally {
      setDownloading(false);
    }
  }, [pubkey, shopMapContext.shopData, exportSelfHostStore]);

  return (
    <ProtectedRoute>
      <div className="flex min-h-screen flex-col bg-white pt-24 pb-20">
        <div className="mx-auto w-full px-4 lg:w-1/2 xl:w-2/5">
          <SettingsBreadCrumbs />

          {loading ? (
            <div className="flex justify-center py-12">
              <Spinner />
            </div>
          ) : !membership.isLifetime ? (
            <div className="shadow-neo mt-4 rounded-md border-2 border-black bg-white p-6">
              <div className="mb-3 flex items-center gap-3">
                <div className="bg-primary-blue rounded-md border-2 border-black p-2.5">
                  <ServerStackIcon className="h-5 w-5 text-white" />
                </div>
                <h2 className="text-xl font-bold text-black">
                  Run your own store
                </h2>
              </div>
              <p className="mb-4 text-sm text-gray-700">
                Self-hosting your store is a Wrangler (lifetime) feature. With
                Wrangler you can download a ready-to-run copy of your store that
                you host yourself — your marketplace stays private, and you take
                card payments through your own Stripe account with no platform
                fees.
              </p>
              <Button
                className={PRIMARYBUTTONCLASSNAMES}
                onPress={() => router.push("/pro")}
              >
                Get Wrangler
              </Button>
            </div>
          ) : (
            <div className="mt-4 space-y-6">
              <div className="shadow-neo rounded-md border-2 border-black bg-white p-6">
                <div className="mb-3 flex items-center gap-3">
                  <div className="bg-primary-blue rounded-md border-2 border-black p-2.5">
                    <ServerStackIcon className="h-5 w-5 text-white" />
                  </div>
                  <h2 className="text-xl font-bold text-black">
                    Self-Host Your Store
                  </h2>
                </div>
                <p className="text-sm text-gray-700">
                  Download a personalized setup bundle to run your own private
                  copy of your store. The marketplace and other sellers are
                  hidden — only your shop is served. You stay wired to the
                  public code so you can pull updates with{" "}
                  <code className="rounded bg-gray-100 px-1">git pull</code>.
                </p>
              </div>

              <div className="shadow-neo rounded-md border-2 border-black bg-white p-6">
                <h3 className="mb-3 text-base font-bold text-black">
                  What&apos;s in the bundle
                </h3>
                <ul className="space-y-2">
                  {BUNDLE_CONTENTS.map((item) => (
                    <li
                      key={item}
                      className="flex items-start gap-2 text-sm text-gray-700"
                    >
                      <CheckCircleIcon className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-4 text-xs text-gray-500">
                  Your bundle never includes secrets, API keys, or any other
                  seller&apos;s data — only your own public store settings.
                </p>
              </div>

              <div className="shadow-neo rounded-md border-2 border-black bg-white p-6">
                <h3 className="mb-3 text-base font-bold text-black">
                  How to run it
                </h3>
                <ol className="list-decimal space-y-1 pl-5 text-sm text-gray-700">
                  <li>Unzip the bundle and run setup.sh to get the code.</li>
                  <li>
                    Create a PostgreSQL database and apply{" "}
                    <code className="rounded bg-gray-100 px-1">
                      db/schema.sql
                    </code>
                    .
                  </li>
                  <li>
                    Copy{" "}
                    <code className="rounded bg-gray-100 px-1">
                      .env.example
                    </code>{" "}
                    to <code className="rounded bg-gray-100 px-1">.env</code>{" "}
                    and fill it in: set your database URL and public site URL,
                    generate an encryption key for uploads, and (optionally) add
                    your own Stripe keys to take card payments.
                  </li>
                  <li>
                    Run{" "}
                    <code className="rounded bg-gray-100 px-1">
                      pnpm install &amp;&amp; pnpm build &amp;&amp; pnpm start
                    </code>
                    .
                  </li>
                </ol>
                <p className="mt-3 text-xs text-gray-500">
                  Your copy shows only your storefront — the marketplace and the
                  platform&apos;s info, terms, and privacy pages are all hidden,
                  and even your settings use your storefront theme. Publish your
                  own terms, privacy, and return policy as storefront pages
                  using the page builder in Settings.
                </p>
                <p className="mt-3 text-xs text-gray-500">
                  Milk Market is open source under the AGPL/GPL v3. Full
                  instructions are inside the bundle.
                </p>
              </div>

              {error && (
                <div className="flex items-start gap-2 rounded-md border-2 border-red-500 bg-red-50 p-3 text-sm text-red-700">
                  <ExclamationCircleIcon className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>{error}</span>
                </div>
              )}
              {done && !error && (
                <div className="flex items-start gap-2 rounded-md border-2 border-green-600 bg-green-50 p-3 text-sm text-green-700">
                  <CheckCircleIcon className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    Your bundle is downloading. Check your downloads folder.
                  </span>
                </div>
              )}

              <Button
                className={BLACKBUTTONCLASSNAMES}
                startContent={
                  downloading ? undefined : (
                    <ArrowDownTrayIcon className="h-5 w-5" />
                  )
                }
                isLoading={downloading}
                onPress={handleDownload}
              >
                {downloading ? "Preparing bundle…" : "Download my store bundle"}
              </Button>
            </div>
          )}
        </div>
      </div>
    </ProtectedRoute>
  );
};

export default SelfHostPage;
