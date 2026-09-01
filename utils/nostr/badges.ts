import type { Filter } from "nostr-tools";

import type { Nip58ProfileBadge, NostrEvent } from "@/utils/types/types";
import { isHexPubkey } from "@/utils/nostr/pubkey";
import type { NostrFetchResult, NostrManager } from "@/utils/nostr/nostr-manager";

export const NIP58_BADGE_AWARD_KIND = 8;
export const NIP58_PROFILE_BADGES_KIND = 10008;
export const NIP58_BADGE_SET_KIND = 30008;
export const NIP58_BADGE_DEFINITION_KIND = 30009;
export const NIP58_DEPRECATED_PROFILE_BADGES_D_TAG = "profile_badges";
export const MAX_NIP58_PROFILE_BADGES = 4;
const FETCH_TIMEOUT_MS = 5_000;
const hexId = /^[0-9a-fA-F]{64}$/;

export interface Nip58ProfileBadgeReference {
  definitionAddress: string;
  awardEventId: string;
  definitionRelayHint?: string;
  awardRelayHint?: string;
}
export interface Nip58ProfileBadgesResult {
  badges: Nip58ProfileBadge[];
  complete: boolean;
}

const tag = (tags: string[][], key: string) =>
  tags.find((value) => value[0] === key)?.[1];
const tags = (event: NostrEvent, key: string) =>
  event.tags.filter((value) => value[0] === key && value[1]).map((value) => value[1]!);

export function parseNip58BadgeAddress(address?: string) {
  const [kind, pubkey, ...dParts] = address?.split(":") || [];
  const d = dParts.join(":");
  if (kind !== String(NIP58_BADGE_DEFINITION_KIND) || !pubkey || !isHexPubkey(pubkey) || !d) return null;
  return { pubkey, d, address: `${NIP58_BADGE_DEFINITION_KIND}:${pubkey}:${d}` };
}
function parseBadgeSetAddress(address?: string) {
  const [kind, pubkey, ...dParts] = address?.split(":") || [];
  const d = dParts.join(":");
  return kind === String(NIP58_BADGE_SET_KIND) && pubkey && isHexPubkey(pubkey) && d
    ? { pubkey, d, address: `${NIP58_BADGE_SET_KIND}:${pubkey}:${d}` } : null;
}

export function isNip58ProfileBadgesEvent(event: NostrEvent): boolean {
  return event.kind === NIP58_PROFILE_BADGES_KIND ||
    (event.kind === NIP58_BADGE_SET_KIND && tag(event.tags, "d") === NIP58_DEPRECATED_PROFILE_BADGES_D_TAG);
}

export function parseNip58ProfileBadgesEvent(event: NostrEvent): Nip58ProfileBadgeReference[] {
  if (!isNip58ProfileBadgesEvent(event)) return [];
  const parsed: Nip58ProfileBadgeReference[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < event.tags.length - 1 && parsed.length < MAX_NIP58_PROFILE_BADGES; i++) {
    const a = event.tags[i];
    const e = event.tags[i + 1];
    const badge = a?.[0] === "a" ? parseNip58BadgeAddress(a[1]) : null;
    if (!badge || e?.[0] !== "e" || !hexId.test(e[1] || "")) continue;
    const key = `${badge.address}:${e[1]}`;
    if (!seen.has(key)) {
      seen.add(key);
      parsed.push({ definitionAddress: badge.address, awardEventId: e[1]!, definitionRelayHint: a?.[2], awardRelayHint: e[2] });
    }
    i++;
  }
  return parsed;
}

export function selectLatestNip58ProfileBadgesEvent(events: readonly NostrEvent[]): NostrEvent | null {
  return events.filter(isNip58ProfileBadgesEvent).reduce<NostrEvent | null>(
    (latest, event) => !latest || event.created_at > latest.created_at ||
      (event.created_at === latest.created_at && event.id.localeCompare(latest.id) < 0) ? event : latest,
    null
  );
}

export function buildNip58BadgeDefinitionFilters(addresses: Iterable<string>): Filter[] {
  const grouped = new Map<string, Set<string>>();
  for (const address of addresses) {
    const parsed = parseNip58BadgeAddress(address);
    if (!parsed) continue;
    let dTags = grouped.get(parsed.pubkey);
    if (!dTags) {
      dTags = new Set();
      grouped.set(parsed.pubkey, dTags);
    }
    dTags.add(parsed.d);
  }
  return [...grouped].map(([author, d]) => ({ kinds: [NIP58_BADGE_DEFINITION_KIND], authors: [author], "#d": [...d] }));
}
function buildBadgeSetFilters(addresses: Iterable<string>): Filter[] {
  const grouped = new Map<string, Set<string>>();
  for (const address of addresses) {
    const parsed = parseBadgeSetAddress(address);
    if (!parsed) continue;
    const dTags = grouped.get(parsed.pubkey) || new Set<string>();
    dTags.add(parsed.d);
    grouped.set(parsed.pubkey, dTags);
  }
  return [...grouped].map(([author, d]) => ({ kinds: [NIP58_BADGE_SET_KIND], authors: [author], "#d": [...d] }));
}

function hint(value?: string): string | null {
  try {
    const parsed = new URL(value || "");
    return (parsed.protocol === "ws:" || parsed.protocol === "wss:") && !parsed.username && !parsed.password
      ? parsed.toString().replace(/\/+$/, "") : null;
  } catch { return null; }
}
function latestByAddress(events: NostrEvent[]) {
  const found = new Map<string, NostrEvent>();
  for (const event of events) {
    const address = parseNip58BadgeAddress(`${event.kind}:${event.pubkey}:${tag(event.tags, "d") || ""}`);
    if (!address) continue;
    const current = found.get(address.address);
    if (!current || event.created_at > current.created_at || (event.created_at === current.created_at && event.id < current.id)) found.set(address.address, event);
  }
  return found;
}
async function fetchEvents(nostr: Pick<NostrManager, "fetchWithStatus">, filters: Filter[], relays: string[]): Promise<NostrFetchResult> {
  return nostr.fetchWithStatus(filters, {}, relays, FETCH_TIMEOUT_MS);
}

export async function fetchNip58ProfileBadges(
  nostr: Pick<NostrManager, "fetchWithStatus">,
  relays: string[],
  pubkeys: string[]
): Promise<Map<string, Nip58ProfileBadgesResult>> {
  const users = [...new Set(pubkeys.filter(isHexPubkey))];
  const result = new Map<string, Nip58ProfileBadgesResult>();
  if (!users.length) return result;
  const profileResponse = await fetchEvents(nostr, [
    { kinds: [NIP58_PROFILE_BADGES_KIND], authors: users },
    { kinds: [NIP58_BADGE_SET_KIND], authors: users, "#d": [NIP58_DEPRECATED_PROFILE_BADGES_D_TAG] },
  ], relays);
  const profiles = new Map<string, NostrEvent[]>();
  for (const event of profileResponse.events) {
    if (!users.includes(event.pubkey) || !isNip58ProfileBadgesEvent(event)) continue;
    const events = profiles.get(event.pubkey) || [];
    events.push(event);
    profiles.set(event.pubkey, events);
  }
  const selected = new Map<string, Nip58ProfileBadgeReference[]>();
  const selectedSets = new Map<string, string[]>();
  const setAddresses = new Set<string>();
  const awardIds = new Set<string>();
  for (const user of users) {
    const event = selectLatestNip58ProfileBadgesEvent(profiles.get(user) || []);
    if (!event) { result.set(user, { badges: [], complete: profileResponse.complete }); continue; }
    const refs = parseNip58ProfileBadgesEvent(event);
    selected.set(user, refs);
    const sets: string[] = [];
    for (let i = 0; i < event.tags.length; i++) {
      const set = event.tags[i]?.[0] === "a" ? parseBadgeSetAddress(event.tags[i]?.[1]) : null;
      if (set) { sets.push(set.address); setAddresses.add(set.address); }
    }
    selectedSets.set(user, sets);
  }
  const setsResponse = setAddresses.size
    ? await fetchEvents(nostr, buildBadgeSetFilters(setAddresses), configuredRelays(relays))
    : { events: [], complete: true };
  const setsByAddress = new Map<string, NostrEvent>();
  for (const set of setsResponse.events) {
    const parsed = parseBadgeSetAddress(`${set.kind}:${set.pubkey}:${tag(set.tags, "d") || ""}`);
    if (parsed) setsByAddress.set(parsed.address, set);
  }
  for (const [user, sets] of selectedSets) {
    const refs = selected.get(user)!;
    for (const set of sets) {
      const setEvent = setsByAddress.get(set);
      if (setEvent) refs.push(...parseNip58ProfileBadgesEvent({ ...setEvent, kind: NIP58_PROFILE_BADGES_KIND }));
    }
    selected.set(user, refs.slice(0, MAX_NIP58_PROFILE_BADGES));
    refs.slice(0, MAX_NIP58_PROFILE_BADGES).forEach((ref) => awardIds.add(ref.awardEventId));
  }
  const configured = configuredRelays(relays);
  const awardsResponse = awardIds.size ? await fetchEvents(nostr, [{ kinds: [8], ids: [...awardIds] }], configured) : { events: [], complete: true };
  const awards = new Map(awardsResponse.events.filter((event) => event.kind === 8 && hexId.test(event.id)).map((event) => [event.id, event]));
  const addresses = new Set<string>();
  for (const [user, refs] of selected) {
    for (const ref of refs) {
      const award = awards.get(ref.awardEventId);
      const badge = parseNip58BadgeAddress(ref.definitionAddress);
      if (
        award &&
        award.pubkey === badge?.pubkey &&
        tags(award, "a").length === 1 &&
        tags(award, "a")[0] === ref.definitionAddress &&
        tags(award, "p").includes(user)
      ) {
        addresses.add(ref.definitionAddress);
      }
    }
  }
  const definitionFilters = buildNip58BadgeDefinitionFilters(addresses);
  const definitionsResponse = definitionFilters.length ? await fetchEvents(nostr, definitionFilters, configured) : { events: [], complete: true };
  const definitions = latestByAddress(definitionsResponse.events.filter((event) => event.kind === NIP58_BADGE_DEFINITION_KIND));
  for (const [user, refs] of selected) {
    const badges: Nip58ProfileBadge[] = [];
    for (const ref of refs) { const event = definitions.get(ref.definitionAddress); const parsed = parseNip58BadgeAddress(ref.definitionAddress); if (event && parsed) badges.push({ definitionAddress: parsed.address, awardEventId: ref.awardEventId, issuerPubkey: parsed.pubkey, badgeDefinitionDTag: parsed.d, name: tag(event.tags, "name") || parsed.d, description: tag(event.tags, "description"), image: tag(event.tags, "image"), thumbnail: event.tags.find((value) => value[0] === "thumb")?.[1] || tag(event.tags, "image") }); }
    result.set(user, { badges, complete: profileResponse.complete && setsResponse.complete && awardsResponse.complete && definitionsResponse.complete });
  }
  return result;
}

function configuredRelays(relays: string[]): string[] {
  return [...new Set(relays.map(hint).filter((value): value is string => !!value))];
}