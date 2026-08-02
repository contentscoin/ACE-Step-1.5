/**
 * Rights-holder consent required on an upload (Requirements 16.4, 16.14).
 *
 * Both criteria say the same thing about different media: an upload used as input
 * to generation must be accompanied by the uploader's confirmation that they hold
 * the rights to it. 16.4 covers audio submitted for editing, 16.14 covers video
 * submitted for foley generation.
 *
 * A voice-cloning reference sample is deliberately *not* on that list. Requirement
 * 16.12 requires something stronger for it — a Voice_Consent_Record naming the
 * speaker — and a self-declared rights checkbox would be a weaker substitute
 * standing in for it.
 */

/** Why an upload was submitted, which is what decides the consent it needs. */
export const UPLOAD_PURPOSES = [
  /** Requirement 16.4 — audio uploaded for a cover/repaint/extract/extend task. */
  'audio_edit',
  /** Requirement 16.14 — video uploaded for foley (V2A) generation. */
  'foley_video',
  /** Requirement 16.12 — reference sample for voice cloning. */
  'voice_reference',
] as const;

export type UploadPurpose = (typeof UPLOAD_PURPOSES)[number];

/** Purposes that require the self-declared rights confirmation. */
export const RIGHTS_CONSENT_PURPOSES: readonly UploadPurpose[] = ['audio_edit', 'foley_video'];

/** The uploader's confirmation. Recorded with a time so it can be audited. */
export interface RightsConsentDeclaration {
  /** Must be `true`. A present-but-false declaration is a refusal, not consent. */
  readonly holdsRights: boolean;
  readonly acknowledgedAtMs: number;
}

export interface UploadDeclaration {
  readonly uploadId: string;
  readonly purpose: UploadPurpose;
  readonly mediaKind: 'audio' | 'video';
  readonly rightsConsent?: RightsConsentDeclaration;
}

export function requiresRightsConsent(purpose: UploadPurpose): boolean {
  return RIGHTS_CONSENT_PURPOSES.includes(purpose);
}

export function hasValidRightsConsent(upload: UploadDeclaration): boolean {
  if (!requiresRightsConsent(upload.purpose)) return true;
  const consent = upload.rightsConsent;
  return consent !== undefined && consent.holdsRights;
}

/** The uploads that still owe a rights confirmation, in submission order. */
export function uploadsMissingRightsConsent(
  uploads: readonly UploadDeclaration[],
): readonly UploadDeclaration[] {
  return uploads.filter((upload) => !hasValidRightsConsent(upload));
}
