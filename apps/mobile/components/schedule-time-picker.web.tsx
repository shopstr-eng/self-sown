// Web fallback for ScheduleTimePicker: @react-native-community/datetimepicker
// is native-only, so the web build uses the browser's datetime-local input
// (same UX as the web dashboard's blog settings).
import { createElement } from "react";
import { StyleSheet, Text, View } from "react-native";

import { sellerFonts, sellerThemeTokens } from "@/theme/tokens";

function toLocalInputValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate()
  )}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

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
  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>{label}</Text>
      {createElement("input", {
        type: "datetime-local",
        value: value ? toLocalInputValue(value) : "",
        disabled,
        "aria-label": label,
        onChange: (event: { target: { value: string } }) => {
          const raw = event.target.value;
          const parsed = raw ? new Date(raw) : null;
          onChange(parsed && !Number.isNaN(parsed.getTime()) ? parsed : null);
        },
        style: {
          fontFamily: sellerFonts.regular,
          fontSize: 14,
          padding: 10,
          borderWidth: 2,
          borderStyle: "solid",
          borderColor: sellerThemeTokens.black,
          borderRadius: 6,
          backgroundColor: sellerThemeTokens.surface,
          color: sellerThemeTokens.text,
        },
      })}
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
});
