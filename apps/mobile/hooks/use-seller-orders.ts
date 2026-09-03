import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";

import type { SellerSession } from "@milk-market/domain";

import {
  findSellerOrder,
  loadSellerOrders,
  sellerOrdersQueryKey,
} from "@/lib/order-query";
import {
  retryPendingMobileSellerOrderNotifications,
  sellerOrdersLoaderDependencies,
} from "@/lib/seller-order-runtime";

export function useSellerOrders(session: SellerSession | null) {
  useEffect(() => {
    if (!session) return;
    void retryPendingMobileSellerOrderNotifications(session);
  }, [session]);

  return useQuery({
    queryKey: sellerOrdersQueryKey(session?.pubkey ?? "signed-out"),
    enabled: Boolean(session),
    queryFn: async () => {
      if (!session) {
        throw new Error("Seller session is required.");
      }
      return loadSellerOrders(session, sellerOrdersLoaderDependencies);
    },
    staleTime: 15_000,
    gcTime: 60_000,
  });
}

export function useSellerOrder(
  session: SellerSession | null,
  orderId: string | undefined
) {
  const ordersQuery = useSellerOrders(session);
  return {
    ordersQuery,
    order: orderId ? findSellerOrder(ordersQuery.data, orderId) : null,
  };
}
