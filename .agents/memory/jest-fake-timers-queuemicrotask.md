---
name: Jest fake timers fake queueMicrotask
description: In suites using jest.useFakeTimers() (modern), queueMicrotask is also faked — test doubles must defer via native promise microtasks instead.
---

In a Jest suite that calls `jest.useFakeTimers()` (modern timers), `queueMicrotask` is faked along with `setTimeout`: callbacks scheduled with it never run unless the test advances timers, so any code path whose resolution depends on them deadlocks into a test timeout.

**Why:** a test double that emits events via `queueMicrotask` fails as a flaky-looking 5s timeout, not as an obvious scheduling error.

**How to apply:** inside test doubles (mock sockets, fake channels), schedule deferred callbacks with `Promise.resolve().then(...)` — native promise microtasks are not faked and still run during `await`. Reserve fake timers for the production code's own timers.
