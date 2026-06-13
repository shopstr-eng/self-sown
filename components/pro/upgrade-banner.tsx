import { Button, Card, CardBody } from "@heroui/react";
import { useRouter } from "next/router";
import { useProMembership } from "@/components/utility-components/pro-membership-context";

interface UpgradeBannerProps {
  /** Optional feature name to tailor the copy, e.g. "custom domains". */
  feature?: string;
  className?: string;
}

// Contextual nudge shown to non-Pro sellers near a gated feature. Renders
// nothing for sellers who are already entitled.
export default function UpgradeBanner({
  feature,
  className,
}: UpgradeBannerProps) {
  const router = useRouter();
  const { membership, loading } = useProMembership();

  if (loading || membership.isPro) return null;

  const title = feature
    ? `${feature} is a Herd feature`
    : "Unlock Milk Market Herd";

  const body =
    membership.isReadOnly || membership.isHidden
      ? "Your Herd plan has lapsed. Re-subscribe to restore your Herd features."
      : membership.status === "free"
        ? "Try Herd free for 30 days, no payment required, or go Wrangler for one-time lifetime access. Unlock advanced storefronts, custom domains, email flows, custom product pages, shipping labels, and the MCP API."
        : "Upgrade to use advanced storefronts, custom domains, email flows, custom product pages, shipping labels, and the MCP API.";

  return (
    <Card className={className} shadow="sm">
      <CardBody className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-base font-semibold">{title}</p>
          <p className="text-small text-default-500">{body}</p>
        </div>
        <Button
          color="primary"
          className="shrink-0"
          onPress={() => router.push("/pro")}
        >
          {membership.isReadOnly || membership.isHidden
            ? "Re-subscribe"
            : "Upgrade to Herd"}
        </Button>
      </CardBody>
    </Card>
  );
}
