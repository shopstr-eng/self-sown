---
name: Sharp in Next standalone
description: Native Sharp/libvips packaging behavior in Next standalone builds under pnpm.
---

A successful Next standalone build does not prove Sharp is runnable. Under
pnpm, tracing can create Sharp's nested optional-package directories while
copying only some files, which prevents Node from falling through to complete
packages elsewhere in `node_modules`.

**Why:** The build and unit tests were green, but the first live image request
failed because the nested Sharp package context lacked the complete platform
package metadata and libvips shared library.

**How to apply:** After every standalone build, ensure each traced Sharp package
context contains complete platform-native packages, not only the `.node` file.
Verify by loading Sharp from the standalone working directory and by exercising
a real image conversion route. Keep the same deterministic repair in both
development and deployment build paths.