import {
  CONSENT_ITEMS,
  SPEAKER_RELATIONSHIPS,
} from '../../../domain/voice/consent-record';
import { VOICE_PROFILE_CONSENT_STATES } from '../../../domain/voice/consent-state';
import { MAX_SHARED_USERS, MIN_SHARED_USERS } from '../../../domain/voice/sharing-list';
import { IDENTITY_EVIDENCE_KINDS } from '../../../services/voice/ports';

/**
 * Consent, withdrawal, verification and objection schemas
 * (Requirements 26.12–26.23, 26.26–26.36).
 *
 * Every enumeration and bound is imported rather than restated, so edge validation and
 * the rules in `domain/voice/` cannot drift.
 */

const errorResponse = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message'],
      properties: { code: { type: 'string' }, message: { type: 'string' } },
      additionalProperties: true,
    },
  },
} as const;

const profileIdParams = {
  type: 'object',
  required: ['voiceProfileId'],
  properties: { voiceProfileId: { type: 'string', minLength: 1, maxLength: 64 } },
} as const;

const consentStateBody = {
  type: 'object',
  required: ['voiceProfileId', 'consentState'],
  properties: {
    voiceProfileId: { type: 'string' },
    consentState: { type: 'string', enum: [...VOICE_PROFILE_CONSENT_STATES] },
    withdrawalReasonCode: { type: ['string', 'null'] },
    // Requirement 26.30 vs 26.33, surfaced so a client — and task 5.3 — can see which
    // stage the profile is in without re-deriving the rule.
    refusesGeneration: { type: 'boolean' },
    unpublishDue: { type: 'boolean' },
    identityVerificationDueAtMs: { type: ['integer', 'null'] },
  },
} as const;

/** Requirement 26.12/26.13 — the `cloned` profile consent record. */
export const recordCloneConsentSchema = {
  params: profileIdParams,
  body: {
    type: 'object',
    required: [
      'isSpeaker',
      'hasExplicitPermission',
      'prohibitedUseConfirmation',
      'speakerRelationship',
    ],
    properties: {
      isSpeaker: { type: 'boolean' },
      hasExplicitPermission: { type: 'boolean' },
      prohibitedUseConfirmation: { type: 'boolean' },
      speakerRelationship: { type: 'string', enum: [...SPEAKER_RELATIONSHIPS] },
      speakerIdentity: { type: 'string', minLength: 1, maxLength: 512 },
      withdrawalContact: { type: 'string', minLength: 1, maxLength: 512 },
    },
    additionalProperties: false,
  },
  response: {
    201: {
      type: 'object',
      required: ['consentRecordId', 'voiceProfileId'],
      properties: {
        consentRecordId: { type: 'string' },
        voiceProfileId: { type: 'string' },
        submittedAtMs: { type: 'integer' },
        // Requirement 26.27.
        responsibleUse: { type: 'object', additionalProperties: true },
      },
    },
    400: errorResponse,
    401: errorResponse,
    404: errorResponse,
    422: errorResponse,
  },
} as const;

/** Requirement 26.26 — the voice conversion consent record. */
export const recordVoiceConvertConsentSchema = {
  params: profileIdParams,
  body: {
    type: 'object',
    required: ['sourceRightsConfirmation', 'prohibitedUseConfirmation'],
    properties: {
      sourceRightsConfirmation: { type: 'boolean' },
      prohibitedUseConfirmation: { type: 'boolean' },
    },
    additionalProperties: false,
  },
  response: {
    201: {
      type: 'object',
      required: ['consentRecordId', 'voiceProfileId'],
      properties: {
        consentRecordId: { type: 'string' },
        voiceProfileId: { type: 'string' },
        submittedAtMs: { type: 'integer' },
        responsibleUse: { type: 'object', additionalProperties: true },
      },
    },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    404: errorResponse,
    422: errorResponse,
  },
} as const;

/**
 * Requirement 26.28 — withdrawal intake.
 *
 * **Not behind the auth middleware.** The claimant is the speaker or their agent, who may
 * hold no account at all: 26.28 admits a claim arriving through the contact recorded on a
 * `제3자_허가보유` consent record. Requiring a session would shut out exactly the person
 * the record exists to protect. The claim is attributed when a session happens to be
 * present, and is otherwise recorded against the intake channel.
 */
export const submitWithdrawalSchema = {
  params: profileIdParams,
  body: {
    type: 'object',
    required: ['intakeChannel'],
    properties: {
      intakeChannel: { type: 'string', enum: ['recorded_contact', 'in_product'] },
      statement: { type: 'string', minLength: 1, maxLength: 2_000 },
    },
    additionalProperties: false,
  },
  response: {
    202: {
      type: 'object',
      required: ['withdrawalClaimId', 'voiceProfileId', 'consentState'],
      properties: {
        withdrawalClaimId: { type: 'string' },
        voiceProfileId: { type: 'string' },
        consentState: { type: 'string', enum: [...VOICE_PROFILE_CONSENT_STATES] },
        // Requirement 26.31.
        identityVerificationDueAtMs: { type: 'integer' },
        // Requirement 26.28 — how the owner objects.
        objectionUrl: { type: 'string' },
        // Requirement 26.30 — stated so a client cannot assume assets changed.
        existingAssetVisibilityUnchanged: { type: 'boolean' },
      },
    },
    400: errorResponse,
    404: errorResponse,
    409: errorResponse,
    // Requirement 26.35.
    429: errorResponse,
  },
} as const;

/** Requirement 26.31/26.32/26.34 — identity evidence. Unauthenticated, as above. */
export const submitIdentityEvidenceSchema = {
  params: profileIdParams,
  body: {
    type: 'object',
    required: ['withdrawalClaimId', 'kind', 'evidenceRef'],
    properties: {
      withdrawalClaimId: { type: 'string', minLength: 1, maxLength: 64 },
      kind: { type: 'string', enum: [...IDENTITY_EVIDENCE_KINDS] },
      evidenceRef: { type: 'string', minLength: 1, maxLength: 512 },
    },
    additionalProperties: false,
  },
  response: {
    200: consentStateBody,
    400: errorResponse,
    404: errorResponse,
    409: errorResponse,
  },
} as const;

/** Requirement 26.36 — the owner's objection. Owner only, so authenticated. */
export const submitObjectionSchema = {
  params: profileIdParams,
  body: {
    type: 'object',
    required: ['objection'],
    properties: { objection: { type: 'string', minLength: 1, maxLength: 4_000 } },
    additionalProperties: false,
  },
  response: {
    202: {
      type: 'object',
      required: ['reviewItemId', 'voiceProfileId', 'consentState'],
      properties: {
        reviewItemId: { type: 'string' },
        voiceProfileId: { type: 'string' },
        consentState: { type: 'string', enum: [...VOICE_PROFILE_CONSENT_STATES] },
      },
    },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    404: errorResponse,
    // Requirement 26.36 — nothing to object to; the profile is not restricted.
    409: errorResponse,
  },
} as const;

/** Requirement 26.19 — replace the share list. */
export const setSharedUsersSchema = {
  params: profileIdParams,
  body: {
    type: 'object',
    required: ['sharedUserIds'],
    properties: {
      sharedUserIds: {
        type: 'array',
        items: { type: 'string', minLength: 1, maxLength: 64 },
        // Bound here as well as in the domain rule so a 1000-element body is refused
        // before it reaches the service, but the authoritative check stays in
        // `validateShareList` — the schema cannot see duplicates or the owner.
        minItems: MIN_SHARED_USERS,
        maxItems: MAX_SHARED_USERS,
      },
    },
    additionalProperties: false,
  },
  response: {
    200: {
      type: 'object',
      required: ['voiceProfileId', 'sharedUserIds'],
      properties: {
        voiceProfileId: { type: 'string' },
        sharedUserIds: { type: 'array', items: { type: 'string' } },
      },
    },
    400: errorResponse,
    401: errorResponse,
    403: errorResponse,
    404: errorResponse,
    422: errorResponse,
  },
} as const;

/** Requirements 26.21–26.23 — owner deletion. */
export const deleteProfileSchema = {
  params: profileIdParams,
  response: {
    200: {
      type: 'object',
      required: ['voiceProfileId', 'deletedAtMs', 'erasureDueAtMs'],
      properties: {
        voiceProfileId: { type: 'string' },
        deletedAtMs: { type: 'integer' },
        erasureDueAtMs: { type: 'integer' },
        // Requirement 26.23.
        generatedAssetsPreserved: { type: 'boolean' },
      },
    },
    401: errorResponse,
    403: errorResponse,
    404: errorResponse,
  },
} as const;

/** Requirement 26.29 — the state a caller needs to interpret a 403. */
export const getConsentStateSchema = {
  params: profileIdParams,
  response: { 200: consentStateBody, 401: errorResponse, 404: errorResponse },
} as const;

/** Requirement 26.27 — the responsible-use guidance both screens link to. */
export const getResponsibleUseSchema = {
  response: {
    200: {
      type: 'object',
      required: ['guideUrl', 'prohibitedUses'],
      properties: {
        guideUrl: { type: 'string' },
        prohibitedUses: {
          type: 'array',
          items: {
            type: 'object',
            properties: { class: { type: 'string' }, label: { type: 'string' } },
          },
        },
        withdrawalIntakeHours: { type: 'integer' },
        identityVerificationDays: { type: 'integer' },
        consentItems: { type: 'array', items: { type: 'string', enum: [...CONSENT_ITEMS] } },
      },
    },
  },
} as const;
