/**
 * Test rig for the BGM_Service (Requirement 21).
 *
 * Built on `createGenerationHarness({ assetKind: 'bgm' })` rather than on a stand-in
 * orchestrator, so what the tests exercise is the real Requirement 5 lifecycle, the real
 * Requirement 6.2 backoff and the real `CreditRefundPort`. That is what makes the
 * Requirement 21.18 refund assertions meaningful: the refund is counted where every
 * other refund in the system is counted.
 *
 * The one genuine fake is `BgmCandidatePort` — the seam onto audio the engine produced,
 * which tasks 3.1 and 5.1 will fill. A test scripts the PCM each attempt returns, which
 * is how "attempt 1 and 2 fail the seam, attempt 3 passes" becomes expressible without
 * an engine that can be asked to generate a bad loop on demand.
 *
 * Nothing here sleeps. The Requirement 6.2 backoff runs on the harness's manual
 * scheduler, and the clock moves only when a test moves it.
 */

import type { PcmAudio } from '../../domain/audio/pcm';
import { createInProcessAudioMeasurement } from '../../services/sound/in-process-measurement';
import { createJobQualityRejection } from '../../services/sound/job-quality-rejection';
import { BgmService } from '../../services/sound/bgm-service';
import type {
  BgmCandidate,
  BgmCandidateOutcome,
  BgmCandidatePort,
} from '../../services/sound/bgm-ports';
import type { QualityThresholdSource } from '../../domain/quality/threshold-source';
import { jobFailure } from '../../domain/generation-job/failure';

import { createGenerationHarness, type GenerationHarness } from './generation-harness';
import { compliantLoop } from './pcm-synthesis';

/** What one scripted attempt returns: audio, or nothing at all. */
export type ScriptedAttempt =
  | {
      readonly kind: 'audio';
      readonly audio: PcmAudio;
      readonly bpm?: number;
      readonly keyScale?: string;
      readonly timeSignature?: number;
    }
  /** Requirements 6.1–6.3: the engine answered but produced no audio. */
  | { readonly kind: 'unproduced'; readonly reason?: string };

export interface ScriptedCandidatePort extends BgmCandidatePort {
  /** Queue the outcomes of successive attempts, in order. */
  script(...attempts: readonly ScriptedAttempt[]): void;
  /** Returned once the script is exhausted. */
  setDefault(attempt: ScriptedAttempt): void;
  /** One entry per `awaitCandidate` call, so a test can count attempts. */
  readonly calls: readonly { readonly jobId: string; readonly accountId: string }[];
}

export const DEFAULT_BGM_BPM = 120;
export const DEFAULT_BGM_KEY = 'C major';
export const DEFAULT_BGM_TIME_SIGNATURE = 4;

export function createScriptedCandidatePort(): ScriptedCandidatePort {
  const queued: ScriptedAttempt[] = [];
  const calls: { jobId: string; accountId: string }[] = [];
  let fallback: ScriptedAttempt = {
    kind: 'audio',
    audio: compliantLoop({
      bpm: DEFAULT_BGM_BPM,
      timeSignature: DEFAULT_BGM_TIME_SIGNATURE,
      barCount: 4,
    }).audio,
  };
  let assetCounter = 0;

  return {
    calls,
    script(...attempts) {
      queued.push(...attempts);
    },
    setDefault(attempt) {
      fallback = attempt;
    },
    awaitCandidate: async (query): Promise<BgmCandidateOutcome> => {
      calls.push({ jobId: query.jobId, accountId: query.accountId });
      const attempt = queued.shift() ?? fallback;

      if (attempt.kind === 'unproduced') {
        return {
          kind: 'unproduced',
          failure: jobFailure(
            'engine_error',
            'engine_reported_failure',
            attempt.reason ?? 'no audio',
          ),
        };
      }

      assetCounter += 1;
      const candidate: BgmCandidate = {
        jobId: query.jobId,
        assetId: `bgm-asset-${String(assetCounter)}`,
        audio: attempt.audio,
        bpm: attempt.bpm ?? DEFAULT_BGM_BPM,
        keyScale: attempt.keyScale ?? DEFAULT_BGM_KEY,
        timeSignature: attempt.timeSignature ?? DEFAULT_BGM_TIME_SIGNATURE,
        seed: 0,
      };
      return { kind: 'produced', candidate };
    },
  };
}

export interface BgmHarness {
  readonly service: BgmService;
  readonly candidates: ScriptedCandidatePort;
  readonly generation: GenerationHarness;
  /** Every seed the engine was actually asked for, in submission order. */
  seeds(): readonly (number | null | undefined)[];
}

export interface BgmHarnessOptions {
  /** Requirement 34: judge against this set instead of the initial values. */
  readonly thresholds?: QualityThresholdSource;
  readonly seedForAttempt?: (attempt: number) => number;
}

export function createBgmHarness(options: BgmHarnessOptions = {}): BgmHarness {
  const generation = createGenerationHarness({ assetKind: 'bgm' });
  const candidates = createScriptedCandidatePort();

  const service = new BgmService({
    orchestrator: generation.orchestrator,
    candidates,
    measurement: createInProcessAudioMeasurement(),
    rejection: createJobQualityRejection(generation.runtime),
    ...(options.thresholds === undefined ? {} : { thresholds: options.thresholds }),
    ...(options.seedForAttempt === undefined ? {} : { seedForAttempt: options.seedForAttempt }),
  });

  return {
    service,
    candidates,
    generation,
    seeds: () => generation.adapter.submitted.map((request) => request.seed),
  };
}

/** A minimal valid request (Requirements 21.2, 21.5). */
export function bgmRequest(overrides: Record<string, unknown> = {}) {
  return {
    sceneDescription: 'a quiet rain-soaked street at night',
    targetLengthSeconds: 8,
    ...overrides,
  };
}

/** The loop request the seam criteria apply to (Requirement 21.6). */
export function bgmLoopRequest(overrides: Record<string, unknown> = {}) {
  return bgmRequest({
    loop: true,
    bpm: DEFAULT_BGM_BPM,
    timeSignature: DEFAULT_BGM_TIME_SIGNATURE,
    // 4 bars at 120 BPM 4/4 is 8 seconds, which is what the default audio is.
    targetLengthSeconds: 8,
    ...overrides,
  });
}
