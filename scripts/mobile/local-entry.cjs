// Copied only into a temporary native snapshot by prepare-native --fixtures.
// The normal mobile entry never imports this file.
require("./lib/install-crypto");
// Route every relay connection locally, including restored session relay lists
// and any workspace package copy resolved by Metro.
const NativeWebSocket = globalThis.WebSocket;
globalThis.WebSocket = class LocalFixtureWebSocket extends NativeWebSocket {
  constructor(url, protocols, options) {
    const isMetro = /^wss?:\/\/(127\.0\.0\.1|localhost):8081(?:\/|$)/.test(
      String(url)
    );
    super(isMetro ? url : "ws://127.0.0.1:5011", protocols, options);
  }
};
const { DEFAULT_SELLER_RELAYS } = require("@milk-market/domain");
DEFAULT_SELLER_RELAYS.splice(
  0,
  DEFAULT_SELLER_RELAYS.length,
  "ws://127.0.0.1:5011"
);
// Preserve the real picker, file reads, signing and HTTP body. Only redirect
// the public media provider to our local signature-checking fixture server.
const realFixtureFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  if (String(input) === "https://cdn.nostrcheck.me/upload")
    return realFixtureFetch("http://127.0.0.1:5012/upload", init);
  return realFixtureFetch(input, init);
};
require("expo-router/entry");
// Simulator injection needs OS permission, but production opt-in correctly
// refuses simulator token registration. This prompt exists only in fixtures.
require("expo-notifications").requestPermissionsAsync();
