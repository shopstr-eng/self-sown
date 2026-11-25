import { useInfiniteQuery } from "@tanstack/react-query";
import { useEffect } from "react";

import type { SellerSession } from "@self-sown/domain";

import {
  findSellerOrder,
  loadSellerOrdersPage,
  selectSellerOrders,
  sellerOrdersQueryKey,
} from "@/lib/order-query";
import {
  retryPendingMobileSellerOrderNotifications,
  sellerOrdersLoaderDependencies,
} from "@/lib/seller-order-runtime";

export function useSellerOrders(session: SellerSession | null) {
  useEffect(() => {
    if (!session) return;
    retryPendingMobileSellerOrderNotifications(session).catch((error) => {
      console.error("Failed to retry pending order notifications:", error);
    });
  }, [session]);

  const initialPageParam: string | null = null;
  return useInfiniteQuery({
    queryKey: sellerOrdersQueryKey(session?.pubkey ?? "signed-out"),
    enabled: Boolean(session),
    initialPageParam,
    queryFn: async ({ pageParam }: { pageParam: string | null }) => {
      if (!session) {
        throw new Error("Seller session is required.");
      }
      return loadSellerOrdersPage(
        session,
        sellerOrdersLoaderDependencies,
        pageParam
      );
    },
    getNextPageParam: (page) => page.nextCursor,
    select: selectSellerOrders,
    staleTime: 15_000,
    gcTime: 60_000,
  });
}

export function useSellerOrder(
  session: SellerSession | null,
  orderId: string | undefined
) {
  const ordersQuery = useSellerOrders(session);
  const order = orderId ? findSellerOrder(ordersQuery.data, orderId) : null;
  const { fetchNextPage, hasNextPage, isFetching, isFetchNextPageError } =
    ordersQuery;
  const hasOrderOrigin = order?.history.some(
    ({ subject }) =>
      subject === "order-info" ||
      subject === "order-payment" ||
      subject === "zapsnag-order"
  );
  const lookingForOrder = Boolean(orderId && !hasOrderOrigin && hasNextPage);

  useEffect(() => {
    if (lookingForOrder && !isFetching && !isFetchNextPageError) {
      void fetchNextPage();
    }
  }, [fetchNextPage, isFetching, isFetchNextPageError, lookingForOrder]);

  return { ordersQuery, order, lookingForOrder };
}
