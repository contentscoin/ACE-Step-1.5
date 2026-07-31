/**
 * Test rig for the V2A_Service (Requirement 23).
 *
 * Built on `createGenerationHarness({ assetKind: 'sfx' })`, so what the tests exercise is the
 * **real** Requirement 5 job lifecycle, the real routing of Requirements 20.3/20.5/20.6, the
 * real `CreditRefundPort` (so a Requirement 23.8/23.9/23.12 refund is counted where every other
 * refund in the system is counted), the real `createJobQualityRejection` — one refund path — and
 * the real in-process measurement.
 *
 * The fakes are the four ports of `v2a-ports.ts`, and every one of them stands in for something
 * that does not exist in this environment:
 *
 * - **`V2aUploadPort`** — there is no container to probe, so a "video" is its probed metadata
 *   record. That is not a shortcut: `domain/v2a/validation.ts` is *written* over such a record
 *   precisely so Requirements 23.2–23.4 are checkable without a decoder (task 3.1's).
 * - **`V2aFrameSourcePort`** — no codec, so a sample is the plan's frame count and a handle. The
 *   plans are recorded, which is what makes Requirement 23.6 assertable.
 * - **`V2aSegmentPort`** — no V2A engine. The fake is a *deterministic function of its request*:
 *   audio derived from the seed and the segment, impacts placed where the scripted visual events
 *   are. That is what makes Requirement 23.14's reproducibility a property of the chain rather
 *   than an assumption, and Requirement 23.8's alignment a claim about the detector rather than
 *   about a hand-built buffer.
 * - **`V2aPreviewMuxPort`** — no container writer, so the muxer reports the offsets it was told
 *   to report. Requirement 23.12 is a check on *measured* offsets, so a fake that reports them is
 *   exactly the right shape.
 *
 * Nothing here sleeps. The clock moves only when a test moves it, which is what makes
 * Requirement 23.17's budget testable without waiting 900 seconds.
 */

import type { PcmAudio } from '../../domain/audio/pcm';
import { jobFailure } from '../../domain/generation-job/failure';
import type { QualityThresholdSource } from '../../domain/quality/threshold-source';
import type { UploadDeclaration } from '../../domain/moderation/upload-consent';
import { fixedSeedSource, type SeedSource } from '../../domain/sfx/seed';
import { V2A_SEGMENT_OVERLAP_MS } from '../../domain/v2a/bounds';
import type { VideoSegment } from '../../domain/v2a/segmentation';
import type { ProbedVideoMetadata } from '../../domain/v2a/video-metadata';
import type { VisualEvent } from '../../domain/v2a/visual-event-timeline';
import { createInProcessAudioMeasurement } from '../../services/sound/in-process-measurement';
import { createJobQualityRejection } from '../../services/sound/job-quality-rejection';
import { V2aService } from '../../services/sound/v2a-service';
import type {
  FrameSampleRequest,
  PreviewMuxRequest,
  PreviewMuxResult,
  SampledFrames,
  V2aFrameSourcePort,
  V2aPreviewMuxPort,
  V2aSegmentOutcome,
  V2aSegmentPort,
  V2aSegmentRequest,
  V2aUploadPort,
  VideoProbeOutcome,
} from '../../services/sound/v2a-ports';

import { createGenerationHarness, type GenerationHarness } from './generation-harness';
import { TEST_SAMPLE_RATE } from './pcm-synthesis';
import { foleyAudio, validVideoMetadata } from './v2a-synthesis';

/** Base seed the harness draws when a request names none, so tests are deterministic. */
export const TEST_V2A_BASE_SEED = 4_242_424;

export const TEST_UPLOAD_ID = 'upload-1';

/* ------------------------------------------------------------------ uploads */

export interface FakeV2aUploadPort extends V2aUploadPort {
  /** Make `probe` answer with this record. */
  setMetadata(metadata: ProbedVideoMetadata): void;
  /** Make `probe` answer that the container could not be read at all. */
  setUnreadable(detail: string): void;
  /** Requirement 23.4/23.13: every upload identifier `discard` was called with. */
  readonly discarded: readonly string[];
  readonly probes: readonly string[];
}

export function createFakeV2aUploadPort(
  initial: ProbedVideoMetadata = validVideoMetadata(),
): FakeV2aUploadPort {
  const discarded: string[] = [];
  const probes: string[] = [];
  let outcome: VideoProbeOutcome = { kind: 'probed', metadata: initial };

  return {
    discarded,
    probes,
    setMetadata(metadata) {
      outcome = { kind: 'probed', metadata };
    },
    setUnreadable(detail) {
      outcome = { kind: 'unreadable', detail };
    },
    probe: async (uploadId) => {
      probes.push(uploadId);
      return outcome;
    },
    discard: async (uploadId) => {
      discarded.push(uploadId);
    },
  };
}

/* ------------------------------------------------------------------- frames */

export interface RecordingFrameSourcePort extends V2aFrameSourcePort {
  /** One entry per segment, in the order Requirement 23.7 generated them. */
  readonly requests: readonly FrameSampleRequest[];
}

export function createRecordingFrameSourcePort(): RecordingFrameSourcePort {
  const requests: FrameSampleRequest[] = [];

  return {
    requests,
    sample: async (request): Promise<SampledFrames> => {
      requests.push(request);
      return {
        handle: `frames-${request.uploadId}-${String(request.segment.index)}`,
        // Requirement 23.6: an honest sampler returns exactly the plan it was given.
        frameCount: request.plan.sourceIndices.length,
        frameRate: request.plan.targetFrameRate,
      };
    },
  };
}

/* ----------------------------------------------------------------- segments */

/** What one scripted segment call returns instead of the derived default. */
export type ScriptedSegment =
  | { readonly kind: 'audio'; readonly audio: PcmAudio; readonly events?: readonly VisualEvent[] }
  /** Requirements 6.1–6.3: the engine answered but produced no audio for this segment. */
  | { readonly kind: 'unproduced'; readonly reason?: string };

export interface FakeV2aSegmentPort extends V2aSegmentPort {
  /**
   * Clip-relative visual events the simulated detector reports.
   *
   * Each is assigned to exactly one segment — the first whose half-open span contains it — and
   * handed back with a segment-relative time, which is the contract `V2aSegmentAudio` states.
   * Unique assignment rather than "every segment that overlaps it" because two reports of one
   * event would inflate Requirement 23.8's denominator, and no requirement asks the service to
   * deduplicate.
   */
  setEvents(events: readonly VisualEvent[]): void;
  /**
   * Clip times at which the produced audio has an impact.
   *
   * Defaults to the confident event times, which is the aligned case. A test that wants
   * Requirement 23.8 to *fail* sets impacts somewhere else — that is the whole point of keeping
   * the two separate.
   */
  setImpacts(timesMs: readonly number[]): void;
  /**
   * The clip length, so the fake can tell the final segment from the others.
   *
   * Needed for event ownership and for nothing else: a non-final segment owns only
   * `[start, end − overlap)`, because the overlap belongs to its successor, while the final
   * segment owns everything to its end. Deriving "am I last?" from the segment alone is not
   * possible — a clip whose length happens to be `7950·(n−1) + 8000` ends with a full-length
   * segment — so the length is stated rather than guessed.
   */
  setClipDurationMs(durationMs: number): void;
  /** Queue outcomes for successive segment calls, in order. */
  script(...segments: readonly ScriptedSegment[]): void;
  readonly requests: readonly V2aSegmentRequest[];
}

/** Confidence at or above which the harness treats a scripted event as an impact source. */
const HARNESS_CONFIDENT = 0.5;

export interface FakeSegmentPortOptions {
  readonly sampleRate?: number;
  readonly overlapMs?: number;
  readonly clipDurationMs?: number;
}

export function createFakeV2aSegmentPort(
  options: FakeSegmentPortOptions = {},
): FakeV2aSegmentPort {
  const sampleRate = options.sampleRate ?? TEST_SAMPLE_RATE;
  const overlapMs = options.overlapMs ?? V2A_SEGMENT_OVERLAP_MS;
  const requests: V2aSegmentRequest[] = [];
  const queued: ScriptedSegment[] = [];
  let clipEvents: readonly VisualEvent[] = [];
  let impacts: readonly number[] | null = null;
  let clipDurationMs = options.clipDurationMs ?? Number.POSITIVE_INFINITY;

  const ownsEvent = (segment: VideoSegment, timeMs: number): boolean => {
    if (timeMs < segment.startMs) return false;
    const isFinal = segment.endMs >= clipDurationMs - 1e-6;
    return timeMs <= (isFinal ? segment.endMs : segment.endMs - overlapMs - 1e-9);
  };

  const eventsFor = (segment: VideoSegment): readonly VisualEvent[] =>
    clipEvents
      .filter((event) => ownsEvent(segment, event.timeMs))
      .map((event) => ({ ...event, timeMs: event.timeMs - segment.startMs }));

  const impactsFor = (segment: VideoSegment): readonly number[] => {
    const clipImpacts =
      impacts ??
      clipEvents
        .filter((event) => event.confidence >= HARNESS_CONFIDENT)
        .map((event) => event.timeMs);
    return clipImpacts
      .filter((timeMs) => timeMs >= segment.startMs && timeMs < segment.endMs)
      .map((timeMs) => timeMs - segment.startMs);
  };

  return {
    requests,
    setEvents(events) {
      clipEvents = [...events];
    },
    setImpacts(timesMs) {
      impacts = [...timesMs];
    },
    setClipDurationMs(durationMs) {
      clipDurationMs = durationMs;
    },
    script(...segments) {
      queued.push(...segments);
    },
    generateSegment: async (request): Promise<V2aSegmentOutcome> => {
      requests.push(request);
      const scripted = queued.shift();

      if (scripted?.kind === 'unproduced') {
        return {
          kind: 'unproduced',
          failure: jobFailure(
            'engine_error',
            'engine_reported_failure',
            scripted.reason ?? 'no audio for segment',
          ),
        };
      }

      if (scripted?.kind === 'audio') {
        return {
          kind: 'produced',
          result: {
            audio: scripted.audio,
            events: scripted.events ?? eventsFor(request.segment),
          },
        };
      }

      return {
        kind: 'produced',
        result: {
          audio: foleyAudio({
            durationMs: request.segment.durationMs,
            impactTimesMs: impactsFor(request.segment),
            sampleRate,
            // Requirement 23.14: the seed has to *matter*, or "same seed, same samples" would
            // be true of a fake that ignored it and the property would prove nothing.
            amplitude: seedAmplitude(request.seed),
          }),
          events: eventsFor(request.segment),
        },
      };
    },
  };
}

/** A deterministic amplitude in `[0.5, 0.9)`, so different seeds give different samples. */
function seedAmplitude(seed: number): number {
  return 0.5 + ((Math.abs(seed) % 400) / 1000);
}

/* ------------------------------------------------------------------ preview */

export interface FakeV2aPreviewMuxPort extends V2aPreviewMuxPort {
  /** Requirement 23.12: what the muxer measures. Defaults to perfect alignment. */
  setOffsets(offsets: { readonly audioStartMs: number; readonly videoStartMs: number }): void;
  readonly requests: readonly PreviewMuxRequest[];
}

export function createFakeV2aPreviewMuxPort(clockNowMs: () => number): FakeV2aPreviewMuxPort {
  const requests: PreviewMuxRequest[] = [];
  let audioStartMs = 0;
  let videoStartMs = 0;
  let counter = 0;

  return {
    requests,
    setOffsets(offsets) {
      audioStartMs = offsets.audioStartMs;
      videoStartMs = offsets.videoStartMs;
    },
    mux: async (request): Promise<PreviewMuxResult> => {
      requests.push(request);
      counter += 1;
      return {
        previewFileId: `preview-${request.jobId}-${String(counter)}`,
        audioStartMs,
        videoStartMs,
        createdAtMs: clockNowMs(),
      };
    },
  };
}

/* ------------------------------------------------------------------ harness */

export interface V2aHarness {
  readonly service: V2aService;
  readonly generation: GenerationHarness;
  readonly uploads: FakeV2aUploadPort;
  readonly frames: RecordingFrameSourcePort;
  readonly segments: FakeV2aSegmentPort;
  readonly preview: FakeV2aPreviewMuxPort;
  /**
   * Replace the probed record.
   *
   * Goes through the harness rather than through `uploads` directly so the simulated detector
   * learns the new clip length too — otherwise it could not tell which segment is the final one.
   */
  setMetadata(metadata: ProbedVideoMetadata): void;
  /** The seeds the simulated engine was actually asked for, in submission order. */
  seeds(): readonly number[];
}

export interface V2aHarnessOptions {
  /** Requirement 34: judge against this set instead of the initial values. */
  readonly thresholds?: QualityThresholdSource;
  /** Requirement 23.14's draw. Defaults to `TEST_V2A_BASE_SEED`. */
  readonly seeds?: SeedSource;
  /** Requirement 23.2/23.3's probed record. Defaults to a compliant one. */
  readonly metadata?: ProbedVideoMetadata;
  /** Requirement 23.17's budget, so a test can shrink it instead of waiting. */
  readonly jobBudgetMs?: number;
  readonly sampleRate?: number;
}

export function createV2aHarness(options: V2aHarnessOptions = {}): V2aHarness {
  const generation = createGenerationHarness({ assetKind: 'sfx' });
  const metadata = options.metadata ?? validVideoMetadata();
  const uploads = createFakeV2aUploadPort(metadata);
  const frames = createRecordingFrameSourcePort();
  const segments = createFakeV2aSegmentPort({
    clipDurationMs: metadata.durationMs,
    ...(options.sampleRate === undefined ? {} : { sampleRate: options.sampleRate }),
  });
  const preview = createFakeV2aPreviewMuxPort(() => generation.clock.now().getTime());

  const service = new V2aService({
    orchestrator: generation.orchestrator,
    uploads,
    frames,
    segments,
    preview,
    measurement: createInProcessAudioMeasurement(),
    rejection: createJobQualityRejection(generation.runtime),
    seeds: options.seeds ?? fixedSeedSource(TEST_V2A_BASE_SEED),
    clock: generation.clock,
    ...(options.thresholds === undefined ? {} : { thresholds: options.thresholds }),
    ...(options.jobBudgetMs === undefined ? {} : { jobBudgetMs: options.jobBudgetMs }),
  });

  return {
    service,
    generation,
    uploads,
    frames,
    segments,
    preview,
    setMetadata: (next) => {
      uploads.setMetadata(next);
      segments.setClipDurationMs(next.durationMs);
    },
    seeds: () => segments.requests.map((request) => request.seed),
  };
}

/** Requirement 23.11 / 16.14: a declaration that carries the rights confirmation. */
export function consentingUpload(
  overrides: Partial<UploadDeclaration> = {},
): UploadDeclaration {
  return {
    uploadId: TEST_UPLOAD_ID,
    purpose: 'foley_video',
    mediaKind: 'video',
    rightsConsent: { holdsRights: true, acknowledgedAtMs: 1_700_000_000_000 },
    ...overrides,
  };
}

/** Requirement 23.11's failing case: the confirmation was never recorded. */
export function unconsentingUpload(
  overrides: Partial<UploadDeclaration> = {},
): UploadDeclaration {
  return {
    uploadId: TEST_UPLOAD_ID,
    purpose: 'foley_video',
    mediaKind: 'video',
    ...overrides,
  };
}
