/**
 * Test rig for the Speech_Service, the Voice_Profile services and the Transcription_Service
 * (Requirements 25, 26.1–26.11, 26.24–26.26, 27).
 *
 * Built on `createGenerationHarness({ assetKind: 'dialogue' })`, `createVoiceConsentHarness()` and
 * the **real** TTS adapters over the deterministic transports, so what the tests exercise is:
 *
 * - the real Requirement 5 job lifecycle and the real Requirement 6.2 backoff;
 * - the real `ProviderRegistry` with the real TTS Engine_Descriptors, which means the
 *   Requirement 33.2 licence ruling on the declared descriptors actually happens;
 * - the real routing of Requirements 20.3/20.5/20.6 against **two registered engines**, which is
 *   what makes "25.2's 2개+ 엔진" a fact about the registry rather than about two mocks;
 * - the real `CreditRefundPort`, so a Requirement 25.1 or 26.25 refund is counted where every other
 *   refund in the system is counted, through the same `createJobQualityRejection`;
 * - task 6.2's real `ConsentService`, `ProfileAccessService` and withdrawal state machine, so a
 *   `cloned` profile genuinely cannot exist or be used without a valid consent record;
 * - the real TTS wire payloads, recorded and assertable.
 *
 * The genuine fakes are the ports of `services/speech/ports.ts` and
 * `services/voice/profile-ports.ts` — decoded audio, the rendition store, the reference probe, the
 * staging area, the prompt cache and the conversion engine. Every one stands in for something
 * unreachable here, and each default is *derived* from the wire payload or from the source audio,
 * so Requirement 25.18's reproducibility and Requirement 26.25's length invariant are properties of
 * the whole chain rather than assumptions.
 *
 * Nothing here sleeps. The clock moves only when a test moves it.
 */

import {
  TTS_ENGINE_A_CAPABILITIES,
  TTS_ENGINE_CAPABILITIES,
  ttsLanguageCatalogue,
  type TtsEngineCapabilities,
} from '../../adapters/tts/capabilities';
import { ttsEngineDescriptor } from '../../adapters/tts/license';
import { TtsEngineAAdapter } from '../../adapters/tts/tts-engine-a-adapter';
import { TtsEngineBAdapter } from '../../adapters/tts/tts-engine-b-adapter';
import type { EngineAdapter } from '../../adapters/engine-adapter';
import type { PcmAudio } from '../../domain/audio/pcm';
import { durationMs as audioDurationMs, frameCount } from '../../domain/audio/pcm';
import { jobFailure } from '../../domain/generation-job/failure';
import type { QualityThresholdSource } from '../../domain/quality/threshold-source';
import { fixedSeedSource, type SeedSource } from '../../domain/sfx/seed';
import type {
  ClonedVoiceProfile,
  PresetVoiceProfile,
  VoiceProfile,
} from '../../domain/voice/profile';
import type { ProbedReferenceSample } from '../../domain/voice/reference-sample';
import { initialWithdrawalContext } from '../../domain/voice/withdrawal-machine';
import { createJobQualityRejection } from '../../services/sound/job-quality-rejection';
import { SpeechService, type SpeechServiceOptions } from '../../services/speech/speech-service';
import type {
  DialogueRendition,
  DialogueRenditionStorePort,
  SpeechSynthesisOutcome,
  SpeechSynthesisPort,
  SpeechSynthesisRequest,
} from '../../services/speech/ports';
import { TranscriptionService } from '../../services/transcription/transcription-service';
import type {
  ProbedTranscriptionAudio,
  TranscriptionAudioProbePort,
  TranscriptionEngineOutcome,
  TranscriptionEnginePort,
  TranscriptionEngineRequest,
  TranscriptionStorePort,
} from '../../services/transcription/ports';
import type { TranscriptionResult } from '../../domain/transcription/result';
import { VoiceConversionService } from '../../services/voice/conversion-service';
import { VoiceProfileService } from '../../services/voice/profile-service';
import type {
  ReferenceProbeOutcome,
  ReferenceSampleProbePort,
  ReferenceSampleStagingPort,
  SourceUtterancePort,
  VoiceConversionOutcome,
  VoiceConversionPort,
  VoiceConversionRequest,
  VoiceProfileRecordStorePort,
  VoicePromptPort,
} from '../../services/voice/profile-ports';

import {
  createDeterministicTtsATransport,
  createDeterministicTtsBTransport,
  type DeterministicTtsTransport,
} from './deterministic-tts-transport';
import { createGenerationHarness, type GenerationHarness } from './generation-harness';
import { monoAudio, TEST_SAMPLE_RATE } from './pcm-synthesis';
import { createVoiceConsentHarness, type VoiceConsentHarness } from './voice-consent-harness';

/** Base seed the harness draws when a request names none, so tests are deterministic. */
export const TEST_DIALOGUE_BASE_SEED = 7_654_321;

export const TEST_OWNER_ID = 'user-1';

/* --------------------------------------------------------------- profile store */

export interface InMemoryVoiceProfileRecordStore extends VoiceProfileRecordStorePort {
  readonly all: readonly VoiceProfile[];
}

export function createInMemoryVoiceProfileRecordStore(): InMemoryVoiceProfileRecordStore {
  const rows = new Map<string, VoiceProfile>();
  return {
    get all() {
      return [...rows.values()];
    },
    save: (profile) => {
      rows.set(profile.voiceProfileId, profile);
    },
    find: (voiceProfileId) => rows.get(voiceProfileId),
    listForOwner: (ownerId) => [...rows.values()].filter((row) => row.ownerId === ownerId),
  };
}

/* ------------------------------------------------------- reference sample probe */

/**
 * Requirements 26.2–26.5 — a probed record, scriptable per upload.
 *
 * A "sample" *is* its probed metadata here, and that is not a shortcut:
 * `domain/voice/reference-sample.ts` is written over such a record precisely so 26.2–26.5 are
 * checkable without a decoder (task 3.1's). The thresholds the service passes in are recorded, so a
 * test can assert that Requirement 30.12's members reached the probe rather than a second copy.
 */
export interface ScriptedReferenceProbe extends ReferenceSampleProbePort {
  setSample(uploadId: string, sample: Partial<ProbedReferenceSample>): void;
  setUnreadable(uploadId: string, detail: string): void;
  readonly requests: readonly {
    readonly uploadId: string;
    readonly speechRmsThresholdDb: number;
    readonly speechMinDurationMs: number;
  }[];
}

export function compliantReferenceSample(
  overrides: Partial<ProbedReferenceSample> = {},
): ProbedReferenceSample {
  return {
    uploadId: 'upload-1',
    format: 'wav',
    durationMs: 30_000,
    sampleRate: 48_000,
    // 80 % speech, comfortably inside 26.5's 60 % floor rather than on it.
    speechDurationMs: 24_000,
    ...overrides,
  };
}

export function createScriptedReferenceProbe(): ScriptedReferenceProbe {
  const samples = new Map<string, ProbedReferenceSample>();
  const unreadable = new Map<string, string>();
  const requests: {
    uploadId: string;
    speechRmsThresholdDb: number;
    speechMinDurationMs: number;
  }[] = [];

  return {
    requests,
    setSample(uploadId, sample) {
      samples.set(uploadId, compliantReferenceSample({ uploadId, ...sample }));
    },
    setUnreadable(uploadId, detail) {
      unreadable.set(uploadId, detail);
    },
    probe: async (request): Promise<ReferenceProbeOutcome> => {
      requests.push({ ...request });
      const detail = unreadable.get(request.uploadId);
      if (detail !== undefined) return { kind: 'unreadable', detail };
      return {
        kind: 'probed',
        sample: samples.get(request.uploadId) ?? compliantReferenceSample({ uploadId: request.uploadId }),
      };
    },
  };
}

/* ----------------------------------------------------------- staging + prompts */

export interface RecordingStaging extends ReferenceSampleStagingPort {
  /** Requirement 26.13: every upload identifier `discard` was called with. */
  readonly discarded: readonly string[];
  /** The uploads that became stored reference samples. */
  readonly promoted: readonly { readonly uploadId: string; readonly voiceProfileId: string }[];
}

export function createRecordingStaging(): RecordingStaging {
  const discarded: string[] = [];
  const promoted: { uploadId: string; voiceProfileId: string }[] = [];
  return {
    discarded,
    promoted,
    promote: async (uploadId, voiceProfileId) => {
      promoted.push({ uploadId, voiceProfileId });
    },
    discard: async (uploadIds) => {
      discarded.push(...uploadIds);
    },
  };
}

export interface RecordingVoicePrompt extends VoicePromptPort {
  readonly calls: readonly { readonly voiceProfileId: string; readonly uploadIds: readonly string[] }[];
}

export function createRecordingVoicePrompt(): RecordingVoicePrompt {
  const calls: { voiceProfileId: string; uploadIds: readonly string[] }[] = [];
  return {
    calls,
    combine: async (request) => {
      calls.push({ voiceProfileId: request.voiceProfileId, uploadIds: [...request.uploadIds] });
      return `prompt-${request.voiceProfileId}-${String(request.uploadIds.length)}`;
    },
  };
}

/* ------------------------------------------------------------------ synthesis */

/** What one scripted line returns instead of the derived default. */
export type ScriptedLine =
  | { readonly kind: 'audio'; readonly audio: PcmAudio }
  /** Requirements 6.1–6.3: the engine answered but produced no audio for this line. */
  | { readonly kind: 'unproduced'; readonly reason?: string };

export interface ScriptedSpeechSynthesis extends SpeechSynthesisPort {
  /** Queue outcomes for successive line calls, in order. */
  script(...lines: readonly ScriptedLine[]): void;
  /** Make the call for this line index return no audio. */
  failLine(lineIndex: number): void;
  readonly requests: readonly SpeechSynthesisRequest[];
}

/**
 * The synthesis port: scripted when a test says so, otherwise driven through the **real** adapter.
 *
 * The default path submits to whichever engine the job was routed to, polls it, fetches the result
 * and reads the decoded PCM off that engine's simulator. So the audio a test sees is a function of
 * the wire payload the real adapter built — which is what makes Requirement 25.18's reproducibility
 * a property of the whole chain rather than of this fake.
 */
export function createScriptedSpeechSynthesis(
  adapters: ReadonlyMap<string, { readonly adapter: EngineAdapter; readonly transport: DeterministicTtsTransport }>,
): ScriptedSpeechSynthesis {
  const queued: ScriptedLine[] = [];
  const failures = new Set<number>();
  const requests: SpeechSynthesisRequest[] = [];

  return {
    requests,
    script(...lines) {
      queued.push(...lines);
    },
    failLine(lineIndex) {
      failures.add(lineIndex);
    },
    synthesiseLine: async (request): Promise<SpeechSynthesisOutcome> => {
      requests.push(request);
      const scripted = queued.shift();

      if (scripted?.kind === 'unproduced' || failures.has(request.lineIndex)) {
        return {
          kind: 'unproduced',
          failure: jobFailure('engine_error', 'engine_reported_failure', 'no audio for line'),
        };
      }
      if (scripted?.kind === 'audio') {
        return {
          kind: 'produced',
          line: { lineIndex: request.lineIndex, audio: scripted.audio, seed: request.seed },
        };
      }

      const entry = adapters.get(request.engineId);
      if (entry === undefined) {
        throw new Error(`no simulated TTS engine registered for ${request.engineId}`);
      }

      // The real adapter, over the real wire form, against the deterministic simulator.
      const handle = await entry.adapter.submit({
        requestId: `${request.jobId}-line-${String(request.lineIndex)}`,
        accountId: request.accountId,
        assetKind: 'dialogue',
        inputModality: 'text',
        durationMs: 1_000,
        prompt: request.text,
        seed: request.seed,
        engineId: request.engineId,
        speech: request.parameters,
      });
      const status = await entry.adapter.poll(handle);
      if (status.state !== 1) {
        return {
          kind: 'unproduced',
          failure: jobFailure(
            'engine_error',
            'engine_reported_failure',
            status.failureReason ?? 'engine did not succeed',
          ),
        };
      }
      // Exercises the download path; the decoded form is the simulator's, because nothing in this
      // repository decodes audio.
      await entry.adapter.fetchResult(handle);

      return {
        kind: 'produced',
        line: {
          lineIndex: request.lineIndex,
          audio: entry.transport.pcmFor(handle.engineJobId),
          seed: request.seed,
        },
      };
    },
  };
}

/* ------------------------------------------------------------------ renditions */

export interface InMemoryRenditionStore extends DialogueRenditionStorePort {
  readonly all: readonly DialogueRendition[];
}

export function createInMemoryRenditionStore(): InMemoryRenditionStore {
  const rows = new Map<string, DialogueRendition>();
  return {
    get all() {
      return [...rows.values()];
    },
    save: async (rendition) => {
      rows.set(rendition.assetId, rendition);
    },
    find: async (assetId) => rows.get(assetId),
  };
}

/* ------------------------------------------------------------------ conversion */

export interface ScriptedVoiceConversion extends VoiceConversionPort {
  /** Make the conversion return audio this many milliseconds from the source's length. */
  setLengthDeltaMs(deltaMs: number): void;
  /** Make the conversion produce nothing. */
  failNext(times?: number): void;
  readonly requests: readonly VoiceConversionRequest[];
}

/**
 * Requirements 26.24, 26.25 — a conversion that is a function of its source.
 *
 * The output is the source's length plus a scripted delta, and its samples are the source's scaled
 * by a seed-derived factor: **a timbre change with the content untouched**, which is the closest a
 * fixture can come to 26.24 without a model. It is also why the length delta is scriptable — that
 * is the one part of the contract the service genuinely verifies, so a test has to be able to break
 * it.
 */
export function createScriptedVoiceConversion(): ScriptedVoiceConversion {
  const requests: VoiceConversionRequest[] = [];
  let deltaMs = 0;
  let failures = 0;

  return {
    requests,
    setLengthDeltaMs(next) {
      deltaMs = next;
    },
    failNext(times = 1) {
      failures = times;
    },
    convert: async (request): Promise<VoiceConversionOutcome> => {
      requests.push(request);
      if (failures > 0) {
        failures -= 1;
        return {
          kind: 'unproduced',
          failure: jobFailure('engine_error', 'engine_reported_failure', 'no conversion'),
        };
      }

      const source = request.sourceAudio;
      const sourceFrames = frameCount(source);
      const deltaFrames = Math.round((deltaMs * source.sampleRate) / 1000);
      const frames = Math.max(1, sourceFrames + deltaFrames);
      // A deterministic per-seed gain: different timbre, same content, same length.
      const gain = 0.5 + ((Math.abs(request.seed) % 100) / 400);

      return {
        kind: 'converted',
        audio: {
          sampleRate: source.sampleRate,
          channels: source.channels.map((channel) => {
            const out = new Float32Array(frames);
            for (let index = 0; index < frames; index += 1) {
              out[index] = (channel[index % Math.max(1, channel.length)] ?? 0) * gain;
            }
            return out;
          }),
        },
      };
    },
  };
}

export interface InMemorySourceUtterances extends SourceUtterancePort {
  set(assetId: string, audio: PcmAudio): void;
}

export function createInMemorySourceUtterances(): InMemorySourceUtterances {
  const rows = new Map<string, PcmAudio>();
  return {
    set(assetId, audio) {
      rows.set(assetId, audio);
    },
    find: async (assetId) => rows.get(assetId),
  };
}

/* --------------------------------------------------------------- transcription */

export interface ScriptedTranscriptionEngine extends TranscriptionEnginePort {
  setOutput(output: {
    readonly lines: readonly { readonly startMs: number; readonly endMs: number; readonly text: string }[];
    readonly languageCode?: string;
    readonly confidence?: number | null;
  }): void;
  failNext(detail?: string, times?: number): void;
  readonly requests: readonly TranscriptionEngineRequest[];
}

export function createScriptedTranscriptionEngine(): ScriptedTranscriptionEngine {
  const requests: TranscriptionEngineRequest[] = [];
  let lines: readonly { startMs: number; endMs: number; text: string }[] = [
    { startMs: 0, endMs: 1_000, text: 'first line' },
    { startMs: 1_200, endMs: 2_400, text: 'second line' },
  ];
  let languageCode = 'en';
  let confidence: number | null = 0.92;
  let failure: { detail: string; times: number } | null = null;

  return {
    requests,
    setOutput(output) {
      lines = output.lines;
      if (output.languageCode !== undefined) languageCode = output.languageCode;
      if (output.confidence !== undefined) confidence = output.confidence;
    },
    failNext(detail = 'simulated engine failure', times = 1) {
      failure = { detail, times };
    },
    transcribe: async (request): Promise<TranscriptionEngineOutcome> => {
      requests.push(request);
      if (failure !== null && failure.times > 0) {
        failure.times -= 1;
        return { kind: 'failed', detail: failure.detail };
      }
      return {
        kind: 'transcribed',
        output: {
          lines: lines.map((line) => ({ ...line })),
          languageCode: request.languageCode ?? languageCode,
          confidence: request.languageCode === undefined ? confidence : null,
        },
      };
    },
  };
}

export interface ScriptedTranscriptionProbe extends TranscriptionAudioProbePort {
  setAudio(audioId: string, audio: Partial<ProbedTranscriptionAudio>): void;
  setUnreadable(audioId: string, detail: string): void;
  readonly requests: readonly { readonly audioId: string; readonly speechMinDurationMs: number }[];
}

export function compliantTranscriptionAudio(
  overrides: Partial<ProbedTranscriptionAudio> = {},
): ProbedTranscriptionAudio {
  return {
    audioId: 'audio-1',
    durationMs: 10_000,
    sampleRate: 48_000,
    fileSizeBytes: 2_000_000,
    speechDurationMs: 8_000,
    ...overrides,
  };
}

export function createScriptedTranscriptionProbe(): ScriptedTranscriptionProbe {
  const rows = new Map<string, ProbedTranscriptionAudio>();
  const unreadable = new Map<string, string>();
  const requests: { audioId: string; speechMinDurationMs: number }[] = [];

  return {
    requests,
    setAudio(audioId, audio) {
      rows.set(audioId, compliantTranscriptionAudio({ audioId, ...audio }));
    },
    setUnreadable(audioId, detail) {
      unreadable.set(audioId, detail);
    },
    probe: async (request) => {
      requests.push({ audioId: request.audioId, speechMinDurationMs: request.speechMinDurationMs });
      const detail = unreadable.get(request.audioId);
      if (detail !== undefined) return { kind: 'unreadable', detail };
      return {
        kind: 'probed',
        audio: rows.get(request.audioId) ?? compliantTranscriptionAudio({ audioId: request.audioId }),
      };
    },
  };
}

export function createInMemoryTranscriptionStore(): TranscriptionStorePort & {
  readonly all: readonly TranscriptionResult[];
} {
  const rows = new Map<string, TranscriptionResult>();
  return {
    get all() {
      return [...rows.values()];
    },
    save: (audioId, result) => {
      rows.set(audioId, result);
    },
    find: (audioId) => rows.get(audioId),
  };
}

/* -------------------------------------------------------------------- harness */

export interface SpeechHarness {
  readonly speech: SpeechService;
  readonly profiles: VoiceProfileService;
  readonly conversion: VoiceConversionService;
  readonly transcription: TranscriptionService;
  readonly generation: GenerationHarness;
  readonly consent: VoiceConsentHarness;
  readonly profileStore: InMemoryVoiceProfileRecordStore;
  readonly referenceProbe: ScriptedReferenceProbe;
  readonly staging: RecordingStaging;
  readonly prompts: RecordingVoicePrompt;
  readonly synthesis: ScriptedSpeechSynthesis;
  readonly renditions: InMemoryRenditionStore;
  readonly conversionEngine: ScriptedVoiceConversion;
  readonly sourceUtterances: InMemorySourceUtterances;
  readonly transcriptionEngine: ScriptedTranscriptionEngine;
  readonly transcriptionProbe: ScriptedTranscriptionProbe;
  /** The two simulated deployments, by engine identifier. */
  readonly transports: ReadonlyMap<string, DeterministicTtsTransport>;
  /**
   * Registers a `cloned` Voice_Profile with a valid consent record, the ordinary way.
   *
   * Through `VoiceProfileService.createCloned`, not by writing rows: a fixture that inserted a
   * profile directly would let a test pass while the consent gate was broken.
   */
  createClonedProfile(options?: {
    readonly ownerId?: string;
    readonly name?: string;
    readonly uploadIds?: readonly string[];
  }): Promise<ClonedVoiceProfile>;
  createPresetProfile(options?: {
    readonly ownerId?: string;
    readonly name?: string;
    readonly voiceId?: string;
  }): PresetVoiceProfile;
  /** The wire payloads each simulated engine received, in submission order. */
  payloads(engineId: string): readonly Readonly<Record<string, unknown>>[];
}

export interface SpeechHarnessOptions {
  /** Requirement 34: judge against this set instead of the initial values. */
  readonly thresholds?: QualityThresholdSource;
  /** Requirement 25.18's draw. Defaults to `TEST_DIALOGUE_BASE_SEED`. */
  readonly seeds?: SeedSource;
  readonly sampleRate?: number;
  /** Register only these engines. Defaults to both. */
  readonly engines?: readonly TtsEngineCapabilities[];
}

export function createSpeechHarness(options: SpeechHarnessOptions = {}): SpeechHarness {
  const generation = createGenerationHarness({ assetKind: 'dialogue' });
  const consent = createVoiceConsentHarness({ clock: generation.clock });
  const engines = options.engines ?? TTS_ENGINE_CAPABILITIES;
  const sampleRate = options.sampleRate ?? TEST_SAMPLE_RATE;

  // Both engines, registered exactly as production would: real descriptors, real adapters, and the
  // two consecutive health successes Requirement 20.21 needs before an engine is selectable.
  const transports = new Map<string, DeterministicTtsTransport>();
  const adapters = new Map<
    string,
    { readonly adapter: EngineAdapter; readonly transport: DeterministicTtsTransport }
  >();

  for (const capabilities of engines) {
    const transport =
      capabilities.engineId === TTS_ENGINE_A_CAPABILITIES.engineId
        ? createDeterministicTtsATransport({ sampleRate })
        : createDeterministicTtsBTransport({ sampleRate });
    const adapter: EngineAdapter =
      capabilities.engineId === TTS_ENGINE_A_CAPABILITIES.engineId
        ? new TtsEngineAAdapter({ transport, clock: generation.clock, sampleRate })
        : new TtsEngineBAdapter({ transport, clock: generation.clock, sampleRate });

    generation.registry.register({
      descriptor: ttsEngineDescriptor(capabilities),
      adapter,
      actorId: 'operator-1',
    });
    for (let probe = 0; probe < 2; probe += 1) {
      generation.registry.recordHealthOutcome(capabilities.engineId, {
        outcome: 'success',
        checkedAtMs: generation.clock.now().getTime(),
        latencyMs: 5,
      });
    }

    transports.set(capabilities.engineId, transport);
    adapters.set(capabilities.engineId, { adapter, transport });
  }
  generation.registry.setDefaultEngine('dialogue', TTS_ENGINE_A_CAPABILITIES.engineId, 'operator-1');

  const profileStore = createInMemoryVoiceProfileRecordStore();
  const referenceProbe = createScriptedReferenceProbe();
  const staging = createRecordingStaging();
  const prompts = createRecordingVoicePrompt();
  const synthesis = createScriptedSpeechSynthesis(adapters);
  const renditions = createInMemoryRenditionStore();
  const conversionEngine = createScriptedVoiceConversion();
  const sourceUtterances = createInMemorySourceUtterances();
  const transcriptionEngine = createScriptedTranscriptionEngine();
  const transcriptionProbe = createScriptedTranscriptionProbe();
  const rejection = createJobQualityRejection(generation.runtime);
  const seeds = options.seeds ?? fixedSeedSource(TEST_DIALOGUE_BASE_SEED);

  const transcription = new TranscriptionService({
    probe: transcriptionProbe,
    engine: transcriptionEngine,
    store: createInMemoryTranscriptionStore(),
    clock: generation.clock,
    ...(options.thresholds === undefined ? {} : { thresholds: options.thresholds }),
  });

  let profileSequence = 0;
  const profiles = new VoiceProfileService({
    profiles: profileStore,
    // The consent-state row goes into task 6.2's own in-memory store, which is what
    // `ProfileAccessService` reads — so the two services genuinely share one row.
    consentState: {
      createConsentRow: ({ voiceProfileId, ownerId }) => {
        consent.profiles.create({ voiceProfileId, ownerId, context: initialWithdrawalContext() });
      },
    },
    consent: consent.consent,
    probe: referenceProbe,
    staging,
    prompts,
    transcription,
    clock: generation.clock,
    ...(options.thresholds === undefined ? {} : { thresholds: options.thresholds }),
    newProfileId: () => `vp-${String(++profileSequence)}`,
  });

  const speechOptions: SpeechServiceOptions = {
    orchestrator: generation.orchestrator,
    synthesis,
    renditions,
    access: consent.access,
    profiles: profileStore,
    languages: ttsLanguageCatalogue(engines),
    capabilities: engines.map((entry) => ({
      engineId: entry.engineId,
      supportsActingInstruction: entry.supportsActingInstruction,
      supportsParalinguisticTags: entry.supportsParalinguisticTags,
    })),
    rejection,
    seeds,
    defaultEngineId: TTS_ENGINE_A_CAPABILITIES.engineId,
    ...(options.thresholds === undefined ? {} : { thresholds: options.thresholds }),
  };

  const conversion = new VoiceConversionService({
    orchestrator: generation.orchestrator,
    conversion: conversionEngine,
    sourceAudio: sourceUtterances,
    profiles: profileStore,
    access: consent.access,
    consent: consent.consent,
    rejection,
    seeds,
    clock: generation.clock,
    defaultEngineId: TTS_ENGINE_A_CAPABILITIES.engineId,
    ...(options.thresholds === undefined ? {} : { thresholds: options.thresholds }),
  });

  return {
    speech: new SpeechService(speechOptions),
    profiles,
    conversion,
    transcription,
    generation,
    consent,
    profileStore,
    referenceProbe,
    staging,
    prompts,
    synthesis,
    renditions,
    conversionEngine,
    sourceUtterances,
    transcriptionEngine,
    transcriptionProbe,
    transports,
    createClonedProfile: (createOptions = {}) =>
      profiles.createCloned({
        ownerId: createOptions.ownerId ?? TEST_OWNER_ID,
        name: createOptions.name ?? 'Narrator',
        uploadIds: createOptions.uploadIds ?? ['upload-1'],
        consent: affirmativeCloneConsent(createOptions.ownerId ?? TEST_OWNER_ID),
      }),
    createPresetProfile: (createOptions = {}) =>
      profiles.createPreset({
        ownerId: createOptions.ownerId ?? TEST_OWNER_ID,
        name: createOptions.name ?? 'Preset Narrator',
        voiceId: createOptions.voiceId ?? 'a-ko-narrator',
      }),
    payloads: (engineId) =>
      (transports.get(engineId)?.submissions ?? []).map((entry) => entry.payload),
  };
}

/** Requirement 26.12's four items, all affirmative, from the speaker themselves. */
export function affirmativeCloneConsent(submitterId = TEST_OWNER_ID) {
  return {
    submitterId,
    isSpeaker: true,
    hasExplicitPermission: true,
    prohibitedUseConfirmation: true,
    speakerRelationship: '본인' as const,
  };
}

/** Requirement 26.26's two confirmations, both affirmative. */
export function affirmativeConvertConsent(submitterId = TEST_OWNER_ID) {
  return {
    submitterId,
    sourceRightsConfirmation: true,
    prohibitedUseConfirmation: true,
  };
}

/** A minimal valid dialogue request (Requirements 25.4, 25.17's defaults). */
export function dialogueRequest(
  voiceProfileId: string,
  overrides: Record<string, unknown> = {},
): {
  readonly script: string;
  readonly voiceProfileId: string;
  readonly languageCode: string;
} & Record<string, unknown> {
  return {
    script: 'First line of dialogue.\nSecond line of dialogue.',
    voiceProfileId,
    languageCode: 'ko',
    ...overrides,
  };
}

/** A source utterance for a voice conversion, of a stated length. */
export function sourceUtterance(durationMs: number, sampleRate = TEST_SAMPLE_RATE): PcmAudio {
  const frames = Math.max(1, Math.round((durationMs * sampleRate) / 1000));
  const samples = new Float32Array(frames);
  for (let index = 0; index < frames; index += 1) {
    samples[index] = 0.4 * Math.sin((2 * Math.PI * 180 * index) / sampleRate);
  }
  return monoAudio(samples, sampleRate);
}

/** The duration of a rendition's joined audio, for a test asserting 25.16's total. */
export function renditionDurationMs(rendition: DialogueRendition): number {
  return rendition.linePieces.reduce((total, piece) => total + audioDurationMs(piece), 0);
}
