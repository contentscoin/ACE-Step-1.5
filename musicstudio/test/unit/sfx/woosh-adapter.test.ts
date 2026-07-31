import { describe, expect, it } from 'vitest';

import { ENGINE_JOB_STATE } from '../../../adapters/engine-job';
import { validateEngineDescriptor } from '../../../adapters/registry/descriptor-validation';
import { createNonCommercialLicenseList, ruleCommercialUse } from '../../../adapters/registry/non-commercial-licenses';
import { WOOSH_DFLOW_ENGINE_ID, WOOSH_FLOW_ENGINE_ID } from '../../../adapters/registry/default-engines';
import { isWooshEngineError } from '../../../adapters/woosh/errors';
import { WOOSH_LICENSE, wooshEngineDescriptor } from '../../../adapters/woosh/license';
import { tierOfWooshEngine, wooshEngineIdFor } from '../../../adapters/woosh/model-tier';
import { buildWooshSubmitPayload } from '../../../adapters/woosh/submit-payload';
import {
  WOOSH_ENGINE_SAMPLE_RATE,
  WOOSH_PATHS,
  WooshEngineAdapter,
} from '../../../adapters/woosh/woosh-engine-adapter';
import type { WooshJsonResponse, WooshTransport } from '../../../adapters/woosh/transport';
import { validateSfxRequest } from '../../../domain/sfx/validation';
import { createMutableClock } from '../../support/mutable-clock';

/**
 * Woosh_Adapter — the engine seam for `sfx`.
 *
 * **Validates: Requirements 20.1, 20.7, 20.18, 22.1, 22.8, 22.10, 22.11, 22.12, 22.13, 33.1, 33.2**
 *
 * Every assertion is against a scripted transport, because **no Woosh service is reachable from
 * this environment**. What that verifies is the translation and the decoding — which is what the
 * adapter is — and what it leaves unverified is the envelope shape itself, recorded as a risk in
 * `adapters/woosh/transport.ts`.
 */

const clock = () => createMutableClock(new Date('2025-06-01T00:00:00.000Z'));

function parametersFor(overrides: Record<string, unknown> = {}) {
  const validation = validateSfxRequest({ prompt: 'a glass shatters', ...overrides });
  if (validation.kind !== 'valid') throw new Error('fixture request must be valid');
  return validation.parameters;
}

/** A transport answering from a fixed script, recording what it was asked. */
function scriptedTransport(responses: Partial<Record<string, WooshJsonResponse>>): WooshTransport & {
  readonly posts: { path: string; body: Readonly<Record<string, unknown>> }[];
  readonly gets: { path: string; query: Readonly<Record<string, string>> }[];
} {
  const posts: { path: string; body: Readonly<Record<string, unknown>> }[] = [];
  const gets: { path: string; query: Readonly<Record<string, string>> }[] = [];

  return {
    posts,
    gets,
    async postJson(request) {
      posts.push({ path: request.path, body: request.body });
      const response = responses[request.path];
      if (response === undefined) throw new Error(`no scripted response for ${request.path}`);
      return response;
    },
    async getBinary(request) {
      gets.push({ path: request.path, query: request.query });
      return { httpStatus: 200, body: Buffer.from('audio-bytes') };
    },
  };
}

function statusResponse(taskId: string, overrides: Record<string, unknown> = {}): WooshJsonResponse {
  return {
    httpStatus: 200,
    envelope: {
      code: 200,
      data: {
        tasks: [
          {
            task_id: taskId,
            status: 1,
            progress: 100,
            samples: [
              { path: `/out/${taskId}.wav`, seed: 42, duration_ms: 2_000, alignment_score: 0.75 },
            ],
            ...overrides,
          },
        ],
      },
    },
  };
}

describe('the wire payload (Requirements 22.1, 22.10–22.13)', () => {
  it('carries every field of Requirement 22.8s reproducibility key', () => {
    const payload = buildWooshSubmitPayload({
      parameters: parametersFor({ modelTier: 'high_quality', samplingSteps: 45, guidanceScale: 9 }),
      seed: 777,
    });

    // 22.8 lists prompt, engine, seed, length, variant count, steps and guidance. The engine is
    // the adapter's identity and the variant count is the number of submissions; the rest must be
    // on the wire, or the promise would rest on an engine default.
    expect(payload).toEqual({
      prompt: 'a glass shatters',
      model: 'woosh-flow',
      duration_seconds: 2.0,
      num_inference_steps: 45,
      guidance_scale: 9,
      seed: 777,
      num_samples: 1,
    });
  });

  it('names the distilled checkpoint for the fast tier', () => {
    const payload = buildWooshSubmitPayload({
      parameters: parametersFor({ modelTier: 'fast' }),
      seed: 1,
    });

    expect(payload.model).toBe('woosh-dflow');
    expect(payload.num_inference_steps).toBe(8);
  });

  it('sends a fractional target length without rounding it', () => {
    // Requirement 22.4 permits 0.1 s, so rounding to milliseconds and back would be a lossy detour.
    const payload = buildWooshSubmitPayload({
      parameters: parametersFor({ targetLengthSeconds: 0.1 }),
      seed: 1,
    });

    expect(payload.duration_seconds).toBe(0.1);
  });
});

describe('tier to engine mapping (design §3.6)', () => {
  it('maps the two tiers to the two engines, and back', () => {
    expect(wooshEngineIdFor('fast')).toBe(WOOSH_DFLOW_ENGINE_ID);
    expect(wooshEngineIdFor('high_quality')).toBe(WOOSH_FLOW_ENGINE_ID);
    expect(tierOfWooshEngine(WOOSH_DFLOW_ENGINE_ID)).toBe('fast');
    expect(tierOfWooshEngine(WOOSH_FLOW_ENGINE_ID)).toBe('high_quality');
    expect(tierOfWooshEngine('ace-step-1.5')).toBeNull();
  });
});

describe('the Engine_Descriptor and licence (Requirements 20.1, 33.1, 33.2)', () => {
  it.each(['fast', 'high_quality'] as const)('is a valid descriptor for the %s tier', (tier) => {
    expect(validateEngineDescriptor(wooshEngineDescriptor(tier))).toEqual([]);
  });

  it('declares sfx only, text input only, and a 10 s ceiling', () => {
    const descriptor = wooshEngineDescriptor('fast');

    expect(descriptor.supportedAssetKinds).toEqual(['sfx']);
    expect(descriptor.supportedInputModalities).toEqual(['text']);
    // Requirement 22.4's ceiling; routing rejects anything longer, which nothing valid is.
    expect(descriptor.maxOutputDurationMs).toBe(10_000);
    expect(descriptor.sampleRate).toBe(WOOSH_ENGINE_SAMPLE_RATE);
  });

  it('carries all five License_Descriptor items (Requirement 33.1)', () => {
    expect(WOOSH_LICENSE.codeLicenseId.length).toBeGreaterThan(0);
    expect(WOOSH_LICENSE.weightLicenseId).toBe('CC-BY-NC-4.0');
    expect(WOOSH_LICENSE.commercialUseAllowed).toBe(false);
    expect(WOOSH_LICENSE.attributionText.length).toBeGreaterThan(0);
    expect(WOOSH_LICENSE.licenseUrls).toHaveLength(1);
  });

  it('is ruled non-commercial even if a descriptor claimed otherwise (Requirement 33.2)', () => {
    // The property that matters: the claim is overridden, not trusted. A future editor who sets
    // `commercialUseAllowed: true` finds the list ruling against them and saying why.
    const ruling = ruleCommercialUse(
      { ...WOOSH_LICENSE, commercialUseAllowed: true },
      createNonCommercialLicenseList(),
    );

    expect(ruling.commercialUseAllowed).toBe(false);
    expect(ruling.overridden).toBe(true);
    expect(ruling.groundingLicenseIds).toContain('CC-BY-NC-4.0');
  });
});

describe('submit, poll and fetch (Requirements 5.3, 20.18)', () => {
  it('posts the payload and returns the engine task identifier', async () => {
    const transport = scriptedTransport({
      [WOOSH_PATHS.submit]: {
        httpStatus: 200,
        envelope: { code: 200, data: { task_id: 'woosh-1' } },
      },
    });
    const adapter = new WooshEngineAdapter({
      engineId: WOOSH_DFLOW_ENGINE_ID,
      tier: 'fast',
      transport,
      clock: clock(),
    });

    const handle = await adapter.submit({
      requestId: 'req-1',
      accountId: 'user-1',
      assetKind: 'sfx',
      inputModality: 'text',
      durationMs: 2_000,
      seed: 5,
      sfx: parametersFor(),
    });

    expect(handle).toMatchObject({ engineId: WOOSH_DFLOW_ENGINE_ID, engineJobId: 'woosh-1' });
    expect(transport.posts[0]?.path).toBe(WOOSH_PATHS.submit);
    expect(transport.posts[0]?.body.seed).toBe(5);
  });

  it('refuses to submit a request carrying no sfx parameters', async () => {
    const transport = scriptedTransport({});
    const adapter = new WooshEngineAdapter({
      engineId: WOOSH_DFLOW_ENGINE_ID,
      tier: 'fast',
      transport,
      clock: clock(),
    });

    await expect(
      adapter.submit({
        requestId: 'req-1',
        accountId: 'user-1',
        assetKind: 'sfx',
        inputModality: 'text',
        durationMs: 2_000,
        seed: 5,
      }),
    ).rejects.toSatisfy(isWooshEngineError);
  });

  it('refuses to submit without an integer seed', async () => {
    const transport = scriptedTransport({});
    const adapter = new WooshEngineAdapter({
      engineId: WOOSH_DFLOW_ENGINE_ID,
      tier: 'fast',
      transport,
      clock: clock(),
    });

    await expect(
      adapter.submit({
        requestId: 'req-1',
        accountId: 'user-1',
        assetKind: 'sfx',
        inputModality: 'text',
        durationMs: 2_000,
        sfx: parametersFor(),
      }),
    ).rejects.toSatisfy(isWooshEngineError);
  });

  it.each([
    [0, ENGINE_JOB_STATE.running],
    [1, ENGINE_JOB_STATE.succeeded],
    [2, ENGINE_JOB_STATE.failed],
    [7, ENGINE_JOB_STATE.failed],
  ])('maps engine status %i to state %i', async (status, expected) => {
    const transport = scriptedTransport({
      [WOOSH_PATHS.status]: statusResponse('woosh-1', { status }),
    });
    const adapter = new WooshEngineAdapter({
      engineId: WOOSH_FLOW_ENGINE_ID,
      tier: 'high_quality',
      transport,
      clock: clock(),
    });

    const polled = await adapter.poll({
      engineId: WOOSH_FLOW_ENGINE_ID,
      engineJobId: 'woosh-1',
      submittedAtMs: 0,
    });

    expect(polled.state).toBe(expected);
  });

  it('reports the failure reason only on the failed state', async () => {
    const transport = scriptedTransport({
      [WOOSH_PATHS.status]: statusResponse('woosh-1', { status: 2, error: 'out of memory' }),
    });
    const adapter = new WooshEngineAdapter({
      engineId: WOOSH_FLOW_ENGINE_ID,
      tier: 'high_quality',
      transport,
      clock: clock(),
    });

    const polled = await adapter.poll({
      engineId: WOOSH_FLOW_ENGINE_ID,
      engineJobId: 'woosh-1',
      submittedAtMs: 0,
    });

    expect(polled.failureReason).toBe('out of memory');
  });

  it('downloads each sample with its seed and alignment score', async () => {
    const transport = scriptedTransport({
      [WOOSH_PATHS.status]: statusResponse('woosh-1'),
    });
    const adapter = new WooshEngineAdapter({
      engineId: WOOSH_DFLOW_ENGINE_ID,
      tier: 'fast',
      transport,
      clock: clock(),
    });

    const results = await adapter.fetchResult({
      engineId: WOOSH_DFLOW_ENGINE_ID,
      engineJobId: 'woosh-1',
      submittedAtMs: 0,
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      sampleRate: WOOSH_ENGINE_SAMPLE_RATE,
      durationMs: 2_000,
      seed: 42,
      alignmentScore: 0.75,
    });
    expect(transport.gets[0]?.query.path).toBe('/out/woosh-1.wav');
  });

  it('rejects a task the engine does not know', async () => {
    const transport = scriptedTransport({
      [WOOSH_PATHS.status]: { httpStatus: 200, envelope: { code: 200, data: { tasks: [] } } },
    });
    const adapter = new WooshEngineAdapter({
      engineId: WOOSH_DFLOW_ENGINE_ID,
      tier: 'fast',
      transport,
      clock: clock(),
    });

    await expect(
      adapter.poll({ engineId: WOOSH_DFLOW_ENGINE_ID, engineJobId: 'ghost', submittedAtMs: 0 }),
    ).rejects.toSatisfy(
      (error: unknown) => isWooshEngineError(error) && error.code === 'woosh_engine_task_unknown',
    );
  });

  it('preserves a 429 status, which Requirement 6.2 keys its backoff on', async () => {
    const transport = scriptedTransport({
      [WOOSH_PATHS.submit]: { httpStatus: 429, envelope: { code: 429 } },
    });
    const adapter = new WooshEngineAdapter({
      engineId: WOOSH_DFLOW_ENGINE_ID,
      tier: 'fast',
      transport,
      clock: clock(),
    });

    await expect(
      adapter.submit({
        requestId: 'req-1',
        accountId: 'user-1',
        assetKind: 'sfx',
        inputModality: 'text',
        durationMs: 2_000,
        seed: 1,
        sfx: parametersFor(),
      }),
    ).rejects.toSatisfy((error: unknown) => isWooshEngineError(error) && error.statusCode === 429);
  });

  it('treats HTTP 200 carrying an application error as a failure', async () => {
    const transport = scriptedTransport({
      [WOOSH_PATHS.submit]: { httpStatus: 200, envelope: { code: 500, error: 'model not loaded' } },
    });
    const adapter = new WooshEngineAdapter({
      engineId: WOOSH_DFLOW_ENGINE_ID,
      tier: 'fast',
      transport,
      clock: clock(),
    });

    await expect(
      adapter.submit({
        requestId: 'req-1',
        accountId: 'user-1',
        assetKind: 'sfx',
        inputModality: 'text',
        durationMs: 2_000,
        seed: 1,
        sfx: parametersFor(),
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        isWooshEngineError(error) && error.code === 'woosh_engine_application_error',
    );
  });
});

describe('the health probe (Requirement 20.7)', () => {
  it('is healthy when the engine says ok', async () => {
    const transport = scriptedTransport({
      [WOOSH_PATHS.health]: { httpStatus: 200, envelope: { code: 200, data: { status: 'ok' } } },
    });
    const adapter = new WooshEngineAdapter({
      engineId: WOOSH_DFLOW_ENGINE_ID,
      tier: 'fast',
      transport,
      clock: clock(),
    });

    await expect(adapter.healthCheck()).resolves.toMatchObject({ healthy: true });
  });

  it('reports an unreachable engine as unhealthy rather than throwing', async () => {
    // The monitor's job is to record an outcome for every probe, so a thrown error would leave a
    // scheduled check with no result.
    const adapter = new WooshEngineAdapter({
      engineId: WOOSH_DFLOW_ENGINE_ID,
      tier: 'fast',
      transport: {
        postJson: async () => {
          throw new Error('connection refused');
        },
        getBinary: async () => ({ httpStatus: 500, body: Buffer.alloc(0) }),
      },
      clock: clock(),
    });

    await expect(adapter.healthCheck()).resolves.toMatchObject({
      healthy: false,
      detail: 'connection refused',
    });
  });

  it('resolves cancel, because no cancellation route exists', async () => {
    const adapter = new WooshEngineAdapter({
      engineId: WOOSH_DFLOW_ENGINE_ID,
      tier: 'fast',
      transport: scriptedTransport({}),
      clock: clock(),
    });

    await expect(adapter.cancel()).resolves.toBeUndefined();
  });
});
