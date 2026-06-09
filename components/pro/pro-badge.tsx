import { Chip } from "@heroui/react";

interface ProBadgeProps {
  size?: "sm" | "md" | "lg";
  variant?: "trial" | "active" | "lifetime";
  className?: string;
}

// Small membership marker. Use `variant="trial"` for a trialing seller and
// `variant="lifetime"` for a Wrangler lifetime member.
export default function ProBadge({
  size = "sm",
  variant = "active",
  className,
}: ProBadgeProps) {
  const label =
    variant === "trial"
      ? "Herd trial"
      : variant === "lifetime"
        ? "Wrangler"
        : "Herd";
  return (
    <Chip
      size={size}
      color={variant === "trial" ? "warning" : "success"}
      variant="flat"
      className={className}
    >
      {label}
    </Chip>
  );
}
