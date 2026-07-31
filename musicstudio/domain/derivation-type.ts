/**
 * Derivation types recorded on every lineage edge (design §4.2, Requirement 19.6).
 *
 * Exactly one of these is stored per parent→child relationship, so the set is
 * closed: the SQL enum `derivation_type` in `db/migrations/0001_enums.sql` lists
 * the same members in the same order.
 */

export const DERIVATION_TYPES = [
  'cover',
  'repaint',
  'extract',
  'lego',
  'complete',
  'stem_split',
  'mixdown',
  'effect_apply',
  'voice_convert',
] as const;

export type DerivationType = (typeof DERIVATION_TYPES)[number];

export function isDerivationType(value: unknown): value is DerivationType {
  return typeof value === 'string' && (DERIVATION_TYPES as readonly string[]).includes(value);
}
