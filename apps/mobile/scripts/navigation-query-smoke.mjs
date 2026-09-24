import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const nativeEntry = import.meta.resolve("@react-navigation/native");
const coreEntry = createRequire(nativeEntry).resolve("@react-navigation/core");
const { getPathFromState, getStateFromPath } = await import(
  pathToFileURL(coreEntry)
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
