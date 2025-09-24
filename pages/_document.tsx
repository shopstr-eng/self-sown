import { Html, Head, Main, NextScript } from "next/document";

export default function Document() {
  return (
    <Html lang="en">
      <Head>
        <link rel="icon" href="/milk-market.ico" />
        <link rel="apple-touch-icon" href="/milk-market.png" />
        <link rel="apple-touch-icon" sizes="152x152" href="/milk-market.png" />
        <link rel="apple-touch-icon" sizes="180x180" href="/milk-market.png" />
        <link rel="manifest" href="/manifest.json" />
        <meta name="theme-color" content="#ffffff" />
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
