import { View } from "react-native";
import { useLocalSearchParams } from "expo-router";

import { DesignScreen } from "@/components/design-screen";
import {
  SectionFieldsEditor,
  writeValue,
} from "@/components/section-fields-editor";
import { SECTION_TYPE_LABELS } from "@/lib/section-field-specs";
import {
  getScopedSections,
  parseSectionScope,
  updateScopedSection,
} from "@/lib/storefront-design-scopes";
import { useStorefrontDesignStore } from "@/lib/storefront-design-store";

// Thin wrapper: resolves the section from the storefront design store by
// scope and delegates rendering to the shared spec-driven editor (also used
// by the per-product page design screens).
export default function SectionEditorScreen() {
  const params = useLocalSearchParams<{ id: string; scope?: string }>();
  const scope = parseSectionScope(params.scope);
  const draft = useStorefrontDesignStore((state) => state.draft);
  const update = useStorefrontDesignStore((state) => state.update);

  const section = getScopedSections(draft, scope).find(
    (entry) => entry.id === params.id
  );

  if (!section) {
    return (
      <DesignScreen
        title="Section not found"
        description="This section may have been removed. Go back and reopen the list."
      >
        <View />
      </DesignScreen>
    );
  }

  const patch = (key: string, value: unknown) => {
    update((current) =>
      updateScopedSection(current, scope, section.id, (existing) =>
        writeValue(existing, key, value)
      )
    );
  };

  return (
    <DesignScreen
      eyebrow="Stall design"
      title={SECTION_TYPE_LABELS[section.type] ?? section.type}
      description="Edits apply when you tap Save design below."
    >
      <SectionFieldsEditor section={section} onPatch={patch} />
    </DesignScreen>
  );
}
