/** @jest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { readFileSync } from "node:fs";
import path from "node:path";

const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});
afterAll(() => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
});

jest.mock(
  "react-native",
  () => ({
    Alert: { alert: jest.fn() },
    Platform: {
      OS: "web",
      select: (options: Record<string, unknown>) =>
        options.web ?? options.default,
    },
    I18nManager: { isRTL: false },
    StyleSheet: {
      create: (value: unknown) => value,
      flatten: (value: unknown) => value,
    },
    Dimensions: { get: () => ({ width: 400, height: 800 }) },
    Animated: { createAnimatedComponent: (component: unknown) => component },
    Pressable: "button",
    View: "div",
    Text: "span",
    Image: "img",
  }),
  { virtual: true }
);
jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: jest.fn() }),
}));
jest.mock("react-native-safe-area-context", () => ({}), { virtual: true });
jest.mock(
  "../../lib/listing-navigation-guard",
  () => jest.requireActual("../../apps/mobile/lib/listing-navigation-guard"),
  { virtual: true }
);

// Load the real compatibility exports: none of these navigation hooks or
// providers may be mocked, because provider identity is the regression.
const navigation = require("../../apps/mobile/node_modules/expo-router/react-navigation");
const {
  useListingEditorNavigation,
} = require("../../apps/mobile/hooks/use-listing-editor-navigation");
const {
  usePosUnseenOutcome,
} = require("../../apps/mobile/lib/pos-outcome-store");

test("listing and payment hooks share Router's real navigation and theme contexts", async () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  const listeners = new Map<string, Set<Function>>();
  const screenNavigation = {
    setOptions: jest.fn(),
    dispatch: jest.fn(),
    goBack: jest.fn(),
    isFocused: () => true,
    addListener: (event: string, listener: Function) => {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
      return () => set.delete(listener);
    },
  };
  function Probe() {
    useListingEditorNavigation(true, false);
    usePosUnseenOutcome();
    const theme = navigation.useTheme();
    return <span>{theme.colors.primary}</span>;
  }
  const theme = {
    ...navigation.DefaultTheme,
    colors: { ...navigation.DefaultTheme.colors, primary: "#0D4B3E" },
  };
  try {
    await act(async () => {
      root.render(
        <navigation.ThemeProvider value={theme}>
          <navigation.NavigationContext.Provider value={screenNavigation}>
            <navigation.NavigationRouteContext.Provider
              value={{ key: "listing", name: "listing" }}
            >
              <navigation.PreventRemoveContext.Provider
                value={{
                  preventedRoutes: {},
                  setPreventRemove: jest.fn(),
                }}
              >
                <Probe />
              </navigation.PreventRemoveContext.Provider>
            </navigation.NavigationRouteContext.Provider>
          </navigation.NavigationContext.Provider>
        </navigation.ThemeProvider>
      );
    });
    expect(host.textContent).toBe("#0D4B3E");
    expect(screenNavigation.setOptions).toHaveBeenCalledWith({
      gestureEnabled: false,
    });
    expect(listeners.has("beforeRemove")).toBe(true);
  } finally {
    await act(async () => root.unmount());
  }
});

test("all application navigation consumers use Router's compatibility exports", () => {
  for (const file of [
    "components/app-providers.tsx",
    "hooks/use-listing-editor-navigation.ts",
    "lib/pos-outcome-store.ts",
    "app/(tabs)/pos/card.tsx",
  ]) {
    const source = readFileSync(
      path.resolve(__dirname, "../../apps/mobile", file),
      "utf8"
    );
    expect(source).not.toContain("@react-navigation/");
    expect(source).toContain('"expo-router/react-navigation"');
  }
});
