"use client";

import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { useTabs } from "@/components/hooks/use-tabs";
import { Framer } from "@/components/framer";
import Messages from "./messages";
import OrdersDashboard from "./orders-dashboard";
import SubscriptionManagement from "./subscription-management";
import ContactsDashboard from "./contacts-dashboard";
import EmailStatsDashboard from "./email-stats-dashboard";
import { useRouter } from "next/router";
import { SignerContext } from "@/components/utility-components/nostr-context-provider";
import { useProMembership } from "@/components/utility-components/pro-membership-context";
import { createNip98AuthorizationHeader } from "@/utils/nostr/nip98-auth";

const MessageFeed = ({
  isInquiry = false,
  initialTab,
  scopeToSellerPubkey,
  viewerRole,
}: {
  isInquiry?: boolean;
  initialTab?: string;
  scopeToSellerPubkey?: string;
  viewerRole?: "seller" | "buyer";
}) => {
  const router = useRouter();
  const [showSpinner, setShowSpinner] = useState(false);
  const { signer, pubkey, isLoggedIn } = useContext(SignerContext);
  const { isPro } = useProMembership();
  const [hasContacts, setHasContacts] = useState(false);
  const [hasEmailFlows, setHasEmailFlows] = useState(false);
  const appliedDeepTabRef = useRef(false);

  // Contacts tab is seller-only. When scoped to a stall, only show it if
  // the viewer is the seller on their own stall. Outside a scoped context,
  // show it whenever the signed-in user has captures.
  const isOwnerView = scopeToSellerPubkey
    ? viewerRole === "seller" && pubkey === scopeToSellerPubkey
    : isLoggedIn;
  const allowContactsTab = scopeToSellerPubkey
    ? viewerRole === "seller" && pubkey === scopeToSellerPubkey
    : true;

  useEffect(() => {
    if (!isOwnerView || !signer) {
      setHasContacts(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const url = `${window.location.origin}/api/storefront/popup-contacts`;
        const authHeader = await createNip98AuthorizationHeader(
          signer,
          url,
          "GET"
        );
        const res = await fetch("/api/storefront/popup-contacts", {
          method: "GET",
          headers: { Authorization: authHeader },
        });
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled && Array.isArray(data.contacts)) {
          setHasContacts(data.contacts.length > 0);
        }
      } catch {
        // silently ignore — tab just stays hidden
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOwnerView, signer]);

  // Email Stats tab is seller-only and shows once the seller has at least one
  // email flow. The flow listing is a public, read-only endpoint, so no auth is
  // needed just to decide whether to show the tab; the stats inside it are
  // NIP-98 authed separately.
  useEffect(() => {
    // Email analytics is a paid Herd feature, so only look it up (and surface
    // the tab) for an entitled seller viewing their own dashboard.
    if (!isOwnerView || !pubkey || !isPro) {
      setHasEmailFlows(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/email/flows?seller_pubkey=${encodeURIComponent(pubkey)}`
        );
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled && Array.isArray(data.flows)) {
          setHasEmailFlows(data.flows.length > 0);
        }
      } catch {
        // silently ignore — tab just stays hidden
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOwnerView, pubkey, isPro]);

  const hookProps = useMemo(
    () => ({
      tabs: [
        {
          label: "Orders",
          children: (
            <OrdersDashboard filterBySellerPubkey={scopeToSellerPubkey} />
          ),
          id: "orders",
        },
        {
          label: "Subscriptions",
          children: (
            <SubscriptionManagement
              filterBySellerPubkey={scopeToSellerPubkey}
            />
          ),
          id: "subscriptions",
        },
        {
          label: "Inquiries",
          children: (
            <Messages
              isPayment={false}
              filterByCounterpartyPubkey={scopeToSellerPubkey}
            />
          ),
          id: "inquiries",
        },
        ...(allowContactsTab && hasContacts
          ? [
              {
                label: "Contacts",
                children: <ContactsDashboard />,
                id: "contacts",
              },
            ]
          : []),
        ...(allowContactsTab && isPro && hasEmailFlows
          ? [
              {
                label: "Email Stats",
                children: <EmailStatsDashboard />,
                id: "email-stats",
              },
            ]
          : []),
      ],
      initialTabId: "orders",
    }),
    [hasContacts, hasEmailFlows, isPro, scopeToSellerPubkey, allowContactsTab]
  );

  const resolvedInitialTab = initialTab || (isInquiry ? "inquiries" : "orders");

  const framer = useTabs({
    tabs: hookProps.tabs,
    initialTabId: resolvedInitialTab,
  });

  useEffect(() => {
    setShowSpinner(true);
    const timeout = setTimeout(() => {
      setShowSpinner(false);
    }, 1);
    return () => clearTimeout(timeout);
  }, [framer.selectedTab]);

  useEffect(() => {
    const handleRouteChange = (url: string) => {
      const urlParams = new URLSearchParams(url.split("?")[1] || "");
      const tabParam = urlParams.get("tab");
      const isInquiryTab = url.includes("isInquiry=true");

      let newTab = "orders";
      if (tabParam && hookProps.tabs.some((t) => t.id === tabParam)) {
        newTab = tabParam;
      } else if (isInquiryTab) {
        newTab = "inquiries";
      }

      const newIndex = hookProps.tabs.findIndex((tab) => tab.id === newTab);
      if (newIndex !== -1 && framer.tabProps.selectedTabIndex !== newIndex) {
        framer.tabProps.setSelectedTab([newIndex, 0]);
      }
    };

    router.events.on("routeChangeComplete", handleRouteChange);

    return () => {
      router.events.off("routeChangeComplete", handleRouteChange);
    };
  }, [router, framer]);

  // Tabs that depend on async data (Email Stats, Contacts) don't exist on the
  // first render, so an initial ?tab=email-stats deep-link can't select them via
  // initialTabId. Once the requested tab appears, select it — but only once, so
  // we never fight a manual tab click later.
  useEffect(() => {
    if (appliedDeepTabRef.current) return;
    const desired =
      typeof router.query.tab === "string" ? router.query.tab : "";
    if (!desired) return;
    const idx = hookProps.tabs.findIndex((t) => t.id === desired);
    if (idx === -1) return;
    appliedDeepTabRef.current = true;
    if (framer.tabProps.selectedTabIndex !== idx) {
      framer.tabProps.setSelectedTab([idx, 0]);
    }
  }, [router.query.tab, hookProps.tabs, framer.tabProps]);

  return (
    <div className="flex w-full min-w-0 flex-1 flex-col">
      <div className="sticky inset-x-0 top-0 z-30 flex w-full translate-y-0 flex-col border-0 backdrop-blur-xl transition-all md:translate-y-0">
        <div className="w-full overflow-x-auto">
          <div className="flex flex-row items-center justify-center px-4">
            <Framer.Tabs {...framer.tabProps} />
          </div>
        </div>
      </div>

      <div className="flex w-full flex-1 flex-col bg-white pt-4">
        {showSpinner ? null : framer.selectedTab!.children}
      </div>
    </div>
  );
};

export default MessageFeed;
