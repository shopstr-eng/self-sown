import { useRouter } from "next/router";
import Link from "next/link";
import StorefrontLayout from "@/components/storefront/storefront-layout";
import StorefrontLoadError from "@/components/storefront/storefront-load-error";
import MilkMarketSpinner from "@/components/utility-components/mm-spinner";
import { useStorefrontLookup } from "@/utils/storefront/use-storefront-lookup";

export default function CustomDomainPage() {
  const router = useRouter();
  const { domain } = router.query;
  const domainStr = typeof domain === "string" ? domain : "";

  const { state, retry } = useStorefrontLookup({
    kind: "domain",
    value: domainStr,
    ready: router.isReady,
  });

  if (state.phase === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <MilkMarketSpinner />
      </div>
    );
  }

  if (state.phase === "error") {
    return <StorefrontLoadError onRetry={retry} label="shop" />;
  }

  if (state.phase === "not_found") {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center">
        <h1 className="text-3xl font-bold">Domain Not Configured</h1>
        <p className="mt-4 text-gray-500">
          This domain is not connected to any shop.
        </p>
        <Link
          href="https://milk.market"
          className="bg-primary-blue mt-6 rounded-lg px-6 py-3 font-bold text-white"
        >
          Visit Milk Market
        </Link>
      </div>
    );
  }

  return <StorefrontLayout shopPubkey={state.pubkey} />;
}
