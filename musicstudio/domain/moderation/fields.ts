/**
 * The text fields content policy inspection covers, and which of them specify
 * musical style.
 *
 * Requirement 16.1 names three: caption, lyrics and the natural-language
 * description. Requirement 16.10 adds the dialogue script as a fourth, inspected
 * by the same pipeline rather than a parallel one.
 *
 * Requirement 26.16 (task 6.2) adds two more texts to the same pipeline. They are
 * members here rather than a separate vocabulary because 26.16 checks them against
 * the *same* six classifications as Requirement 16 — see
 * `domain/voice/prohibited-use.ts`. A parallel field list would have meant a parallel
 * classifier.
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
  /** Requirement 26.16 — 참조 음성 샘플의 참조 텍스트 (Requirement 26.6 produces it). */
  'voice_reference_transcript',
  /** Requirement 26.16 — 음성 변환 요청의 프로필 지정 정보. */
  'voice_conversion_profile_designation',
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

/**
 * Fields where a self-identification frame is read as an impersonation claim.
 *
 * Requirement 16.11 names the dialogue script. Requirement 26.16 extends the same six
 * classifications — impersonation among them — to a reference sample's transcript and
 * to a voice conversion's profile designation, so the frames apply there too: a
 * reference transcript reading "저는 대통령입니다" is precisely what 26.16 is for.
 *
 * Captions and lyrics stay out. A caption naming a real artist is a style request that
 * Requirement 16.3 rewrites, and a lyric is the content of the song rather than a claim
 * about who is speaking.
 */
export const IMPERSONATION_CHECKED_FIELDS: readonly ModerationField[] = [
  'dialogue_script',
  'voice_reference_transcript',
  'voice_conversion_profile_designation',
];

export function isImpersonationCheckedField(field: ModerationField): boolean {
  return IMPERSONATION_CHECKED_FIELDS.includes(field);
}

export function isModerationField(value: unknown): value is ModerationField {
  return typeof value === 'string' && (MODERATION_FIELDS as readonly string[]).includes(value);
}

export function isStyleBearingField(field: ModerationField): boolean {
  return STYLE_BEARING_FIELDS.includes(field);
}
