---
name: Body is the scroll container
description: globals.css makes <body> scroll, not the viewport — window.scrollY stays 0 and window scroll listeners never fire
---

styles/globals.css sets `html { overflow: hidden }` and `body { overflow-y: auto; overflow-x: hidden }`, so `<body>` is the page's scroll container.

**Rule:** any scroll-position logic (nav state, scroll-spy, infinite scroll, back-to-top) must not listen on `window` or read only `window.scrollY`. Listen on `document` with `{ capture: true }` (scroll doesn't bubble but does capture) and read `Math.max(window.scrollY, documentElement.scrollTop, body.scrollTop)`.

**Why:** a fixed transparent-to-white landing nav worked in the anchor-jump screenshot test but not in live use — window.scrollY stayed 0 forever. Found via user bug report after shipping.

**How to apply:** any time you write a scroll handler in this codebase. Related: [landing-mobile-overflow](landing-mobile-overflow.md) covers the sibling symptom (overflow-x complaints = fixed-width clipping). Verify scrolled state via a `/#anchor` URL screenshot — the initial effect call reads body.scrollTop > 0 after the anchor jump.
