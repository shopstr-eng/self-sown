import { createNotificationProcessorHandler } from "@/utils/notifications/processor-handler";
import {
  getNotificationRuntime,
  sellerPushEnabled,
} from "@/utils/notifications/runtime";
import { processSellerNotifications } from "@/utils/notifications/worker";
export const config = { api: { bodyParser: false }, maxDuration: 60 };
export default createNotificationProcessorHandler({
  secret: () => process.env.MOBILE_PUSH_PROCESSOR_SECRET ?? "",
  enabled: sellerPushEnabled,
  process: async () => {
    const runtime = await getNotificationRuntime();
    return processSellerNotifications({
      ...runtime,
      provider: runtime.provider(),
    });
  },
});
