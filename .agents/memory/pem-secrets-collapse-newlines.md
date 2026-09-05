---
name: Pasted PEM keys arrive newline-collapsed
description: Replit secret input collapses multi-line pastes (e.g. .p8/PEM keys) to a single space-joined line — normalize at the consumption site
---

# Pasted PEM keys arrive newline-collapsed

A user pasting a multi-line secret (PEM/PKCS#8 key like Apple's `.p8`) into the Replit secrets form may produce a SINGLE line with spaces where the newlines were — no literal `\n`, no real newlines. Node's `crypto.sign` then fails with `error:1E08010C:DECODER routines::unsupported`.

**Why:** verified with the real APPLE_PRIVATE_KEY (Sept 2026): 257 chars, one line, markers present, space-separated base64 segments. Diagnose structurally (length/markers/line count), never print key material.

**How to apply:** any code consuming a pasted PEM-ish secret must normalize at the consumption site — strip surrounding quotes, convert literal `\n`, and for single-line input extract the body between the BEGIN/END markers, strip all whitespace, and re-wrap at 64 chars. Unrecognized shapes must fall through to a loud signer error (see normalizeApplePrivateKey in pages/api/auth/oauth-callback.ts). Ask for re-pastes only after that.
