import type { LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RESPONSIBLE_USE_GUIDE_PATH } from '../../services/voice/responsible-use';
import {
  createGatewayHarness,
  requireVoiceConsent,
  type GatewayHarness,
  type GatewayVoiceConsentHarness,
} from '../support/gateway-harness';

/**
 * Requirement 26 over HTTP, through the real gateway (Requirements 26.12–26.23,
 * 26.26–26.36).
 *
 * The suite is built around task 6.2's acceptance criterion — 동의 철회 접수 → 잠정 →
 * 사용 중지 → 삭제, plus the 14-day lapse restoring the profile — and every window is
 * crossed by advancing the harness clock, which the gateway and the services share.
 * Nothing sleeps.
 *
 * The auth middleware, the JSON schemas and the single error contract from task 1.2 are
 * all on the request path. Only the stores, the identity verifier and Sharing_Service's
 * seam are fakes.
 */

const OWNER = { email: 'owner@example.com', password: 'correct horse battery staple' };
const FRIEND = { email: 'friend@example.com', password: 'another correct horse battery' };
const PROFILE = 'voice-profile-1';

let harness: GatewayHarness;
let voice: GatewayVoiceConsentHarness;
let ownerToken = '';
let ownerId = '';
let friendToken = '';
let friendId = '';

async function signUp(credentials: {
  email: string;
  password: string;
}): Promise<{ token: string; accountId: string }> {
  await harness.app.inject({ method: 'POST', url: '/v1/auth/register', payload: credentials });
  const loggedIn = await harness.app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: credentials,
  });
  const body = loggedIn.json<{ accessToken: string; accountId: string }>();
  return { token: body.accessToken, accountId: body.accountId };
}

function as(
  token: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  const headers = { authorization: `Bearer ${token}` };

  return payload === undefined
    ? harness.app.inject({ method, url, headers })
    : harness.app.inject({ method, url, headers, payload });
}

/**
 * Re-issue the owner's access token.
 *
 * The gateway and the voice services share one clock on purpose, so advancing it past a
 * Requirement 26 window also advances it past the Requirement 1.3 access token lifetime.
 * That is the correct behaviour of both rules meeting, not a test artefact — a caller
 * really does have to sign in again after fourteen days — so the test signs in again
 * rather than freezing one of the two clocks.
 */
async function reauthenticateOwner(): Promise<void> {
  const loggedIn = await harness.app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: OWNER,
  });
  ownerToken = loggedIn.json<{ accessToken: string }>().accessToken;
}

const affirmativeConsent = {
  isSpeaker: true,
  hasExplicitPermission: false,
  prohibitedUseConfirmation: true,
  speakerRelationship: '본인',
};

function submitWithdrawal(): Promise<LightMyRequestResponse> {
  return harness.app.inject({
    method: 'POST',
    url: `/v1/voice-profiles/${PROFILE}/withdrawals`,
    payload: { intakeChannel: 'recorded_contact' },
  });
}

function submitEvidence(withdrawalClaimId: string): Promise<LightMyRequestResponse> {
  return harness.app.inject({
    method: 'POST',
    url: `/v1/voice-profiles/${PROFILE}/withdrawals/identity-evidence`,
    payload: { withdrawalClaimId, kind: 'challenge_phrase_recording', evidenceRef: 'upload-1' },
  });
}

beforeEach(async () => {
  harness = createGatewayHarness({ voiceConsent: true });
  voice = requireVoiceConsent(harness);

  const owner = await signUp(OWNER);
  ownerToken = owner.token;
  ownerId = owner.accountId;
  const friend = await signUp(FRIEND);
  friendToken = friend.token;
  friendId = friend.accountId;

  voice.profiles.create({ voiceProfileId: PROFILE, ownerId });
  voice.visibility.publish(PROFILE, ['asset-1', 'asset-2']);
});

afterEach(async () => {
  await harness.close();
});

describe('Requirements 26.12–26.15 — consent submission', () => {
  it('records an affirmative clone consent and returns the 26.27 guidance with it', async () => {
    const response = await as(
      ownerToken,
      'POST',
      `/v1/voice-profiles/${PROFILE}/consent`,
      affirmativeConsent,
    );

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      voiceProfileId: PROFILE,
      responsibleUse: { withdrawalIntakeHours: 24, identityVerificationDays: 14 },
    });
    expect(voice.auditOf('consent_recorded')).toHaveLength(1);
  });

  it('26.13 — refuses a record whose consent items are unmet, naming them', async () => {
    const response = await as(ownerToken, 'POST', `/v1/voice-profiles/${PROFILE}/consent`, {
      ...affirmativeConsent,
      prohibitedUseConfirmation: false,
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      error: {
        code: 'voice_consent_incomplete',
        unmetItems: ['prohibited_use_confirmation'],
        creditsCharged: 0,
      },
    });
    expect(voice.records.all).toEqual([]);
  });

  it('26.14 — refuses a third-party record with no withdrawal contact', async () => {
    const response = await as(ownerToken, 'POST', `/v1/voice-profiles/${PROFILE}/consent`, {
      isSpeaker: false,
      hasExplicitPermission: true,
      prohibitedUseConfirmation: true,
      speakerRelationship: '제3자_허가보유',
      speakerIdentity: '이서준',
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.unmetItems).toEqual(['withdrawal_contact']);
  });

  it('requires a session', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: `/v1/voice-profiles/${PROFILE}/consent`,
      payload: affirmativeConsent,
    });

    expect(response.statusCode).toBe(401);
  });
});

describe('Requirement 26.26 — voice conversion needs the two confirmations first', () => {
  it('records both confirmations', async () => {
    const response = await as(
      ownerToken,
      'POST',
      `/v1/voice-profiles/${PROFILE}/conversion-consent`,
      { sourceRightsConfirmation: true, prohibitedUseConfirmation: true },
    );

    expect(response.statusCode).toBe(201);
  });

  it('refuses a request missing one of them and charges nothing', async () => {
    const response = await as(
      ownerToken,
      'POST',
      `/v1/voice-profiles/${PROFILE}/conversion-consent`,
      { sourceRightsConfirmation: false, prohibitedUseConfirmation: true },
    );

    expect(response.statusCode).toBe(422);
    expect(response.json().error).toMatchObject({
      unmetItems: ['source_rights_confirmation'],
      creditsCharged: 0,
    });
  });

  it('26.20 — refuses a caller who is not permitted to use the profile', async () => {
    const response = await as(
      friendToken,
      'POST',
      `/v1/voice-profiles/${PROFILE}/conversion-consent`,
      { sourceRightsConfirmation: true, prohibitedUseConfirmation: true },
    );

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('voice_profile_forbidden');
    // 26.26: the record is not stored for a request that is refused anyway.
    expect(voice.records.all).toEqual([]);
  });
});

describe('Requirement 26.27 — responsible-use guidance in one action', () => {
  it('is reachable without a session and names the six prohibited uses', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/v1/voice-profiles/responsible-use',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      guideUrl: string;
      prohibitedUses: { class: string; label: string }[];
    }>();
    expect(body.guideUrl).toContain(RESPONSIBLE_USE_GUIDE_PATH);
    expect(body.prohibitedUses).toHaveLength(6);
    expect(body.prohibitedUses.map((entry) => entry.label)).toContain('사칭');
  });
});

describe('Requirements 26.18–26.20 — the share list', () => {
  it('26.19 — the owner shares with a named user', async () => {
    const response = await as(ownerToken, 'PUT', `/v1/voice-profiles/${PROFILE}/shared-users`, {
      sharedUserIds: [friendId],
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ voiceProfileId: PROFILE, sharedUserIds: [friendId] });
    expect(voice.auditOf('voice_profile_sharing_changed')).toHaveLength(1);
  });

  it('26.19 — refuses 51 users at the schema edge, before the service is reached', async () => {
    const response = await as(ownerToken, 'PUT', `/v1/voice-profiles/${PROFILE}/shared-users`, {
      sharedUserIds: Array.from({ length: 51 }, (_unused, index) => `user-${String(index)}`),
    });

    expect(response.statusCode).toBe(400);
    expect(voice.auditOf('voice_profile_sharing_changed')).toEqual([]);
  });

  it('26.19 — refuses an empty list', async () => {
    const response = await as(ownerToken, 'PUT', `/v1/voice-profiles/${PROFILE}/shared-users`, {
      sharedUserIds: [],
    });

    expect(response.statusCode).toBe(400);
  });

  it('26.20 — a non-listed user gets 403 from the consent-state endpoint too', async () => {
    const response = await as(
      friendToken,
      'POST',
      `/v1/voice-profiles/${PROFILE}/conversion-consent`,
      { sourceRightsConfirmation: true, prohibitedUseConfirmation: true },
    );

    expect(response.statusCode).toBe(403);
  });

  it('refuses a non-owner editing the share list', async () => {
    const response = await as(friendToken, 'PUT', `/v1/voice-profiles/${PROFILE}/shared-users`, {
      sharedUserIds: [ownerId],
    });

    expect(response.statusCode).toBe(403);
  });
});

describe('the two-stage withdrawal, end to end (26.28 → 26.32 → 26.33 → deletion)', () => {
  it('walks 정상 → 잠정_사용_제한 → 사용_중지, unpublishing only at the second stage', async () => {
    // Stage 0 — the profile is usable and its assets are public.
    expect(voice.access.isUsable(PROFILE, ownerId)).toBe(true);

    // 26.28 — intake, from an unauthenticated claimant.
    const intake = await submitWithdrawal();
    expect(intake.statusCode).toBe(202);
    const claim = intake.json<{
      withdrawalClaimId: string;
      consentState: string;
      identityVerificationDueAtMs: number;
      objectionUrl: string;
      existingAssetVisibilityUnchanged: boolean;
    }>();
    expect(claim.consentState).toBe('잠정_사용_제한');
    expect(claim.existingAssetVisibilityUnchanged).toBe(true);
    expect(claim.objectionUrl).toContain('objection');

    // 26.30 — the provisional stage did not touch visibility at all.
    expect(voice.visibility.privateCalls).toEqual([]);
    expect(voice.visibility.publicAssetsOf(PROFILE)).toEqual(['asset-1', 'asset-2']);

    // 26.29 — generation is refused, with the reason code, and nothing is charged.
    const state = await as(ownerToken, 'GET', `/v1/voice-profiles/${PROFILE}/consent-state`);
    expect(state.json()).toMatchObject({
      consentState: '잠정_사용_제한',
      withdrawalReasonCode: 'consent_withdrawal_pending_verification',
      refusesGeneration: true,
      // 26.30 vs 26.33, reported rather than left for a client to derive.
      unpublishDue: false,
      identityVerificationDueAtMs: claim.identityVerificationDueAtMs,
    });

    // 26.31/26.32 — verification succeeds inside the 14-day window.
    voice.advanceDays(3);
    await reauthenticateOwner();
    voice.identity.setVerdict('verified');
    const verified = await submitEvidence(claim.withdrawalClaimId);
    expect(verified.statusCode).toBe(200);
    expect(verified.json()).toMatchObject({
      consentState: '사용_중지',
      withdrawalReasonCode: 'consent_withdrawn',
      refusesGeneration: true,
      // 26.33 — and only now.
      unpublishDue: true,
    });

    // 26.33 — public assets become private within 24 hours, and the owner is told which.
    expect(voice.visibility.publicAssetsOf(PROFILE)).toEqual([]);
    expect(voice.visibility.privateCalls).toHaveLength(1);
    expect(voice.notifications.notices.map((notice) => notice.kind)).toEqual([
      'withdrawal_received',
      'assets_made_private',
    ]);

    // 26.32 — reference samples, embeddings and caches are erased within 24 hours.
    expect(voice.erasure.calls).toHaveLength(1);

    // 26.15/26.28/26.32 — the whole flow is auditable.
    expect(voice.auditOf('consent_withdrawal_received')).toHaveLength(1);
    expect(voice.auditOf('consent_withdrawal_verified')).toHaveLength(1);
    expect(voice.auditOf('visibility_changed')).toHaveLength(1);

    // 26.21/26.22 — the owner's deletion then answers 404 for further requests.
    const deleted = await as(ownerToken, 'DELETE', `/v1/voice-profiles/${PROFILE}`);
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toMatchObject({ generatedAssetsPreserved: true });

    const afterDeletion = await as(ownerToken, 'GET', `/v1/voice-profiles/${PROFILE}/consent-state`);
    expect(afterDeletion.statusCode).toBe(404);
  });

  it('26.34 — restores the profile when nothing is submitted within 14 days', async () => {
    await submitWithdrawal();
    expect(voice.access.consentStateOf(PROFILE)).toBe('잠정_사용_제한');

    // Day 13: still restricted, still nothing unpublished.
    voice.advanceDays(13);
    expect(voice.withdrawal.expireVerification(PROFILE)).toBeNull();
    expect(voice.access.consentStateOf(PROFILE)).toBe('잠정_사용_제한');

    // Day 14: the sweep restores the profile.
    voice.advanceDays(1);
    expect(voice.withdrawal.lapsedProfileIds([PROFILE])).toEqual([PROFILE]);
    voice.withdrawal.expireVerification(PROFILE);

    await reauthenticateOwner();
    const state = await as(ownerToken, 'GET', `/v1/voice-profiles/${PROFILE}/consent-state`);
    expect(state.json()).toMatchObject({
      consentState: '정상',
      withdrawalReasonCode: null,
      refusesGeneration: false,
      unpublishDue: false,
    });
    // 26.30 held throughout, so there is nothing to republish.
    expect(voice.visibility.publicAssetsOf(PROFILE)).toEqual(['asset-1', 'asset-2']);
    expect(voice.auditOf('consent_withdrawal_reverted')).toHaveLength(1);
  });

  it('26.34 — restores the profile on a failed verification', async () => {
    const claim = (await submitWithdrawal()).json<{ withdrawalClaimId: string }>();
    voice.identity.setVerdict('rejected');

    const response = await submitEvidence(claim.withdrawalClaimId);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ consentState: '정상', refusesGeneration: false });
    expect(voice.visibility.privateCalls).toEqual([]);
  });

  it('26.28 — intake needs no session, so a speaker with no account can withdraw', async () => {
    const response = await submitWithdrawal();

    expect(response.statusCode).toBe(202);
    expect(voice.claims.all[0]?.claimantAccountId).toBeNull();
    expect(voice.claims.all[0]?.intakeChannel).toBe('recorded_contact');
  });

  it('26.22 — a withdrawal against an unknown profile is 404, not 403', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/voice-profiles/voice-unknown/withdrawals',
      payload: { intakeChannel: 'in_product' },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('voice_profile_not_found');
  });

  it('26.35 — the fourth claim in 30 days is refused with the next eligible instant', async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const claim = (await submitWithdrawal()).json<{ withdrawalClaimId: string }>();
      voice.identity.setVerdict('rejected');
      await submitEvidence(claim.withdrawalClaimId);
      voice.advanceDays(1);
    }

    const fourth = await submitWithdrawal();

    expect(fourth.statusCode).toBe(429);
    expect(fourth.json().error).toMatchObject({
      code: 'withdrawal_claim_cap_exceeded',
      limit: 3,
      countInWindow: 3,
      windowDays: 30,
    });
    // The refused claim left the profile alone.
    expect(voice.access.consentStateOf(PROFILE)).toBe('정상');
  });
});

describe('Requirement 26.36 — the owner objects', () => {
  it('raises an operator review item carrying the consent record and the objection', async () => {
    await as(ownerToken, 'POST', `/v1/voice-profiles/${PROFILE}/consent`, affirmativeConsent);
    await submitWithdrawal();

    const response = await as(
      ownerToken,
      'POST',
      `/v1/voice-profiles/${PROFILE}/withdrawals/objection`,
      { objection: '철회 제출자는 화자가 아닙니다.' },
    );

    expect(response.statusCode).toBe(202);
    // An objection raises a review item; it does not lift the restriction.
    expect(response.json()).toMatchObject({ consentState: '잠정_사용_제한' });
    expect(voice.operatorReview.items).toHaveLength(1);
    expect(voice.operatorReview.items[0]).toMatchObject({
      ownerId,
      objection: '철회 제출자는 화자가 아닙니다.',
    });
    expect(voice.operatorReview.items[0]?.consentRecords).toHaveLength(1);
    expect(voice.auditOf('consent_withdrawal_objection')).toHaveLength(1);
  });

  it('refuses an objection from anyone but the owner', async () => {
    await submitWithdrawal();
    const response = await as(
      friendToken,
      'POST',
      `/v1/voice-profiles/${PROFILE}/withdrawals/objection`,
      { objection: 'not mine' },
    );

    expect(response.statusCode).toBe(403);
    expect(voice.operatorReview.items).toEqual([]);
  });

  it('refuses an objection when there is no restriction to object to', async () => {
    const response = await as(
      ownerToken,
      'POST',
      `/v1/voice-profiles/${PROFILE}/withdrawals/objection`,
      { objection: '이의' },
    );

    expect(response.statusCode).toBe(409);
  });
});

describe('Requirements 26.21–26.23 — owner deletion over HTTP', () => {
  it('erases reference data within 24 hours and preserves generated assets', async () => {
    const response = await as(ownerToken, 'DELETE', `/v1/voice-profiles/${PROFILE}`);
    const body = response.json<{ deletedAtMs: number; erasureDueAtMs: number }>();

    expect(response.statusCode).toBe(200);
    expect(body.erasureDueAtMs - body.deletedAtMs).toBe(24 * 3_600_000);
    expect(voice.erasure.calls).toHaveLength(1);
    // 26.23 — the back catalogue is untouched, unlike 26.33's withdrawal path.
    expect(voice.visibility.publicAssetsOf(PROFILE)).toEqual(['asset-1', 'asset-2']);
    expect(voice.auditOf('voice_profile_deleted')).toHaveLength(1);
  });

  it('26.22 — a request naming a deleted profile is 404', async () => {
    await as(ownerToken, 'DELETE', `/v1/voice-profiles/${PROFILE}`);
    const response = await as(ownerToken, 'DELETE', `/v1/voice-profiles/${PROFILE}`);

    expect(response.statusCode).toBe(404);
    expect(voice.erasure.calls).toHaveLength(1);
  });

  it('refuses deletion by a non-owner', async () => {
    const response = await as(friendToken, 'DELETE', `/v1/voice-profiles/${PROFILE}`);

    expect(response.statusCode).toBe(403);
  });
});
