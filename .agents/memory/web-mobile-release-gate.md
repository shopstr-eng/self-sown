---
name: Web and mobile release gate
description: User's release sequencing requirement for state-machine verification and the security review.
---

The user said: “I want to make sure all that is done and live for mobile and web before moving forward,” referring to implicit-to-explicit state machines, TLA modeling, and the DeepSec review.

**Why:** Completed task labels or merged source changes do not establish that the full requested coverage was delivered, findings were resolved, or the released applications contain the changes.

**How to apply:** Hold automatic store upload/release actions until the outstanding coverage and security gaps are resolved or the user explicitly changes this requirement. Distinguish inventory from implementation, bounded model checks from exhaustive correctness, a local scan from a completed DeepSec run, and merged code from verified web deployment and mobile artifacts.
