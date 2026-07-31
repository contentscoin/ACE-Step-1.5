/**
 * Deterministic in-memory fakes for the two mastering seams.
 *
 * **Neither dependency is reachable from this environment.** There is no Celery broker, and
 * DeepAFx is both unreachable and non-commercially licensed. So the product-layer rules of
 * Requirement 30 are exercised against these fakes, and the *audio* behaviour they stand in
 * for is tested where it actually lives — `dsp/test/test_mastering.py` and
 * `dsp/test/test_loudness.py`, over real buffers.
 *
 * The fakes are deliberately **scripted rather than simulated**. A fake that recomputed
 * loudness in TypeScript would be a second implementation of the thing under test, and every
 * test written against it would be a test of the fake. What the product layer's rules need is
 * control over the *numbers* — a result that misses its target, a curve that under-ducks one
 * region, a cleanup that changes length by 12 ms — because each of those is a refusal path
 * Requirement 30 specifies and none of them is reachable by feeding real audio to real code.
 */

import {
  OCTAVE_BAND_CENTRES_HZ,
  TRUE_PEAK_CEILING_DBTP,
} from '../../domain/mastering/bounds';
import type { SpeechRegion, VolumeAutomationPoint } from '../../domain/mastering/ducking';
import type { MasteringMeasurement } from '../../domain/mastering/measurement';
import type { GenerationVersion } from '../../domain/generation-version';
import type {
  AnalyseRequest,
  AnalyseResult,
  DialogueCleanupRequestDsp,
  DialogueCleanupResultDsp,
  DuckingRequestDsp,
  DuckingResultDsp,
  MasteringAudioRef,
  MasteringDspPort,
  NormaliseLoudnessRequest,
  NormaliseLoudnessResult,
  SuggestionModelPort,
} from '../../services/mastering/ports';
import type { TimeoutOutcome, TimeoutRunner } from '../../adapters/timeout-runner';
import type {
  DeepAfxSuggestRequest,
  DeepAfxSuggestResponse,
  DeepAfxTransport,
} from '../../adapters/deepafx/transport';

export const ASSET_ID = 'asset-mastering-1';
export const ORIGINAL_VERSION_ID = 'version-original-1';

/**
 * The level the fake's notional input sits at.
 *
 * Chosen so that a −14 LUFS target is reachable (4.3 dB of gain against 2.2 dB of headroom
 * would not be) *and* so that an aggressive target such as −6 LUFS is not — which is what
 * makes both Requirement 30.6's success path and Requirement 30.25's shortfall path
 * reachable from the same fixture.
 */
export const START_LOUDNESS_LUFS = -18.3;
export const START_TRUE_PEAK_DBTP = -6.5;

export function audioRef(overrides: Partial<MasteringAudioRef> = {}): MasteringAudioRef {
  return {
    objectKey: 'audio/original.flac',
    sampleRate: 48_000,
    channels: 2,
    frameCount: 48_000 * 3,
    ...overrides,
  };
}

/** A well-formed Requirement 30.22 report: ten bands, in the published order. */
export function measurement(
  overrides: Partial<Omit<MasteringMeasurement, 'octaveBands'>> & {
    readonly octaveBands?: readonly { readonly centreHz: number; readonly energyDb: number }[];
  } = {},
): MasteringMeasurement {
  return {
    integratedLoudnessLufs: START_LOUDNESS_LUFS,
    truePeakDbtp: START_TRUE_PEAK_DBTP,
    octaveBands: OCTAVE_BAND_CENTRES_HZ.map((centreHz, index) => ({
      centreHz,
      energyDb: -20 - index * 2,
    })),
    ...overrides,
  };
}

/** The version set an asset starts with: one original, which is also the default. */
export function originalVersions(): readonly GenerationVersion[] {
  return [
    {
      id: ORIGINAL_VERSION_ID,
      assetId: ASSET_ID,
      name: 'Original',
      effectChain: null,
      derivedFromVersionId: null,
      isOriginal: true,
      isDefault: true,
      durationMs: 3_000,
      createdAtMs: 0,
    },
  ];
}

export interface FakeDspScript {
  readonly analyse?: Partial<AnalyseResult>;
  readonly normalise?: Partial<NormaliseLoudnessResult>;
  readonly cleanup?: Partial<DialogueCleanupResultDsp>;
  readonly ducking?: Partial<DuckingResultDsp>;
}

export interface RecordingDspPort extends MasteringDspPort {
  /** Every request received, so a test can assert what crossed the seam. */
  readonly calls: {
    analyse: AnalyseRequest[];
    normalise: NormaliseLoudnessRequest[];
    cleanup: DialogueCleanupRequestDsp[];
    ducking: DuckingRequestDsp[];
  };
}

/**
 * A `MasteringDspPort` that returns scripted, compliant results unless told otherwise.
 *
 * The defaults satisfy every invariant Requirement 30 states, so a test that wants to
 * exercise a refusal path names *only* the field that breaks — which keeps each test's
 * intent visible instead of buried in a wall of plausible numbers.
 */
export function createFakeDspPort(script: FakeDspScript = {}): RecordingDspPort {
  const calls: RecordingDspPort['calls'] = {
    analyse: [],
    normalise: [],
    cleanup: [],
    ducking: [],
  };
  const output = audioRef({ objectKey: 'audio/mastered.flac' });

  return {
    calls,

    async analyse(request) {
      calls.analyse.push(request);
      return { measurement: measurement(), ...script.analyse };
    },

    async normaliseLoudness(request) {
      calls.normalise.push(request);
      // A compliant result, computed the way the worker computes one: the gain the target
      // asks for, clamped by the headroom the true-peak ceiling leaves (Requirement 30.7),
      // with `targetMissed` set when the clamp bound (Requirement 30.25).
      //
      // Modelled rather than hard-coded because a fake that ignored the ceiling would
      // produce results the service is right to refuse, and every test would then have to
      // pick a target quiet enough to dodge the problem.
      const before = measurement({
        integratedLoudnessLufs: START_LOUDNESS_LUFS,
        truePeakDbtp: START_TRUE_PEAK_DBTP,
      });
      const requestedGainDb = request.targetLufs - START_LOUDNESS_LUFS;
      const headroomDb = TRUE_PEAK_CEILING_DBTP - START_TRUE_PEAK_DBTP;
      const appliedGainDb = Math.min(requestedGainDb, headroomDb);
      const after = measurement({
        integratedLoudnessLufs: START_LOUDNESS_LUFS + appliedGainDb,
        truePeakDbtp: START_TRUE_PEAK_DBTP + appliedGainDb,
      });
      return {
        output,
        before,
        after,
        appliedGainDb,
        targetMissed: appliedGainDb < requestedGainDb,
        measurable: true,
        ...script.normalise,
      };
    },

    async cleanDialogue(request) {
      calls.cleanup.push(request);
      return {
        output,
        speechRegions: [
          { startMs: 500, endMs: 1_500 },
          { startMs: 2_000, endMs: 2_800 },
        ],
        nonSpeechRmsBeforeDb: -40,
        // Exactly the requested attenuation, which is what the worker's solver guarantees.
        nonSpeechRmsAfterDb: -40 - request.nonSpeechAttenuationDb,
        speechLoudnessBeforeLufs: -16.2,
        speechLoudnessAfterLufs: -16.4,
        hasNonSpeech: true,
        appliedFloorDb: -request.nonSpeechAttenuationDb,
        inputDurationMs: 3_000,
        outputDurationMs: 3_000,
        ...script.cleanup,
      };
    },

    async duck(request) {
      calls.ducking.push(request);
      const speechRegions: readonly SpeechRegion[] = [{ startMs: 1_000, endMs: 1_500 }];
      return {
        output,
        speechRegions,
        automationPoints: compliantCurve(
          speechRegions,
          3_000,
          request.depthDb,
          request.attackMs,
          request.releaseMs,
        ),
        durationMs: 3_000,
        ...script.ducking,
      };
    },
  };
}

/**
 * The curve shape the worker produces, restated here from Requirement 30.12/30.14/30.15.
 *
 * Restated deliberately: this is a *fixture*, not a second implementation of the envelope.
 * `domain/mastering/ducking.ts` verifies curves against the clauses, and a fixture built by
 * calling that verifier's own generator would make the verification circular. Written from
 * the clause, it is an independent example of a compliant curve.
 */
export function compliantCurve(
  regions: readonly SpeechRegion[],
  durationMs: number,
  depthDb: number,
  attackMs: number,
  releaseMs: number,
): readonly VolumeAutomationPoint[] {
  const points: VolumeAutomationPoint[] = [{ timeMs: 0, gainDb: 0 }];
  for (const region of regions) {
    points.push({ timeMs: Math.max(1, region.startMs - attackMs), gainDb: 0 });
    points.push({ timeMs: region.startMs, gainDb: depthDb });
    points.push({ timeMs: region.endMs, gainDb: depthDb });
    points.push({ timeMs: Math.min(durationMs, region.endMs + releaseMs), gainDb: 0 });
  }
  if ((points[points.length - 1]?.timeMs ?? 0) < durationMs) {
    points.push({ timeMs: durationMs, gainDb: 0 });
  }
  return points;
}

/** A `SuggestionModelPort` that answers with a fixed chain. */
export function createFakeSuggestionModel(
  items: unknown,
  options: { readonly engineId?: string; readonly commercialUseAllowed?: boolean } = {},
): SuggestionModelPort {
  return {
    async suggest() {
      return {
        engineId: options.engineId ?? 'deepafx-mastering-v1',
        items,
        commercialUseAllowed: options.commercialUseAllowed ?? false,
      };
    },
  };
}

/** A `SuggestionModelPort` that always rejects — Requirements 30.20, 30.21's state. */
export function createUnavailableSuggestionModel(error: Error): SuggestionModelPort {
  return {
    async suggest() {
      throw error;
    },
  };
}

/**
 * A `TimeoutRunner` that resolves `timed_out` without running the operation.
 *
 * This is what makes Requirement 30.20's 120-second path testable at all: the alternative is
 * a test that waits two minutes, which means a branch nobody ever checks. The operation is
 * deliberately *not* started, so a transport that would have succeeded cannot mask the
 * timeout.
 */
export function createTimingOutRunner(budgetMs: number): TimeoutRunner {
  return {
    async run<T>(): Promise<TimeoutOutcome<T>> {
      return { kind: 'timed_out', budgetMs };
    },
  };
}

/** A `TimeoutRunner` that runs the operation immediately, with no timer at all. */
export const immediateTimeoutRunner: TimeoutRunner = {
  async run<T>(operation: () => Promise<T>): Promise<TimeoutOutcome<T>> {
    try {
      return { kind: 'completed', value: await operation() };
    } catch (error: unknown) {
      return { kind: 'failed', error };
    }
  },
};

export interface RecordingDeepAfxTransport extends DeepAfxTransport {
  readonly requests: DeepAfxSuggestRequest[];
}

/** A `DeepAfxTransport` that returns a scripted envelope and records what it was sent. */
export function createFakeDeepAfxTransport(
  response: DeepAfxSuggestResponse | (() => Promise<DeepAfxSuggestResponse>),
): RecordingDeepAfxTransport {
  const requests: DeepAfxSuggestRequest[] = [];
  return {
    requests,
    async postJson(request) {
      requests.push(request);
      return typeof response === 'function' ? response() : response;
    },
  };
}

/** A chain the built-in mastering preset would produce; valid under Requirements 29.2–29.8. */
export const VALID_SUGGESTION_ITEMS = [
  { kind: 'highpass', parameters: { cutoff_frequency_hz: 35 } },
  {
    kind: 'compressor',
    parameters: { threshold_db: -14, ratio: 2.5, attack_ms: 25, release_ms: 200 },
  },
] as const;

/** A chain a model might return that Requirement 30.2's invariant forbids. */
export const OUT_OF_RANGE_SUGGESTION_ITEMS = [
  { kind: 'compressor', parameters: { threshold_db: -14, ratio: 99, attack_ms: 25, release_ms: 200 } },
] as const;
