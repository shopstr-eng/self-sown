import { ReactNode } from "react";
import SignInModal from "@/components/sign-in/SignInModal";
import { useAuthGuard } from "@/components/hooks/use-auth-guard";
import { useStorefrontBranding } from "@/utils/storefront/storefront-branding-context";

export default function ProtectedRoute({ children }: { children: ReactNode }) {
  const { isAuthResolved, isGuarded, isOpen, handleClose } = useAuthGuard();
  const sellerBranding = useStorefrontBranding();

  if (!isAuthResolved) {
    return <div className="min-h-screen bg-white" />;
  }

  if (isGuarded) {
    return (
      <SignInModal
        isOpen={isOpen}
        onClose={handleClose}
        sellerBranding={sellerBranding ?? undefined}
      />
    );
  }

  return <>{children}</>;
}
