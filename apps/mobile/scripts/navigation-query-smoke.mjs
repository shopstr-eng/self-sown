import assert from "node:assert/strict";
// Exercise the implementation Router actually uses, not the unrelated external
// React Navigation package. Load only the pure helpers (no native UI runtime).
const routerEntry = import.meta.resolve("expo-router/react-navigation");
const { getPathFromState } = await import(
  new URL("./build/react-navigation/core/getPathFromState.js", routerEntry)
);
const { getStateFromPath } = await import(
  new URL("./build/react-navigation/core/getStateFromPath.js", routerEntry)
);

const options = { screens: { Product: "product/:id" } };
const state = getStateFromPath("/product/42?ref=summer", options);

assert.equal(state?.routes[0]?.params?.ref, "summer");
assert.equal(
  getPathFromState(
    { routes: [{ name: "Product", params: { id: "42", ref: "summer" } }] },
    options
  ),
  "/product/42?ref=summer"
);
