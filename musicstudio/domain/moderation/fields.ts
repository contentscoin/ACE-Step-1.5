/**
 * The text fields content policy inspection covers, and which of them specify
 * musical style.
 *
 * Requirement 16.1 names three: caption, lyrics and the natural-language
 * description. Requirement 16.10 adds the dialogue script as a fourth, inspected
 * by the same pipeline rather than a parallel one.
 */

export const MODERATION_FIELDS = [
  /** Requirement 16.1 — the asset caption. */
  'caption',
  /** Requirement 16.1 — lyrics text. */
  'lyrics',
  /** Requirement 16.1 — the free-form scene/style description. */
  'description',
  /** Requirement 16.10 — a script submitted for dialogue generation. */
  'dialogue_script',
] as const;

export type ModerationField = (typeof MODERATION_FIELDS)[number];

/**
 * Fields whose text steers musical style, and therefore the fields where a real
 * artist's name is a *style specification*.
 *
 * Requirement 16.3 applies only when the name is present "스타일 지정 목적으로" —
 * for the purpose of specifying style. Caption and description are the fields the
 * generation request uses as the style prompt, so a curated name appearing there
 * is read as a style request and substituted.
 *
 * Lyrics and dialogue scripts are excluded on purpose. They are the *content* of
 * the output, not a style instruction, and silently rewriting a lyric line would
 * change what the user wrote. A dialogue script that speaks as a real person is
 * not a style request either — Requirement 16.11 blocks it outright, and a block
 * is a strictly stronger response than a substitution.
 */
export const STYLE_BEARING_FIELDS: readonly ModerationField[] = ['caption', 'description'];

export function isModerationField(value: unknown): value is ModerationField {
  return typeof value === 'string' && (MODERATION_FIELDS as readonly string[]).includes(value);
}

export function isStyleBearingField(field: ModerationField): boolean {
  return STYLE_BEARING_FIELDS.includes(field);
}
