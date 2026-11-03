// Tiny pub/sub so a completed Stripe Connect flow (the browser-sheet return
// handled on the dashboard) can wake the Terminal SDK initializer inside an
// already-mounted TapToPayProvider. Without it, a provider mounted before
// connect (e.g. the Sell tab's) would stay uninitialized until a remount and
// the seller would hit the SDK's opaque "first initialize" error despite
// having just connected Stripe.
const listeners = new Set<() => void>();

export function requestTerminalSdkInit(): void {
  for (const listener of Array.from(listeners)) listener();
}

export function onTerminalSdkInitRequested(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
