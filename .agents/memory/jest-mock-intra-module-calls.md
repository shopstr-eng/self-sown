---
name: Jest module mocks can't reach intra-module calls
description: jest.mock replaces only the module's exports — real functions in that module still call their module-internal siblings, so stubbing one export doesn't affect another export that calls it.
---

# Jest module mocks can't reach intra-module calls

`jest.mock("@/utils/x", () => ({ ...jest.requireActual("@/utils/x"), foo: stub }))`
replaces only the **exported binding**. If the real `bar()` in the same module
calls `foo()` internally, it uses the module's own `foo`, not the stub — the
stub is invisible to it, and the test silently exercises the real dependency
(e.g. reading real env/fallback values).

**Why:** a test stubbed an env-reading getter via module mock, but the function
under test lived in the same module and called the getter internally, so the
stub never applied and the test failed for a reason unrelated to the code.

**How to apply:** when the function under test lives in the SAME module as the
dependency you want to stub, don't mock the module — stub what the dependency
actually reads (e.g. set the env var before calling, when the reader is
per-call). Reserve module mocks for cross-module seams.
