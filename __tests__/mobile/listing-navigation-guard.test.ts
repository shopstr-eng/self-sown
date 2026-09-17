import {
  preventListingTabChange,
  registerListingTabGuard,
} from "../../apps/mobile/lib/listing-navigation-guard";

test("only the active editor can block a tab change and cleanup releases it", () => {
  const leave = jest.fn();
  expect(preventListingTabChange(leave)).toBe(false);
  const first = jest.fn(() => true);
  const removeFirst = registerListingTabGuard(first);
  expect(preventListingTabChange(leave)).toBe(true);
  expect(first).toHaveBeenCalledWith(leave);
  const second = jest.fn(() => false);
  const removeSecond = registerListingTabGuard(second);
  removeFirst();
  expect(preventListingTabChange(leave)).toBe(false);
  expect(second).toHaveBeenCalledWith(leave);
  removeSecond();
  expect(preventListingTabChange(leave)).toBe(false);
  expect(leave).not.toHaveBeenCalled();
});
