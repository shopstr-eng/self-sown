export type NostrProfilePresentation = {
  displayName: string;
  pictureUrl: string;
};

function trimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export function getNostrProfilePresentation(
  content: unknown
): NostrProfilePresentation {
  if (!content || typeof content !== "object" || Array.isArray(content)) {
    return { displayName: "", pictureUrl: "" };
  }

  const profile = content as Record<string, unknown>;
  const displayName =
    trimmedString(profile.display_name) || trimmedString(profile.name);
  const picture = trimmedString(profile.picture);

  return {
    displayName,
    pictureUrl: isHttpUrl(picture) ? picture : "",
  };
}
