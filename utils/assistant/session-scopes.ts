/**
 * Client-safe scope constants for the scoped assistant session tokens.
 *
 * Kept in its own module with NO node imports so browser bundles (settings
 * pages) can take their scope from the same constant set the server verifies
 * against — an inline literal here or there would silently mint tokens no
 * endpoint accepts. session-token.ts derives from this module; do not
 * duplicate the scope strings anywhere else.
 */
export const SESSION_SCOPES = {
  chat: "chat",
  assistantSetup: "assistant-setup",
  mcpKeys: "mcp-keys",
} as const;

export type AssistantSessionScope =
  (typeof SESSION_SCOPES)[keyof typeof SESSION_SCOPES];
