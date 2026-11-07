// Corpus authoring helpers. The corpus is plain reviewable data; this helper
// only stamps one rule template onto several sales channels so a statute that
// governs every direct channel (e.g. a permit requirement) is written once.
// The expanded output is what gets validated and seeded — one row per channel.

import type { CorpusRule } from "../schema";

export type RuleTemplate = Omit<CorpusRule, "id" | "state" | "category" | "channel"> & {
  // Stable slug for the rule within its state + category, e.g. "permit".
  // Expanded ids are `<state>-<category>-<channel>-<slug>`.
  slug: string;
};

export function forChannels(
  channels: string[],
  state: string,
  category: string,
  template: RuleTemplate
): CorpusRule[] {
  return channels.map((channel) => {
    const { slug, ...fields } = template;
    return {
      ...fields,
      id: `${state.toLowerCase()}-${category}-${channel}-${slug}`,
      state,
      category,
      channel,
    };
  });
}

export function oneChannel(
  channel: string,
  state: string,
  category: string,
  template: RuleTemplate
): CorpusRule {
  return forChannels([channel], state, category, template)[0]!;
}
