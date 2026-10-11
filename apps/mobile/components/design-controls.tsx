import { useState } from "react";
import {
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";

import { sellerFonts, sellerThemeTokens } from "@/theme/tokens";

// Shared controls for the storefront design editors. Deliberately plain:
// every editor screen composes these so behavior (validation hints, dirty
// tracking, list reordering) stays consistent across the whole design suite.

export function DesignSectionTitle({
  title,
  description,
}: {
  title: string;
  description?: string;
}) {
  return (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {description ? (
        <Text style={styles.sectionDescription}>{description}</Text>
      ) : null}
    </View>
  );
}

export function DesignHint({ text }: { text: string }) {
  return <Text style={styles.hint}>{text}</Text>;
}

const COLOR_PRESETS = [
  "#2f4a2c",
  "#5c4033",
  "#8b5e34",
  "#b08968",
  "#e6dcc3",
  "#f5f1e6",
  "#1a1a1a",
  "#4a4a4a",
  "#757575",
  "#ffffff",
  "#c0392b",
  "#d4a017",
  "#2e6f8e",
  "#3a7d44",
  "#7d5ba6",
  "#c86b4a",
];

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export function ColorField({
  label,
  value,
  onChange,
  allowEmpty = true,
}: {
  label: string;
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  // Design colors are optional almost everywhere ("absent = theme default"),
  // so clearing back to unset is the common path.
  allowEmpty?: boolean;
}) {
  const current = value ?? "";
  const invalid = current !== "" && !HEX_RE.test(current);
  return (
    <View style={styles.fieldWrap}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={styles.colorRow}>
        <View
          style={[
            styles.colorSwatchPreview,
            { backgroundColor: HEX_RE.test(current) ? current : "#ffffff" },
          ]}
        />
        <TextInput
          style={[
            styles.input,
            styles.colorInput,
            invalid && styles.inputError,
          ]}
          value={current}
          onChangeText={(text) => {
            const trimmed = text.trim();
            if (trimmed === "" && allowEmpty) {
              onChange(undefined);
              return;
            }
            onChange(trimmed);
          }}
          placeholder="#2f4a2c"
          placeholderTextColor={sellerThemeTokens.mutedText}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel={label}
        />
        {allowEmpty && current !== "" ? (
          <Pressable
            onPress={() => onChange(undefined)}
            accessibilityRole="button"
            accessibilityLabel={`Clear ${label}`}
            style={styles.clearButton}
          >
            <Text style={styles.clearButtonText}>Clear</Text>
          </Pressable>
        ) : null}
      </View>
      {invalid ? (
        <Text style={styles.errorText}>
          Use a hex color like #2f4a2c, or clear to use the theme default.
        </Text>
      ) : null}
      <View style={styles.presetRow}>
        {COLOR_PRESETS.map((preset) => (
          <Pressable
            key={preset}
            onPress={() => onChange(preset)}
            accessibilityRole="button"
            accessibilityLabel={`Set ${label} to ${preset}`}
            style={[
              styles.presetSwatch,
              { backgroundColor: preset },
              current.toLowerCase() === preset && styles.presetSwatchActive,
            ]}
          />
        ))}
      </View>
    </View>
  );
}

export function ToggleRow({
  label,
  value,
  onChange,
  description,
}: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
  description?: string;
}) {
  return (
    <View style={styles.toggleRow}>
      <View style={styles.toggleTextWrap}>
        <Text style={styles.toggleLabel}>{label}</Text>
        {description ? (
          <Text style={styles.toggleDescription}>{description}</Text>
        ) : null}
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        accessibilityLabel={label}
        trackColor={{
          false: sellerThemeTokens.mutedText,
          true: sellerThemeTokens.primary,
        }}
        thumbColor="#ffffff"
      />
    </View>
  );
}

export function OptionChips<T extends string>({
  label,
  value,
  options,
  onChange,
  allowUnset = true,
}: {
  label: string;
  value: T | undefined;
  options: { value: T; label: string }[];
  onChange: (value: T | undefined) => void;
  allowUnset?: boolean;
}) {
  return (
    <View style={styles.fieldWrap}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={styles.chipsRow}>
        {allowUnset ? (
          <Pressable
            onPress={() => onChange(undefined)}
            accessibilityRole="button"
            style={[styles.chip, value === undefined && styles.chipActive]}
          >
            <Text
              style={[
                styles.chipText,
                value === undefined && styles.chipTextActive,
              ]}
            >
              Default
            </Text>
          </Pressable>
        ) : null}
        {options.map((option) => (
          <Pressable
            key={option.value}
            onPress={() => onChange(option.value)}
            accessibilityRole="button"
            style={[styles.chip, value === option.value && styles.chipActive]}
          >
            <Text
              style={[
                styles.chipText,
                value === option.value && styles.chipTextActive,
              ]}
            >
              {option.label}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

export function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  integer = true,
  description,
}: {
  label: string;
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  min?: number;
  max?: number;
  integer?: boolean;
  description?: string;
}) {
  const text = value === undefined ? "" : String(value);
  const [invalid, setInvalid] = useState(false);
  return (
    <View style={styles.fieldWrap}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={[styles.input, invalid && styles.inputError]}
        value={text}
        onChangeText={(next) => {
          const trimmed = next.trim();
          if (trimmed === "") {
            setInvalid(false);
            onChange(undefined);
            return;
          }
          // Number("") === 0 coercion: blank was handled above, so a failed
          // parse here is a real typo and must NOT silently save as unset.
          const parsed = Number(trimmed);
          if (
            !Number.isFinite(parsed) ||
            (integer && !Number.isInteger(parsed)) ||
            (min !== undefined && parsed < min) ||
            (max !== undefined && parsed > max)
          ) {
            setInvalid(true);
            return;
          }
          setInvalid(false);
          onChange(parsed);
        }}
        keyboardType="numeric"
        placeholder="Not set"
        placeholderTextColor={sellerThemeTokens.mutedText}
        accessibilityLabel={label}
      />
      {invalid ? (
        <Text style={styles.errorText}>
          Enter a whole number{min !== undefined ? ` of at least ${min}` : ""}
          {max !== undefined ? ` and at most ${max}` : ""}, or clear it.
        </Text>
      ) : null}
      {description ? <Text style={styles.hint}>{description}</Text> : null}
    </View>
  );
}

// Up/down + delete row chrome shared by every list editor (sections, FAQ
// items, nav links, ...). Drag-and-drop needs a native gesture dependency;
// explicit move buttons are reliable and accessible.
export function ListItemChrome({
  title,
  subtitle,
  onMoveUp,
  onMoveDown,
  onDelete,
  isFirst,
  isLast,
  children,
}: {
  title: string;
  subtitle?: string;
  onMoveUp?: () => void;
  onMoveDown?: () => void;
  onDelete?: () => void;
  isFirst: boolean;
  isLast: boolean;
  children?: React.ReactNode;
}) {
  return (
    <View style={styles.listItem}>
      <View style={styles.listItemHeader}>
        <View style={styles.listItemTitleWrap}>
          <Text style={styles.listItemTitle} numberOfLines={1}>
            {title}
          </Text>
          {subtitle ? (
            <Text style={styles.listItemSubtitle} numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </View>
        <View style={styles.listItemActions}>
          {onMoveUp ? (
            <Pressable
              onPress={onMoveUp}
              disabled={isFirst}
              accessibilityRole="button"
              accessibilityLabel={`Move ${title} up`}
              style={[styles.iconButton, isFirst && styles.iconButtonDisabled]}
            >
              <Text style={styles.iconButtonText}>↑</Text>
            </Pressable>
          ) : null}
          {onMoveDown ? (
            <Pressable
              onPress={onMoveDown}
              disabled={isLast}
              accessibilityRole="button"
              accessibilityLabel={`Move ${title} down`}
              style={[styles.iconButton, isLast && styles.iconButtonDisabled]}
            >
              <Text style={styles.iconButtonText}>↓</Text>
            </Pressable>
          ) : null}
          {onDelete ? (
            <Pressable
              onPress={onDelete}
              accessibilityRole="button"
              accessibilityLabel={`Delete ${title}`}
              style={styles.iconButton}
            >
              <Text style={[styles.iconButtonText, styles.deleteText]}>✕</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
      {children}
    </View>
  );
}

export function AddItemButton({
  label,
  onPress,
}: {
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={styles.addButton}
    >
      <Text style={styles.addButtonText}>+ {label}</Text>
    </Pressable>
  );
}

export function DesignTextField({
  label,
  value,
  onChange,
  placeholder,
  multiline = false,
  keyboardType = "default",
  hint,
}: {
  label: string;
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  placeholder?: string;
  multiline?: boolean;
  keyboardType?: "default" | "url" | "email-address";
  hint?: string;
}) {
  return (
    <View style={styles.fieldWrap}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        style={[styles.input, multiline && styles.textarea]}
        value={value ?? ""}
        onChangeText={(text) => onChange(text === "" ? undefined : text)}
        placeholder={placeholder}
        placeholderTextColor={sellerThemeTokens.mutedText}
        multiline={multiline}
        keyboardType={keyboardType}
        autoCapitalize={keyboardType === "default" ? "sentences" : "none"}
        autoCorrect={keyboardType === "default"}
        textAlignVertical={multiline ? "top" : "center"}
        accessibilityLabel={label}
      />
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  sectionHeader: { gap: 4, marginBottom: 8 },
  sectionTitle: {
    color: sellerThemeTokens.text,
    fontSize: 17,
    fontFamily: sellerFonts.extrabold,
  },
  sectionDescription: {
    color: sellerThemeTokens.mutedText,
    fontSize: 13,
    fontFamily: sellerFonts.regular,
    lineHeight: 18,
  },
  hint: {
    color: sellerThemeTokens.mutedText,
    fontSize: 12,
    fontFamily: sellerFonts.regular,
    lineHeight: 16,
  },
  fieldWrap: { gap: 6, marginBottom: 14 },
  fieldLabel: {
    color: sellerThemeTokens.text,
    fontSize: 14,
    fontFamily: sellerFonts.bold,
  },
  input: {
    borderWidth: 2,
    borderColor: sellerThemeTokens.black,
    borderRadius: 6,
    backgroundColor: sellerThemeTokens.surface,
    color: sellerThemeTokens.text,
    fontFamily: sellerFonts.regular,
    fontSize: 15,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  textarea: { minHeight: 96 },
  inputError: { borderColor: "#c0392b" },
  errorText: {
    color: "#c0392b",
    fontSize: 12,
    fontFamily: sellerFonts.regular,
  },
  colorRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  colorSwatchPreview: {
    width: 36,
    height: 36,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: sellerThemeTokens.black,
  },
  colorInput: { flex: 1 },
  clearButton: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderWidth: 2,
    borderColor: sellerThemeTokens.black,
    borderRadius: 6,
  },
  clearButtonText: {
    color: sellerThemeTokens.text,
    fontFamily: sellerFonts.bold,
    fontSize: 13,
  },
  presetRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 4 },
  presetSwatch: {
    width: 26,
    height: 26,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: sellerThemeTokens.black,
  },
  presetSwatchActive: { borderWidth: 3 },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    paddingVertical: 8,
  },
  toggleTextWrap: { flex: 1, gap: 2 },
  toggleLabel: {
    color: sellerThemeTokens.text,
    fontSize: 15,
    fontFamily: sellerFonts.bold,
  },
  toggleDescription: {
    color: sellerThemeTokens.mutedText,
    fontSize: 12,
    fontFamily: sellerFonts.regular,
    lineHeight: 16,
  },
  chipsRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    borderWidth: 2,
    borderColor: sellerThemeTokens.black,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: sellerThemeTokens.surface,
  },
  chipActive: { backgroundColor: sellerThemeTokens.primary },
  chipText: {
    color: sellerThemeTokens.text,
    fontFamily: sellerFonts.bold,
    fontSize: 13,
  },
  chipTextActive: { color: "#ffffff" },
  listItem: {
    borderWidth: 2,
    borderColor: sellerThemeTokens.black,
    borderRadius: 6,
    backgroundColor: sellerThemeTokens.surface,
    padding: 12,
    marginBottom: 10,
    gap: 8,
  },
  listItemHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  listItemTitleWrap: { flex: 1, gap: 2 },
  listItemTitle: {
    color: sellerThemeTokens.text,
    fontSize: 15,
    fontFamily: sellerFonts.bold,
  },
  listItemSubtitle: {
    color: sellerThemeTokens.mutedText,
    fontSize: 12,
    fontFamily: sellerFonts.regular,
  },
  listItemActions: { flexDirection: "row", gap: 6 },
  iconButton: {
    width: 32,
    height: 32,
    borderWidth: 2,
    borderColor: sellerThemeTokens.black,
    borderRadius: 6,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: sellerThemeTokens.surface,
  },
  iconButtonDisabled: { opacity: 0.3 },
  iconButtonText: {
    color: sellerThemeTokens.text,
    fontSize: 15,
    fontFamily: sellerFonts.bold,
  },
  deleteText: { color: "#c0392b" },
  addButton: {
    borderWidth: 2,
    borderStyle: "dashed",
    borderColor: sellerThemeTokens.black,
    borderRadius: 6,
    paddingVertical: 12,
    alignItems: "center",
    marginBottom: 10,
  },
  addButtonText: {
    color: sellerThemeTokens.text,
    fontFamily: sellerFonts.bold,
    fontSize: 14,
  },
});
