import type { GetServerSideProps } from "next";

export default function Sell() {
  return null;
}

export const getServerSideProps: GetServerSideProps = async () => ({
  redirect: {
    destination: "/producer-guide",
    permanent: true,
  },
});
