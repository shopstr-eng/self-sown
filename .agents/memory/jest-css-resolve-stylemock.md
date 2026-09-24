---
name: Jest maps ALL .css resolution to styleMock
description: under next/jest, even createRequire(...).resolve("pkg/file.css") returns next's styleMock.js — load real CSS by path, not by resolve.
---

Under next/jest, the patched module resolution maps every `.css` module id to next's `styleMock.js` — including `createRequire(__filename).resolve("tailwindcss/index.css")` inside a test. Anything that reads the resolved path as CSS gets JS (`"use strict"` → CssSyntaxError) instead.

**Why:** next/jest installs the CSS → styleMock mapping globally for the Jest module system, and it leaks into Node-resolution calls made from test code.

**How to apply:** when test code needs the real contents of a `.css` file from node_modules (e.g. feeding `tailwindcss` compile() a `loadStylesheet`), resolve the package's `package.json` and `path.join` the CSS filename manually — never `require.resolve` the `.css` id itself.
