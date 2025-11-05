import React from "react";
import { useRouter } from "next/router";
import MessageFeed from "@/components/messages/message-feed";

export default function MessageView() {
  const router = useRouter();
  const { isInquiry } = router.query;

  return (
    <div className="bg-light-bg flex min-h-screen flex-col pt-16">
      <MessageFeed
        {...(isInquiry !== undefined
          ? { isInquiry: isInquiry === "true" }
          : {})}
      />
    </div>
  );
}
