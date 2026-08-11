import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createGatewayHarness,
  requireGeneration,
  requireVoiceConsent,
  type GatewayHarness,
} from '../support/gateway-harness';
import { createModerationHarness, type ModerationHarness } from '../support/moderation-harness';

/**
 * 안전 플로 — 정책 위반 차단 → 동의 없는 음성 복제 거부.
 *
 * **Validates: Requirements 16.2, 16.12, 26.13**
 *
 * Two refusals, and what the flow adds to the per-clause tests is the *absence* that follows
 * each: a blocked request leaves no job and no charge, and an incomplete consent leaves no
 * record. A refusal that returns the right status code and still writes something is the failure
 * mode a status-code assertion cannot see, and it is the one that matters here — a charge for
 * generation that never happened, or a consent record for a permission never given.
 */

let harness: GatewayHarness;

const CREDENTIALS = { email: 'safety@studio.test', password: 'correct-horse-battery-staple' };
const PROFILE = 'voice-profile-1';

let token = '';

async function signIn(): Promise<void> {
  await harness.app.inject({ method: 'POST', url: '/v1/auth/register', payload: CREDENTIALS });
  const login = await harness.app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: CREDENTIALS,
  });
  token = login.json<{ accessToken: string }>().accessToken;
}

afterEach(async () => {
  await harness.close();
});

describe('정책 위반 차단 (Requirement 16.2)', () => {
  let moderation: ModerationHarness;

  beforeEach(async () => {
    // The real Moderation_Service over the real rule-based classifier, composed with the
    // song gateway the way a deployment composes it. Nothing about the verdict is canned:
    // the description below is what `POLICY_TERM_RULES` blocks.
    moderation = createModerationHarness();
    harness = createGatewayHarness({
      generation: { withSongGateway: true, moderation: moderation.moderation },
    });
    await signIn();
  });

  it('refuses the request, charges nothing and starts no job', async () => {
    const generation = requireGeneration(harness);

    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/songs/simple',
      headers: { authorization: `Bearer ${token}` },
      payload: { description: 'a spoken intro where I pretend to be the president' },
    });

    expect(response.statusCode, response.body).toBe(403);
    expect(response.json<{ error: { code: string; violationClasses: string[] } }>().error)
      .toMatchObject({
        code: 'blocked_by_moderation',
        violationClasses: ['impersonation'],
      });

    // Requirement 16.2 says 크레딧을 차감하지 않는다, and it is the part a status code cannot
    // show. Nothing was charged and nothing was queued.
    expect(generation.charges.requests).toEqual([]);
    expect(generation.adapter.submitCount).toBe(0);

    // Requirement 16.7 — and the block is on the record, once.
    expect(moderation.policyBlocks()).toHaveLength(1);
  });

  it('lets an ordinary request through the same gate', async () => {
    // Without this the test above would pass against a gate that blocked everything, which
    // is the failure mode a refusal test cannot see on its own.
    const generation = requireGeneration(harness);

    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/songs/simple',
      headers: { authorization: `Bearer ${token}` },
      payload: { description: 'a warm lo-fi piano beat for studying' },
    });

    expect(response.statusCode, response.body).toBe(202);
    expect(generation.charges.requests).toHaveLength(1);
    expect(moderation.policyBlocks()).toEqual([]);
  });
});

describe('동의 없는 음성 복제 거부 (Requirements 16.12, 26.13)', () => {
  beforeEach(async () => {
    harness = createGatewayHarness({ voiceConsent: true });
    await signIn();
  });

  it('refuses an incomplete consent and stores no record', async () => {
    const voice = requireVoiceConsent(harness);

    const response = await harness.app.inject({
      method: 'POST',
      url: `/v1/voice-profiles/${PROFILE}/consent`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        isSpeaker: true,
        hasExplicitPermission: false,
        // The item that is missing. Requirement 26.13 names it back.
        prohibitedUseConfirmation: false,
        speakerRelationship: '본인',
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json<{ error: { code: string; unmetItems: string[] } }>().error).toMatchObject({
      code: 'voice_consent_incomplete',
      unmetItems: ['prohibited_use_confirmation'],
      creditsCharged: 0,
    });

    // Requirement 16.12's precondition: there is no Voice_Consent_Record, so nothing downstream
    // can find one to proceed on.
    expect(voice.records.all).toEqual([]);
  });

  it('accepts a complete one, so the refusal is about the consent and not the route', async () => {
    // Without this the test above would pass against a route that refused everything.
    const voice = requireVoiceConsent(harness);

    const response = await harness.app.inject({
      method: 'POST',
      url: `/v1/voice-profiles/${PROFILE}/consent`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        isSpeaker: true,
        hasExplicitPermission: false,
        prohibitedUseConfirmation: true,
        speakerRelationship: '본인',
      },
    });

    expect(response.statusCode).toBe(201);
    expect(voice.records.all).toHaveLength(1);
  });

  it('requires a session before it considers the consent at all', async () => {
    const voice = requireVoiceConsent(harness);

    // A body the schema accepts, so what refuses it is the missing session and not the
    // payload — an assertion against a malformed body would pass on a route with no
    // authentication at all.
    const response = await harness.app.inject({
      method: 'POST',
      url: `/v1/voice-profiles/${PROFILE}/consent`,
      payload: {
        isSpeaker: true,
        hasExplicitPermission: false,
        prohibitedUseConfirmation: true,
        speakerRelationship: '본인',
      },
    });

    expect(response.statusCode, response.body).toBe(401);
    expect(voice.records.all).toEqual([]);
  });
});
