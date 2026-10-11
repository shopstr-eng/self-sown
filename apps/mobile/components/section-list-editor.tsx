import { useState } from "react";
import { Modal, Pressable, StyleSheet, Switch, Text, View } from "react-native";
import { useRouter, type Href } from "expo-router";

import type {
  StorefrontSection,
  StorefrontSectionType,
} from "@self-sown/domain";

import {
  AddItemButton,
  DesignHint,
  ListItemChrome,
} from "@/components/design-controls";
import {
  createSectionOfType,
  SECTION_TYPE_LABELS,
} from "@/lib/section-field-specs";
import { moveItem, type SectionScope } from "@/lib/storefront-design-scopes";
import { useStorefrontDesignStore } from "@/lib/storefront-design-store";
import { sellerFonts, sellerThemeTokens } from "@/theme/tokens";

// Reorder/enable/add/remove UI for one sections[] array (home, blog, a custom
// page, or product-page defaults). Editing a section pushes the spec-driven
// editor screen with the scope encoded in the route params.
export function SectionListEditor({
  scope,
  allowedTypes,
}: {
  scope: SectionScope;
  allowedTypes: { type: StorefrontSectionType; label: string }[];
}) {
  const router = useRouter();
  const draft = useStorefrontDesignStore((state) => state.draft);
  const update = useStorefrontDesignStore((state) => state.update);
  const [pickingType, setPickingType] = useState(false);

  const sections =
    scope === "home"
      ? (draft.sections ?? [])
      : scope === "blog"
        ? (draft.blogPage?.sections ?? [])
        : scope === "productDefaults"
          ? (draft.productPageDefaults ?? [])
          : (draft.pages?.find((page) => page.id === scope.slice(5))
              ?.sections ?? []);

  const write = (next: StorefrontSection[]) => {
    update((current) => {
      if (scope === "home") return { ...current, sections: next };
      if (scope === "blog") return { ...current, blogPage: { sections: next } };
      if (scope === "productDefaults")
        return { ...current, productPageDefaults: next };
      const pageId = scope.slice(5);
      return {
        ...current,
        pages: (current.pages ?? []).map((page) =>
          page.id === pageId ? { ...page, sections: next } : page
        ),
      };
    });
  };

  return (
    <View>
      {sections.length === 0 ? (
        <DesignHint text="No sections yet — add one below." />
      ) : null}
      {sections.map((section, index) => (
        <ListItemChrome
          key={section.id}
          title={
            section.heading || SECTION_TYPE_LABELS[section.type] || section.type
          }
          subtitle={SECTION_TYPE_LABELS[section.type] ?? section.type}
          isFirst={index === 0}
          isLast={index === sections.length - 1}
          onMoveUp={() => write(moveItem(sections, index, -1))}
          onMoveDown={() => write(moveItem(sections, index, 1))}
          onDelete={() =>
            write(sections.filter((entry) => entry.id !== section.id))
          }
        >
          <View style={styles.row}>
            <Pressable
              onPress={() =>
                router.push(
                  `/storefront/design/section/${section.id}?scope=${scope}` as Href
                )
              }
              accessibilityRole="button"
              style={styles.editButton}
            >
              <Text style={styles.editButtonText}>Edit fields</Text>
            </Pressable>
            <View style={styles.enabledWrap}>
              <Text style={styles.enabledLabel}>Shown</Text>
              <Switch
                value={section.enabled !== false}
                onValueChange={(value) =>
                  write(
                    sections.map((entry) =>
                      entry.id === section.id
                        ? { ...entry, enabled: value }
                        : entry
                    )
                  )
                }
                accessibilityLabel={`Show ${section.heading || section.type}`}
                trackColor={{
                  false: sellerThemeTokens.mutedText,
                  true: sellerThemeTokens.primary,
                }}
                thumbColor="#ffffff"
              />
            </View>
          </View>
        </ListItemChrome>
      ))}
      <AddItemButton label="Add section" onPress={() => setPickingType(true)} />

      <Modal
        visible={pickingType}
        transparent
        animationType="fade"
        onRequestClose={() => setPickingType(false)}
      >
        <Pressable
          style={styles.modalBackdrop}
          onPress={() => setPickingType(false)}
          accessibilityLabel="Close section type picker"
        >
          <View style={styles.modalCard}>
            <Text style={styles.modalTitle}>Add a section</Text>
            <View style={styles.typeGrid}>
              {allowedTypes.map((entry) => (
                <Pressable
                  key={entry.type}
                  onPress={() => {
                    write([...sections, createSectionOfType(entry.type)]);
                    setPickingType(false);
                  }}
                  accessibilityRole="button"
                  style={styles.typeChip}
                >
                  <Text style={styles.typeChipText}>{entry.label}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  editButton: {
    borderWidth: 2,
    borderColor: sellerThemeTokens.black,
    borderRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 7,
    backgroundColor: sellerThemeTokens.primary,
  },
  editButtonText: {
    color: "#ffffff",
    fontFamily: sellerFonts.bold,
    fontSize: 13,
  },
  enabledWrap: { flexDirection: "row", alignItems: "center", gap: 6 },
  enabledLabel: {
    color: sellerThemeTokens.mutedText,
    fontSize: 12,
    fontFamily: sellerFonts.regular,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "center",
    padding: 24,
  },
  modalCard: {
    backgroundColor: sellerThemeTokens.background,
    borderWidth: 2,
    borderColor: sellerThemeTokens.black,
    borderRadius: 8,
    padding: 16,
    gap: 12,
  },
  modalTitle: {
    color: sellerThemeTokens.text,
    fontSize: 17,
    fontFamily: sellerFonts.extrabold,
  },
  typeGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  typeChip: {
    borderWidth: 2,
    borderColor: sellerThemeTokens.black,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: sellerThemeTokens.surface,
  },
  typeChipText: {
    color: sellerThemeTokens.text,
    fontFamily: sellerFonts.bold,
    fontSize: 13,
  },
});
