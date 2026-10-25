import type { GetServerSideProps } from "next";

// The guide moved to /vendor-guide. Keep the old URL alive with a permanent
// redirect — it is indexed in Search Console, was submitted to Brave, and is
// linked from older copies of llms.txt and external shares.
export default function ProducerGuide() {
  return null;
}

export const getServerSideProps: GetServerSideProps = async () => ({
  redirect: {
    destination: "/vendor-guide",
    permanent: true,
  },
});
