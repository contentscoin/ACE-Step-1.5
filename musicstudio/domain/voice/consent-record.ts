/**
 * Voice_Consent_Record — the nine mandatory fields (design §9.3) and the rules that
 * decide whether a record permits cloning (Requirements 26.12, 26.13, 26.14).
 *
 * Two record kinds share the table because they share the retention and
 * immutability rules:
 *
 * - `clone` — Requirement 26.12's four items, taken *before* the reference sample is
 *   persisted. 26.13 discards the upload when they are not met, which is only
 *   possible if the check precedes storage.
 * - `voice_convert` — Requirement 26.26's two items, a precondition for creating the
 *   conversion Generation_Job.
 *
 * Immutability (26.14) is enforced in two layers: nothing here returns a mutated
 * record, and `db/migrations/0011_voice_consent.sql` refuses UPDATE outright, the same
 * way task 1.1 made the audit log append-only.
 */

/** Design §9.3 — 화자 관계 구분. */
export const SPEAKER_RELATIONSHIPS = ['본인', '제3자_허가보유'] as const;

export type SpeakerRelationship = (typeof SPEAKER_RELATIONSHIPS)[number];

export const CONSENT_RECORD_KINDS = ['clone', 'voice_convert'] as const;

export type ConsentRecordKind = (typeof CONSENT_RECORD_KINDS)[number];

/**
 * Requirement 26.12's four consent items, plus 26.26's two, by the names the
 * criteria use. 26.13 returns "충족되지 않은 동의 항목 이름 목록" — this is that
 * name vocabulary, so the response cannot drift from the requirement text.
 */
export const CONSENT_ITEMS = [
  /** 26.12 — 화자 본인 여부. */
  'is_speaker',
  /** 26.12 — 화자의 명시적 허가 보유 여부. */
  'has_explicit_permission',
  /** 26.12 / 26.26 — 금지 용도 미사용 확약. */
  'prohibited_use_confirmation',
  /** 26.12 — 화자 관계 구분. */
  'speaker_relationship',
  /** 26.14 — 제3자_허가보유인 경우 화자 식별 정보. */
  'speaker_identity',
  /** 26.14 — 제3자_허가보유인 경우 철회 접수 연락 수단. */
  'withdrawal_contact',
  /** 26.26 — 원본 음성 권리 보유 확약. */
  'source_rights_confirmation',
] as const;

export type ConsentItem = (typeof CONSENT_ITEMS)[number];

/** Design §9.3, in the table's own order. */
export interface CloneConsentRecordDraft {
  readonly kind: 'clone';
  readonly submitterId: string;
  readonly submittedAtMs: number;
  readonly isSpeaker: boolean;
  readonly hasExplicitPermission: boolean;
  readonly prohibitedUseConfirmation: boolean;
  readonly speakerRelationship: SpeakerRelationship;
  /** Required only when `speakerRelationship` is `제3자_허가보유` (26.14). */
  readonly speakerIdentity?: string | null;
  /** Required only when `speakerRelationship` is `제3자_허가보유` (26.14). */
  readonly withdrawalContact?: string | null;
  readonly targetProfileId: string;
}

/** Requirement 26.26 — the two confirmations a voice conversion needs. */
export interface VoiceConvertConsentRecordDraft {
  readonly kind: 'voice_convert';
  readonly submitterId: string;
  readonly submittedAtMs: number;
  readonly sourceRightsConfirmation: boolean;
  readonly prohibitedUseConfirmation: boolean;
  readonly targetProfileId: string;
}

export type VoiceConsentRecordDraft =
  | CloneConsentRecordDraft
  | VoiceConvertConsentRecordDraft;

export interface VoiceConsentRecord {
  readonly consentRecordId: string;
  readonly draft: VoiceConsentRecordDraft;
}

export type ConsentValidation =
  | { readonly outcome: 'accepted' }
  /** 26.13 / 26.26 — the item names that were not satisfied. */
  | { readonly outcome: 'rejected'; readonly unmetItems: readonly ConsentItem[] };

/**
 * Requirement 26.13 — which of 26.12's items a clone record fails.
 *
 * The disjunction matters and is easy to get backwards: the record is refused when
 * `is_speaker` **and** `has_explicit_permission` are *both* negative. Either one
 * alone is a sufficient basis — the speaker themselves needs no third-party
 * permission, and a permitted third party is not the speaker. Requiring both would
 * make every legitimate submission fail.
 *
 * `prohibited_use_confirmation` is separately mandatory: it is a promise about use,
 * not about identity, so nothing substitutes for it.
 */
export function validateCloneConsent(draft: CloneConsentRecordDraft): ConsentValidation {
  const unmet: ConsentItem[] = [];

  if (!draft.isSpeaker && !draft.hasExplicitPermission) {
    unmet.push('is_speaker', 'has_explicit_permission');
  }
  if (!draft.prohibitedUseConfirmation) {
    unmet.push('prohibited_use_confirmation');
  }

  // Requirement 26.14 — a third-party record without a speaker identity and a
  // withdrawal contact would leave the speaker no route to 26.28, which is the
  // criterion the whole withdrawal machine hangs on.
  if (draft.speakerRelationship === '제3자_허가보유') {
    if (isBlank(draft.speakerIdentity)) unmet.push('speaker_identity');
    if (isBlank(draft.withdrawalContact)) unmet.push('withdrawal_contact');
  }

  // A `본인` record claiming not to be the speaker contradicts itself. Reported
  // against the relationship field, because that is the item that is wrong.
  if (draft.speakerRelationship === '본인' && !draft.isSpeaker) {
    unmet.push('speaker_relationship');
  }

  return unmet.length === 0
    ? { outcome: 'accepted' }
    : { outcome: 'rejected', unmetItems: dedupe(unmet) };
}

/** Requirement 26.26 — both confirmations must be present and affirmative. */
export function validateVoiceConvertConsent(
  draft: VoiceConvertConsentRecordDraft,
): ConsentValidation {
  const unmet: ConsentItem[] = [];
  if (!draft.sourceRightsConfirmation) unmet.push('source_rights_confirmation');
  if (!draft.prohibitedUseConfirmation) unmet.push('prohibited_use_confirmation');

  return unmet.length === 0
    ? { outcome: 'accepted' }
    : { outcome: 'rejected', unmetItems: unmet };
}

export function validateConsent(draft: VoiceConsentRecordDraft): ConsentValidation {
  return draft.kind === 'clone'
    ? validateCloneConsent(draft)
    : validateVoiceConvertConsent(draft);
}

/**
 * Requirement 26.13 — an absent record is refused exactly like a negative one, and
 * names the items that were never answered.
 *
 * Absence and refusal share a response shape on purpose: a client fixing the request
 * needs the same list either way, and a distinct "missing" branch would be one more
 * thing every caller has to handle.
 */
export const CLONE_CONSENT_REQUIRED_ITEMS: readonly ConsentItem[] = [
  'is_speaker',
  'has_explicit_permission',
  'prohibited_use_confirmation',
  'speaker_relationship',
];

export const VOICE_CONVERT_CONSENT_REQUIRED_ITEMS: readonly ConsentItem[] = [
  'source_rights_confirmation',
  'prohibited_use_confirmation',
];

export function missingConsentRecord(kind: ConsentRecordKind): ConsentValidation {
  return {
    outcome: 'rejected',
    unmetItems:
      kind === 'clone' ? CLONE_CONSENT_REQUIRED_ITEMS : VOICE_CONVERT_CONSENT_REQUIRED_ITEMS,
  };
}

export function isConsentAccepted(validation: ConsentValidation): boolean {
  return validation.outcome === 'accepted';
}

export function isSpeakerRelationship(value: unknown): value is SpeakerRelationship {
  return typeof value === 'string' && (SPEAKER_RELATIONSHIPS as readonly string[]).includes(value);
}

function isBlank(value: string | null | undefined): boolean {
  return value === undefined || value === null || value.trim().length === 0;
}

function dedupe(items: readonly ConsentItem[]): readonly ConsentItem[] {
  return [...new Set(items)];
}
