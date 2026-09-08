import { createSellerNotificationsHandler } from "@/utils/notifications/http-handlers";
import { notificationHandlerDependencies } from "@/utils/notifications/runtime";

export const config = { api: { bodyParser: { sizeLimit: "4kb" } } };
export default createSellerNotificationsHandler(
  "challenge",
  notificationHandlerDependencies
);
