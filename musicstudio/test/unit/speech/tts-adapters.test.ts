import { describe, expect, it } from 'vitest';

import { ENGINE_JOB_STATE } from '../../../adapters/engine-job';
import type { NormalizedGenerationRequest } from '../../../adapters/normalized-generation';
import {
  TTS_ENGINE_A_CAPABILITIES,
  TTS_ENGINE_B_CAPABILITIES,
  TTS_ENGINE_CAPABILITIES,
  ttsCapabilitiesOf,
  ttsLanguageCatalogue,
} from '../../../adapters/tts/capabilities';
import { ttsEngineDescriptor, ttsEngineDescriptors } from '../../../adapters/tts/license';
import { TtsEngineAAdapter } from '../../../adapters/tts/tts-engine-a-adapter';
import {
  CENTS_PER_SEMITONE,
  TtsEngineBAdapter,
} from '../../../adapters/tts/tts-engine-b-adapter';
import { validateEngineDescriptor } from '../../../adapters/registry/descriptor-validation';
import {
  createNonCommercialLicenseList,
  ruleCommercialUse,
} from '../../../adapters/registry/non-commercial-licenses';
import type { SpeechParameters } from '../../../domain/speech/request';
import {
  createDeterministicTtsATransport,
  createDeterministicTtsBTransport,
} from '../../support/deterministic-tts-transport';
import { createMutableClock } from '../../support/mutable-clock';

/**
 * The two TTS_Adapters (Requirement 25.2; design §3.1, §3.6).
 *
 * **Validates: Requirements 20.1, 20.7, 25.2, 25.5, 25.6, 25.7, 25.18, 33.1, 33.2**
 *
 * The point of this suite is that the two adapters are **genuinely different implementations of
 * one interface**, not one implementation twice. Each block asserts the same product concept
 * arriving as a different wire field, which is the only evidence that the abstraction of design
 * §3.1 is doing work.
 *
 * **No TTS service is reachable from this environment**, so both are exercised against the
 * deterministic simulators; see `adapters/tts/transport.ts` for what that leaves unverified.
 */

const CLOCK_START = new Date('2025-06-01T00:00:00.000Z');

function speechParameters(overrides: Partial<SpeechParameters> = {}): SpeechParameters {
  return {
    script: 'A line.',
    originalScript: 'A line.',
    voiceProfileId: 'vp-1',
    languageCode: 'ko',
    speakingRate: 1.0,
    pitchSemitones: 0,
    actingInstruction: null,
    splitThresholdChars: 800,
    removedTags: [],
    appliedDefaults: [],
    ...overrides,
  };
}

function request(overrides: Partial<NormalizedGenerationRequest> = {}): NormalizedGenerationRequest {
  return {
    requestId: 'req-1',
    accountId: 'user-1',
    assetKind: 'dialogue',
    inputModality: 'text',
    durationMs: 2_000,
    prompt: 'A line.',
    seed: 4_242,
    speech: speechParameters(),
    ...overrides,
  };
}

describe('the capability table (Requirements 25.2, 25.3, 25.7, 25.8)', () => {
  it('declares two engines, which is what 25.2 asks for', () => {
    expect(TTS_ENGINE_CAPABILITIES.length).toBeGreaterThanOrEqual(2);
    expect(ttsCapabilitiesOf('tts-engine-a')).toBe(TTS_ENGINE_A_CAPABILITIES);
    expect(ttsCapabilitiesOf('tts-engine-b')).toBe(TTS_ENGINE_B_CAPABILITIES);
    expect(ttsCapabilitiesOf('nope')).toBeUndefined();
  });

  it('makes the two differ, so 25.3, 25.7 and 25.9 are all reachable', () => {
    // A language only A has, and one only B has: 25.3's refusal needs both directions.
    expect(TTS_ENGINE_A_CAPABILITIES.languageCodes).toContain('ja');
    expect(TTS_ENGINE_B_CAPABILITIES.languageCodes).not.toContain('ja');
    expect(TTS_ENGINE_B_CAPABILITIES.languageCodes).toContain('es');
    expect(TTS_ENGINE_A_CAPABILITIES.languageCodes).not.toContain('es');

    // 25.7's `WHERE` and 25.9's removal both need an engine that cannot.
    expect(TTS_ENGINE_A_CAPABILITIES.supportsActingInstruction).toBe(true);
    expect(TTS_ENGINE_B_CAPABILITIES.supportsActingInstruction).toBe(false);
    expect(TTS_ENGINE_A_CAPABILITIES.supportsParalinguisticTags).toBe(true);
    expect(TTS_ENGINE_B_CAPABILITIES.supportsParalinguisticTags).toBe(false);
  });

  it('projects the language catalogue without inventing languages', () => {
    expect(ttsLanguageCatalogue()).toEqual([
      { engineId: 'tts-engine-a', languageCodes: TTS_ENGINE_A_CAPABILITIES.languageCodes },
      { engineId: 'tts-engine-b', languageCodes: TTS_ENGINE_B_CAPABILITIES.languageCodes },
    ]);
  });
});

describe('the Engine_Descriptors (Requirements 20.1, 33.1, 33.2)', () => {
  it('validate against the registry schema', () => {
    for (const descriptor of ttsEngineDescriptors()) {
      expect(validateEngineDescriptor(descriptor)).toEqual([]);
    }
  });

  it('support only the dialogue Asset_Kind, so routing cannot send them other work', () => {
    for (const descriptor of ttsEngineDescriptors()) {
      expect(descriptor.supportedAssetKinds).toEqual(['dialogue']);
    }
  });

  it('accept audio as well as text, which Requirement 26.24 needs', () => {
    for (const descriptor of ttsEngineDescriptors()) {
      expect(descriptor.supportedInputModalities).toContain('text');
      expect(descriptor.supportedInputModalities).toContain('audio');
    }
  });

  it('are ruled non-commercial until a deployment states otherwise (33.2)', () => {
    const ruling = ruleCommercialUse(
      ttsEngineDescriptor(TTS_ENGINE_A_CAPABILITIES).license,
      createNonCommercialLicenseList(),
    );

    expect(ruling.commercialUseAllowed).toBe(false);
    // Not an override: the descriptor states `false` honestly, so nothing had to be corrected.
    expect(ruling.overridden).toBe(false);
  });

  it('declare each engine\u2019s own native sample rate', () => {
    expect(ttsEngineDescriptor(TTS_ENGINE_A_CAPABILITIES).sampleRate).toBe(48_000);
    expect(ttsEngineDescriptor(TTS_ENGINE_B_CAPABILITIES).sampleRate).toBe(24_000);
  });
});

describe('engine A: wrapped envelope, numeric states (Requirements 25.5, 25.6, 25.7, 25.18)', () => {
  const build = () => {
    const transport = createDeterministicTtsATransport();
    const clock = createMutableClock(CLOCK_START);
    return { transport, adapter: new TtsEngineAAdapter({ transport, clock }) };
  };

  it('translates the product parameters into engine A\u2019s field names', async () => {
    const { transport, adapter } = build();
    await adapter.submit(
      request({
        speech: speechParameters({
          speakingRate: 1.5,
          pitchSemitones: -3,
          actingInstruction: 'warmly',
        }),
      }),
    );

    expect(transport.submissions[0]?.payload).toMatchObject({
      text: 'A line.',
      voice_ref: 'vp-1',
      language: 'ko',
      speed: 1.5,
      pitch_semitones: -3,
      style_prompt: 'warmly',
      seed: 4_242,
    });
  });

  it('omits the acting instruction when there is none (25.7)', async () => {
    const { transport, adapter } = build();
    await adapter.submit(request());

    expect(transport.submissions[0]?.payload).not.toHaveProperty('style_prompt');
  });

  it('sends the line rather than the whole script', async () => {
    const { transport, adapter } = build();
    await adapter.submit(
      request({
        prompt: 'Just this line.',
        speech: speechParameters({ script: 'Line one.\nJust this line.' }),
      }),
    );

    expect(transport.submissions[0]?.payload.text).toBe('Just this line.');
  });

  it('reports 0/1/2 and downloads the produced utterance', async () => {
    const { adapter } = build();
    const handle = await adapter.submit(request());

    expect(await adapter.poll(handle)).toMatchObject({
      state: ENGINE_JOB_STATE.succeeded,
      progressPercent: 100,
    });
    const results = await adapter.fetchResult(handle);
    expect(results).toHaveLength(1);
    expect(results[0]?.seed).toBe(4_242);
    expect(results[0]?.durationMs).toBeGreaterThan(0);
  });

  it('reports a failure with its reason', async () => {
    const { transport, adapter } = build();
    const handle = await adapter.submit(request());
    transport.failTask();

    expect(await adapter.poll(handle)).toMatchObject({
      state: ENGINE_JOB_STATE.failed,
      failureReason: 'simulated failure',
    });
  });

  it('refuses a submission with no validated parameters', async () => {
    const { adapter } = build();
    const bare = { ...request() } as Record<string, unknown>;
    delete bare.speech;

    await expect(adapter.submit(bare as unknown as NormalizedGenerationRequest)).rejects.toMatchObject({
      code: 'tts_malformed_response',
    });
  });

  it('refuses a submission with no integer seed (25.18)', async () => {
    const { adapter } = build();

    await expect(adapter.submit(request({ seed: null }))).rejects.toMatchObject({
      code: 'tts_malformed_response',
    });
  });

  it('reports health, and reports an unreachable engine as unhealthy rather than throwing', async () => {
    const { adapter } = build();

    expect(await adapter.healthCheck()).toMatchObject({ healthy: true });

    const broken = new TtsEngineAAdapter({
      transport: {
        requestJson: async () => {
          throw new Error('unreachable');
        },
        requestBinary: async () => {
          throw new Error('unreachable');
        },
      },
      clock: createMutableClock(CLOCK_START),
    });
    expect(await broken.healthCheck()).toMatchObject({ healthy: false, detail: 'unreachable' });
  });

  it('surfaces an application-level error code as a malformed response', async () => {
    const { transport, adapter } = build();
    transport.failSubmit(200);
    // The simulator answers with `{ code: 200 }` and no data on a scripted failure, which is a
    // body engine A's own envelope rule cannot read.
    await expect(adapter.submit(request())).rejects.toMatchObject({
      code: 'tts_malformed_response',
    });
  });
});

describe('engine B: flat body, string states (Requirements 25.5, 25.6, 25.18)', () => {
  const build = () => {
    const transport = createDeterministicTtsBTransport();
    const clock = createMutableClock(CLOCK_START);
    return { transport, adapter: new TtsEngineBAdapter({ transport, clock }) };
  };

  it('translates the same parameters into engine B\u2019s different units', async () => {
    const { transport, adapter } = build();
    await adapter.submit(
      request({
        speech: speechParameters({ speakingRate: 1.5, pitchSemitones: -3 }),
      }),
    );

    expect(transport.submissions[0]?.payload).toMatchObject({
      utterance: 'A line.',
      speaker: 'vp-1',
      lang: 'ko',
      // A percentage where engine A takes a multiplier.
      rate_percent: 150,
      // Cents where engine A takes semitones.
      pitch_cents: -3 * CENTS_PER_SEMITONE,
      random_seed: 4_242,
    });
  });

  it('never sends an acting instruction, because it has no field for one (25.7)', async () => {
    const { transport, adapter } = build();
    await adapter.submit(
      request({ speech: speechParameters({ actingInstruction: 'warmly' }) }),
    );

    const payload = transport.submissions[0]?.payload ?? {};
    expect(Object.keys(payload)).not.toContain('style_prompt');
    expect(JSON.stringify(payload)).not.toContain('warmly');
  });

  it('translates its string status vocabulary into 0/1/2', async () => {
    const { transport, adapter } = build();
    const handle = await adapter.submit(request());

    expect(await adapter.poll(handle)).toMatchObject({ state: ENGINE_JOB_STATE.succeeded });
    transport.failTask();
    expect(await adapter.poll(handle)).toMatchObject({
      state: ENGINE_JOB_STATE.failed,
      failureReason: 'simulated failure',
    });
  });

  it('downloads from the per-utterance list, converting seconds to milliseconds', async () => {
    const { adapter } = build();
    const handle = await adapter.submit(request());
    const results = await adapter.fetchResult(handle);

    expect(results).toHaveLength(1);
    expect(results[0]?.durationMs).toBeGreaterThan(0);
    expect(Number.isInteger(results[0]?.durationMs)).toBe(true);
    expect(results[0]?.sampleRate).toBe(48_000);
  });

  it('raises a task-unknown error for a job the engine does not have', async () => {
    const { adapter } = build();

    await expect(
      adapter.poll({ engineId: 'tts-engine-b', engineJobId: 'missing', submittedAtMs: 0 }),
    ).rejects.toMatchObject({ code: 'tts_task_unknown' });
  });

  it('reports health from its own flat body', async () => {
    const { adapter } = build();

    expect(await adapter.healthCheck()).toMatchObject({ healthy: true });
  });

  it('resolves cancel as a no-op, since no cancellation route exists', async () => {
    const { adapter } = build();

    await expect(adapter.cancel()).resolves.toBeUndefined();
  });
});

describe('the two engines are interchangeable through the interface', () => {
  it('accept the same normalised request and both produce audio', async () => {
    const aTransport = createDeterministicTtsATransport();
    const bTransport = createDeterministicTtsBTransport();
    const clock = createMutableClock(CLOCK_START);
    const adapters = [
      new TtsEngineAAdapter({ transport: aTransport, clock }),
      new TtsEngineBAdapter({ transport: bTransport, clock }),
    ];

    for (const adapter of adapters) {
      const handle = await adapter.submit(request());
      expect(handle.engineId).toBe(adapter.engineId);
      expect((await adapter.poll(handle)).state).toBe(ENGINE_JOB_STATE.succeeded);
      expect(await adapter.fetchResult(handle)).toHaveLength(1);
    }

    // The same line at the same rate comes out the same length whichever engine spoke it, so a
    // test comparing engines is comparing the adapters rather than the simulators.
    expect(aTransport.pcmFor('tts-a-task-1').channels[0]?.length).toBe(
      bTransport.pcmFor('tts-b-task-1').channels[0]?.length,
    );
  });
});
