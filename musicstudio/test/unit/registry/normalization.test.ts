import { describe, expect, it } from 'vitest';

import { ENGINE_JOB_STATE, isTerminalJobState } from '../../../adapters/engine-job';
import {
  SEED_UNSPECIFIED,
  isFullyNormalized,
  normalizeEngineResult,
} from '../../../adapters/normalized-generation';
import type { NormalizedGenerationRequest } from '../../../adapters/normalized-generation';
import { CANONICAL_SAMPLE_RATE } from '../../../domain/provenance';
import { createFakeEngineAdapter } from '../../support/fake-engine-adapter';

function sfxRequest(requestId: string): NormalizedGenerationRequest {
  return {
    requestId,
    accountId: 'account-1',
    assetKind: 'sfx',
    inputModality: 'text',
    durationMs: 3_000,
    prompt: 'door slam',
  };
}

/** Requirement 20.18 and design §3.5. */
describe('engine response normalisation (Req 20.18)', () => {
  const raw = {
    audioBuffer: Buffer.from('audio'),
    sampleRate: 44_100,
    durationMs: 30_000,
    seed: 4_242,
  };

  it('populates all six normalised fields', () => {
    const result = normalizeEngineResult({
      assetKind: 'sfx',
      engineId: 'woosh-flow',
      jobState: ENGINE_JOB_STATE.succeeded,
      raw,
    });

    expect(result).toMatchObject({
      assetKind: 'sfx',
      durationMs: 30_000,
      sampleRate: CANONICAL_SAMPLE_RATE,
      seed: 4_242,
      engineId: 'woosh-flow',
      status: 'success',
    });
    expect(isFullyNormalized(result)).toBe(true);
  });

  it('substitutes the fixed sentinel when the engine reports no seed (§3.5)', () => {
    const result = normalizeEngineResult({
      assetKind: 'bgm',
      engineId: 'ace-step-1.5',
      jobState: ENGINE_JOB_STATE.succeeded,
      raw: { ...raw, seed: null },
    });

    expect(result.seed).toBe(SEED_UNSPECIFIED);
    expect(isFullyNormalized(result)).toBe(true);
  });

  it('reports the canonical sample rate while keeping the engine-native one', () => {
    const result = normalizeEngineResult({
      assetKind: 'song',
      engineId: 'ace-step-1.5',
      jobState: ENGINE_JOB_STATE.succeeded,
      raw: { ...raw, sampleRate: 16_000 },
    });

    expect(result.sampleRate).toBe(CANONICAL_SAMPLE_RATE);
    expect(result.originalSampleRate).toBe(16_000);
  });

  it('maps a failed engine job to status "failed"', () => {
    const result = normalizeEngineResult({
      assetKind: 'song',
      engineId: 'ace-step-1.5',
      jobState: ENGINE_JOB_STATE.failed,
      raw,
    });

    expect(result.status).toBe('failed');
    expect(isFullyNormalized(result)).toBe(true);
  });

  it('normalises the answer of two different engines into the same shape', async () => {
    const woosh = createFakeEngineAdapter({ engineId: 'woosh-flow', sampleRate: 32_000, seed: 7 });
    const ace = createFakeEngineAdapter({ engineId: 'ace-step-1.5', sampleRate: 48_000, seed: null });

    // `fetchResult` takes the handle `submit` returned, so the round trip goes
    // through the same two calls a real caller makes.
    const [wooshRaw] = await woosh.fetchResult(await woosh.submit(sfxRequest('req-1')));
    const [aceRaw] = await ace.fetchResult(await ace.submit(sfxRequest('req-2')));
    if (wooshRaw === undefined || aceRaw === undefined) throw new Error('no result');

    const normalised = [
      normalizeEngineResult({
        assetKind: 'sfx',
        engineId: woosh.engineId,
        jobState: ENGINE_JOB_STATE.succeeded,
        raw: wooshRaw,
      }),
      normalizeEngineResult({
        assetKind: 'sfx',
        engineId: ace.engineId,
        jobState: ENGINE_JOB_STATE.succeeded,
        raw: aceRaw,
      }),
    ];

    expect(normalised.every(isFullyNormalized)).toBe(true);
    expect(new Set(normalised.map((entry) => entry.sampleRate))).toEqual(
      new Set([CANONICAL_SAMPLE_RATE]),
    );
    expect(normalised.map((entry) => entry.engineId)).toEqual(['woosh-flow', 'ace-step-1.5']);
    expect(normalised[1]?.seed).toBe(SEED_UNSPECIFIED);
  });

  it('treats only success and failure as terminal engine job states (§3.1)', () => {
    expect(isTerminalJobState(ENGINE_JOB_STATE.running)).toBe(false);
    expect(isTerminalJobState(ENGINE_JOB_STATE.succeeded)).toBe(true);
    expect(isTerminalJobState(ENGINE_JOB_STATE.failed)).toBe(true);
  });
});
