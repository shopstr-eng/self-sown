---
name: jsdom PointerEvent polyfill for drag tests
description: fireEvent.pointer* in this jsdom setup drops clientY/pointerId — polyfill window.PointerEvent from MouseEvent before testing pointer-drag components.
---

In this repo's jest-environment-jsdom (30.x), `window.PointerEvent` is undefined, so `@testing-library/dom` fireEvent.pointerDown/Move/Up fall back to a bare Event and silently DROP `clientY`/`pointerId` init values. Drag handlers that read `event.clientY` then see `undefined` and the drag never registers — the failure looks like the component's logic is broken, not the test env.

**Why:** cost a debugging round on the floating-assistant drag test; the symptom (trailing click opening the panel) pointed at the component, but the component was correct in real browsers.

**How to apply:** in any jsdom test exercising pointer-drag UI, add a `beforeAll` polyfill: `class PointerEventPolyfill extends MouseEvent { pointerId = init.pointerId ?? 0 }` assigned to `window.PointerEvent`, plus stub `HTMLElement.prototype.setPointerCapture = jest.fn()` (jsdom lacks pointer capture too). See `__tests__/components/floating-assistant-widget.test.tsx` for the working pattern.
