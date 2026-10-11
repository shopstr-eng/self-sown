import { useState } from "react";
import { Platform, StyleSheet, Text, View } from "react-native";
import DateTimePicker, {
  type DateTimePickerEvent,
} from "@react-native-community/datetimepicker";

import { ActionButton } from "@/components/seller-ui";
import { sellerFonts, sellerThemeTokens } from "@/theme/tokens";

// Sensible default when the seller hasn't picked anything yet: an hour out
// also clears the server's minimum schedule lead time.
const DEFAULT_LEAD_MS = 60 * 60 * 1000;

export function ScheduleTimePicker({
  label = "Schedule for (optional)",
  value,
  onChange,
  disabled = false,
}: {
  label?: string;
  value: Date | null;
  onChange: (date: Date | null) => void;
  disabled?: boolean;
}) {
  // Android has no combined datetime dialog, so it picks date then time in two
  // steps; iOS shows one inline spinner ("datetime").
  const [mode, setMode] = useState<"date" | "time" | "datetime" | null>(null);
  const [draft, setDraft] = useState<Date>(
    () => new Date(Date.now() + DEFAULT_LEAD_MS)
  );

  const openPicker = () => {
    setDraft(value ?? new Date(Date.now() + DEFAULT_LEAD_MS));
    setMode(Platform.OS === "ios" ? "datetime" : "date");
  };

  const handlePickerChange = (
    event: DateTimePickerEvent,
    selected?: Date
  ) => {
    if (Platform.OS === "ios") {
      // Inline spinner stays open; the Done button commits the draft.
      if (selected) setDraft(selected);
      return;
    }
    if (event.type === "dismissed") {
      setMode(null);
      return;
    }
    if (mode === "date") {
      if (selected) setDraft(selected);
      setMode("time");
      return;
    }
    if (selected) onChange(selected);
    setMode(null);
  };

  const commitDraft = () => {
    onChange(draft);
    setMode(null);
  };

  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>{label}</Text>
      <Text style={styles.value}>
        {value
          ? value.toLocaleString()
          : "Not scheduled — the post is published or saved as a draft now."}
      </Text>
      <View style={styles.actions}>
        <ActionButton
          label={value ? "Change date & time" : "Pick date & time"}
          onPress={openPicker}
          variant="secondary"
          disabled={disabled}
        />
        {value ? (
          <ActionButton
            label="Clear"
            onPress={() => onChange(null)}
            variant="secondary"
            disabled={disabled}
          />
        ) : null}
      </View>
      {mode ? (
        <View style={styles.pickerWrap}>
          <DateTimePicker
            value={draft}
            mode={mode}
            display={Platform.OS === "ios" ? "spinner" : "default"}
            minimumDate={new Date()}
            onChange={handlePickerChange}
          />
          {Platform.OS === "ios" ? (
            <ActionButton
              label="Done"
              onPress={commitDraft}
              variant="secondary"
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    gap: 8,
  },
  label: {
    color: sellerThemeTokens.text,
    fontSize: 14,
    fontFamily: sellerFonts.bold,
  },
  value: {
    color: sellerThemeTokens.mutedText,
    fontSize: 14,
    fontFamily: sellerFonts.regular,
    lineHeight: 20,
  },
  actions: {
    gap: 8,
  },
  pickerWrap: {
    gap: 8,
    alignItems: "center",
    padding: 12,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: sellerThemeTokens.black,
    backgroundColor: sellerThemeTokens.surface,
  },
});
