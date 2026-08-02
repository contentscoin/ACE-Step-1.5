import type { FastifyInstance, preHandlerHookHandler } from 'fastify';

import { CONSENT_ITEMS, type SpeakerRelationship } from '../../../domain/voice/consent-record';
import {
  isProfileDeleted,
  refusesGenerationForWithdrawal,
  withdrawalReasonCodeOf,
  type VoiceProfileConsentState,
} from '../../../domain/voice/consent-state';
import type { ConsentService } from '../../../services/voice/consent-service';
import { profileNotFound } from '../../../services/voice/errors';
import type { IdentityEvidenceKind } from '../../../services/voice/ports';
import type { ProfileAccessService } from '../../../services/voice/profile-access-service';
import type { WithdrawalClaim } from '../../../services/voice/store';
import type { WithdrawalService } from '../../../services/voice/withdrawal-service';
import {
  deleteProfileSchema,
  getConsentStateSchema,
  getResponsibleUseSchema,
  recordCloneConsentSchema,
  recordVoiceConvertConsentSchema,
  setSharedUsersSchema,
  submitIdentityEvidenceSchema,
  submitObjectionSchema,
  submitWithdrawalSchema,
} from '../schemas/voice-consent-schemas';

/**
 * Consent, withdrawal, verification, objection, sharing and deletion routes
 * (Requirements 26.12–26.23, 26.26–26.36).
 *
 * ### Which routes require a session, and why
 *
 * Withdrawal intake and identity evidence are **unauthenticated**. Requirement 26.28
 * admits a claim arriving through the contact recorded on a `제3자_허가보유` consent
 * record, and that speaker may hold no account at all — requiring a session would shut
 * out precisely the person the record exists to protect. The claim is attributed when a
 * session is already on the request.
 *
 * Everything else is authenticated and owner-scoped: consent submission, the share list,
 * deletion and the objection.
 *
 * A profile that does not exist, and one that is deleted, both answer **404** (26.22), so
 * these endpoints cannot be used to enumerate other users' profiles.
 */
export interface VoiceConsentRouteOptions {
  readonly consent: ConsentService;
  readonly withdrawal: WithdrawalService;
  readonly access: ProfileAccessService;
  readonly authenticate: preHandlerHookHandler;
}

interface CloneConsentBody {
  readonly isSpeaker: boolean;
  readonly hasExplicitPermission: boolean;
  readonly prohibitedUseConfirmation: boolean;
  readonly speakerRelationship: SpeakerRelationship;
  readonly speakerIdentity?: string;
  readonly withdrawalContact?: string;
}

interface VoiceConvertConsentBody {
  readonly sourceRightsConfirmation: boolean;
  readonly prohibitedUseConfirmation: boolean;
}

export function registerVoiceConsentRoutes(
  app: FastifyInstance,
  options: VoiceConsentRouteOptions,
): void {
  const { consent, withdrawal, access } = options;

  function stateBody(voiceProfileId: string): Record<string, unknown> {
    const state = access.consentStateOf(voiceProfileId);
    // Requirement 26.22 — a deleted profile is indistinguishable from one that never
    // existed. Reporting `삭제됨` with a 200 would confirm the id had once been in use,
    // which is the enumeration this 404 exists to prevent.
    if (state === null || isProfileDeleted(state)) throw profileNotFound(voiceProfileId);

    return {
      voiceProfileId,
      consentState: state,
      withdrawalReasonCode: withdrawalReasonCodeOf(state),
      // Requirement 26.29.
      refusesGeneration: refusesGenerationForWithdrawal(state),
      // Requirement 26.30 vs 26.33 — the one difference between the two restricted
      // states, reported rather than left for a client to infer from the state name.
      unpublishDue: state === ('사용_중지' satisfies VoiceProfileConsentState),
      identityVerificationDueAtMs: withdrawal.verificationDeadlineOf(voiceProfileId),
    };
  }

  // Requirement 26.27 — the guidance both screens link to, in one request.
  app.get('/voice-profiles/responsible-use', { schema: getResponsibleUseSchema }, async () => ({
    ...consent.guidance(),
    consentItems: [...CONSENT_ITEMS],
  }));

  // Requirements 26.12–26.15.
  app.post<{ Params: { voiceProfileId: string }; Body: CloneConsentBody }>(
    '/voice-profiles/:voiceProfileId/consent',
    { schema: recordCloneConsentSchema, preHandler: options.authenticate },
    async (request, reply) => {
      const { voiceProfileId } = request.params;
      const submitterId = request.authenticatedAccount?.accountId ?? '';
      const submittedAtMs = Date.now();
      const body = request.body;

      const record = consent.requireCloneConsent({
        kind: 'clone',
        submitterId,
        submittedAtMs,
        isSpeaker: body.isSpeaker,
        hasExplicitPermission: body.hasExplicitPermission,
        prohibitedUseConfirmation: body.prohibitedUseConfirmation,
        speakerRelationship: body.speakerRelationship,
        ...(body.speakerIdentity === undefined ? {} : { speakerIdentity: body.speakerIdentity }),
        ...(body.withdrawalContact === undefined
          ? {}
          : { withdrawalContact: body.withdrawalContact }),
        targetProfileId: voiceProfileId,
      });

      return reply.code(201).send({
        consentRecordId: record.consentRecordId,
        voiceProfileId,
        submittedAtMs: record.draft.submittedAtMs,
        // Requirement 26.27 — returned with the record so the creation screen has the
        // link without a second round trip.
        responsibleUse: consent.guidance(),
      });
    },
  );

  // Requirement 26.26 — the conversion precondition. The profile must also be usable by
  // the caller (26.20, 26.29), which is why `assertUsable` runs before the record is
  // stored: a conversion against a withdrawn profile is refused, not recorded.
  app.post<{ Params: { voiceProfileId: string }; Body: VoiceConvertConsentBody }>(
    '/voice-profiles/:voiceProfileId/conversion-consent',
    { schema: recordVoiceConvertConsentSchema, preHandler: options.authenticate },
    async (request, reply) => {
      const { voiceProfileId } = request.params;
      const submitterId = request.authenticatedAccount?.accountId ?? '';
      access.assertUsable(voiceProfileId, submitterId);

      const record = consent.requireVoiceConvertConsent({
        kind: 'voice_convert',
        submitterId,
        submittedAtMs: Date.now(),
        sourceRightsConfirmation: request.body.sourceRightsConfirmation,
        prohibitedUseConfirmation: request.body.prohibitedUseConfirmation,
        targetProfileId: voiceProfileId,
      });

      return reply.code(201).send({
        consentRecordId: record.consentRecordId,
        voiceProfileId,
        submittedAtMs: record.draft.submittedAtMs,
        responsibleUse: consent.guidance(),
      });
    },
  );

  // Requirement 26.28 — unauthenticated; see the module comment.
  app.post<{
    Params: { voiceProfileId: string };
    Body: { intakeChannel: WithdrawalClaim['intakeChannel']; statement?: string };
  }>(
    '/voice-profiles/:voiceProfileId/withdrawals',
    { schema: submitWithdrawalSchema },
    async (request, reply) => {
      const result = withdrawal.receiveWithdrawal({
        voiceProfileId: request.params.voiceProfileId,
        claimantAccountId: request.authenticatedAccount?.accountId ?? null,
        intakeChannel: request.body.intakeChannel,
      });

      // 202: the claim is accepted and the profile provisionally restricted; whether the
      // withdrawal completes is not yet decided, which is what 26.28 promises and no more.
      return reply.code(202).send({
        withdrawalClaimId: result.claim.withdrawalClaimId,
        voiceProfileId: result.claim.voiceProfileId,
        consentState: result.transition.to,
        identityVerificationDueAtMs: result.identityVerificationDueAtMs,
        objectionUrl: result.objectionUrl,
        // Requirement 26.30, asserted in the response so a client cannot assume a
        // provisional restriction hid its published work.
        existingAssetVisibilityUnchanged: true,
      });
    },
  );

  // Requirements 26.31, 26.32, 26.34 — unauthenticated, for the same reason.
  app.post<{
    Params: { voiceProfileId: string };
    Body: { withdrawalClaimId: string; kind: IdentityEvidenceKind; evidenceRef: string };
  }>(
    '/voice-profiles/:voiceProfileId/withdrawals/identity-evidence',
    { schema: submitIdentityEvidenceSchema },
    async (request) => {
      const { voiceProfileId } = request.params;
      withdrawal.submitIdentityEvidence(voiceProfileId, {
        withdrawalClaimId: request.body.withdrawalClaimId,
        kind: request.body.kind,
        evidenceRef: request.body.evidenceRef,
      });

      return stateBody(voiceProfileId);
    },
  );

  // Requirement 26.36 — owner only.
  app.post<{ Params: { voiceProfileId: string }; Body: { objection: string } }>(
    '/voice-profiles/:voiceProfileId/withdrawals/objection',
    { schema: submitObjectionSchema, preHandler: options.authenticate },
    async (request, reply) => {
      const { voiceProfileId } = request.params;
      const ownerId = request.authenticatedAccount?.accountId ?? '';
      // An objection is an owner action, so ownership is checked the same way the share
      // list and deletion check it.
      access.assertOwner(voiceProfileId, ownerId);

      const reviewItemId = withdrawal.submitObjection({
        voiceProfileId,
        ownerId,
        objection: request.body.objection,
      });

      return reply.code(202).send({
        reviewItemId,
        voiceProfileId,
        // Requirement 26.36 — an objection raises a review item; it does not lift the
        // restriction. Returning the unchanged state makes that explicit.
        consentState: access.consentStateOf(voiceProfileId),
      });
    },
  );

  // Requirement 26.19.
  app.put<{ Params: { voiceProfileId: string }; Body: { sharedUserIds: readonly string[] } }>(
    '/voice-profiles/:voiceProfileId/shared-users',
    { schema: setSharedUsersSchema, preHandler: options.authenticate },
    async (request) => {
      const { voiceProfileId } = request.params;
      const sharedUserIds = access.setSharedUsers(
        voiceProfileId,
        request.authenticatedAccount?.accountId ?? '',
        request.body.sharedUserIds,
      );

      return { voiceProfileId, sharedUserIds };
    },
  );

  // Requirements 26.21–26.23.
  app.delete<{ Params: { voiceProfileId: string } }>(
    '/voice-profiles/:voiceProfileId',
    { schema: deleteProfileSchema, preHandler: options.authenticate },
    async (request) =>
      access.deleteProfile(
        request.params.voiceProfileId,
        request.authenticatedAccount?.accountId ?? '',
      ),
  );

  // Requirement 26.29 — lets a caller interpret the 403 it just received.
  app.get<{ Params: { voiceProfileId: string } }>(
    '/voice-profiles/:voiceProfileId/consent-state',
    { schema: getConsentStateSchema, preHandler: options.authenticate },
    async (request) => stateBody(request.params.voiceProfileId),
  );
}
