import { Html, Head, Main, NextScript } from "next/document";

export default function Document() {
  return (
    <Html lang="en">
      <Head>
        <script
          src="https://analytics.ahrefs.com/analytics.js"
          data-key="rwWnlkfh1u2od+FKCbb90w"
          async
        />
        <link rel="manifest" href="/manifest.json" />
        <meta name="theme-color" content="#ffffff" />
        <link
          rel="alternate"
          type="text/markdown"
          href="/llms.txt"
          title="llms.txt"
        />
        <link
          rel="alternate"
          type="text/markdown"
          href="/llms-full.txt"
          title="llms-full.txt"
        />
        <link
          rel="alternate"
          type="application/rss+xml"
          href="/rss.xml"
          title="Milk Market - Local Food Listings"
        />
      </Head>
      <body>
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
