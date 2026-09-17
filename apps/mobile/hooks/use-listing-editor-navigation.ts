import { useCallback, useLayoutEffect, useRef } from "react";
import { Alert } from "react-native";
import {
  useFocusEffect,
  useNavigation,
  usePreventRemove,
} from "@react-navigation/native";

import { registerListingTabGuard } from "@/lib/listing-navigation-guard";

export function useListingEditorNavigation(dirty: boolean, busy: boolean) {
  const navigation = useNavigation();
  const allow = useRef(false);
  useLayoutEffect(() => {
    // Native interactive dismissal can finish before the discard alert resolves.
    // Keep the guarded back button available while protecting an unsaved draft.
    navigation.setOptions({ gestureEnabled: !dirty && !busy });
  }, [navigation, dirty, busy]);
  const confirm = (leave: () => void) =>
    Alert.alert("Discard changes?", "Your product has unsaved changes.", [
      { text: "Keep editing", style: "cancel" },
      { text: "Discard", style: "destructive", onPress: leave },
    ]);
  usePreventRemove(dirty || busy, ({ data }) => {
    if (allow.current) {
      navigation.dispatch(data.action);
      return;
    }
    if (busy) return;
    confirm(() => navigation.dispatch(data.action));
  });
  useFocusEffect(
    useCallback(
      () =>
        registerListingTabGuard((leave) => {
          if (allow.current || (!dirty && !busy)) return false;
          if (!busy)
            confirm(() => {
              allow.current = true;
              navigation.goBack();
              leave();
            });
          return true;
        }),
      [navigation, dirty, busy]
    )
  );
  return (navigate: () => void) => {
    allow.current = true;
    navigate();
  };
}
