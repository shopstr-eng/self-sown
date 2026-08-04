---
name: Invoice card dual Order Summary panes
description: product-invoice-card.tsx renders TWO near-identical Order Summary blocks; any order-summary display change must patch both
---

`components/product-invoice-card.tsx` renders two near-identical "Order Summary" blocks: one in the `showInvoiceCard` branch (~line 5760) and one in the main return (~line 6130). Same content, DIFFERENT indentation (16 vs 14 spaces), so an Edit anchored on one will not match the other.

**Why:** Adding the "ships out in X days" line to only one pane would have shown it for one payment path and silently dropped it for the other. The blocks drift easily because nothing structural forces them to stay in sync.

**How to apply:** Before touching anything in the invoice order summary (product info lines, cost breakdown, badges), `grep -n "Order Summary" components/product-invoice-card.tsx` and patch BOTH blocks, watching the indentation difference when writing edit anchors.
