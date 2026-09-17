type TabChangeGuard = (leave: () => void) => boolean;
let activeGuard: TabChangeGuard | undefined;

// Only the focused editor registers a guard. The tab navigator dispatches
// every tab press here; a listener on a child only sees its own tab presses.
export function registerListingTabGuard(guard: TabChangeGuard) {
  activeGuard = guard;
  return () => {
    if (activeGuard === guard) activeGuard = undefined;
  };
}
export function preventListingTabChange(leave: () => void): boolean {
  return activeGuard?.(leave) ?? false;
}
