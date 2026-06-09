---
name: Storefront overlay (modal/dropdown) theming coverage
description: Why themed modals/popups on custom stalls need their own class allowlist, separate from in-page .storefront-themed rules.
---

Modals, dropdowns and sign-in popups portal to HeroUI's `[data-overlay-container]` at the body root, OUTSIDE the in-page `.storefront-themed` subtree. So they are themed by a SEPARATE CSS block: `body.sf-active [data-overlay-container] .<class> { ... }` (the `sf-active` body class is toggled by StorefrontThemeWrapper when a Pro seller's custom stall/domain is active).

**Rule:** the overlay block is an explicit class allowlist and is easy to leave INCOMPLETE relative to the in-page `.storefront-themed` block. Any Tailwind color/utility a popup uses must be added to the overlay block too, or that surface keeps the base Milk Market look while the rest of the stall is themed.

**Why:** a "brand the sign-in flow" task only looked done because the common classes (bg-white→--sf-bg, text-black→--sf-text, border-black, shadow-neo, bg-primary-blue/yellow, fonts) were covered. But the flow's later steps used `text-gray-400/500/700`, `text-blue-600` (links), and `bg-gray-100/200` (the "------ or ------" divider), none of which were in the overlay block — so those bits stayed unthemed gray/blue inside an otherwise themed modal.

**How to apply:** when theming any overlay surface, grep the component for every color-ish class (`bg-/text-/border-` + number, plus `bg-white`/`text-black`/`text-blue-600`), then ensure each appears in the `body.sf-active [data-overlay-container]` block. Map grays to `color-mix(in srgb, var(--sf-text) N%, ...)`, blue links to `var(--sf-secondary)` / hover `var(--sf-accent)`. Leave deliberately-semantic colors (green success, yellow/red warnings, e.g. the recovery-key screen) un-themed. Note `hover:`/`active:` variants need their own escaped rules (`.hover\\:bg-...:hover`).
