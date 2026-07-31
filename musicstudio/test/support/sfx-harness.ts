/**
 * Test rig for the SFX_Service (Requirement 22).
 *
 * Built on `createGenerationHarness({ assetKind: 'sfx' })` and on the **real**
 * `WooshEngineAdapter` over the deterministic transport, so what the tests exercise is:
 *
 * - the real Requirement 5 job lifecycle and the real Requirement 6.2 backoff;
 * - the real `ProviderRegistry`, which means the Requirement 33.2 non-commercial ruling on
 *   Woosh's CC-BY-NC weights actually happens rather than being asserted about in isolation;
 * - the real routing of Requirements 20.3/20.5/20.6 against the real Engine_Descriptors;
 * - the real `CreditRefundPort`, so a Requirement 22.19 refund is counted where every other
 *   refund in the system is counted;
 * - the real Woosh wire payload, recorded and assertable.
 *
 * The one genuine fake is `SfxCandidatePort` — the seam onto *decoded* audio, which tasks 3.1
 * and 5.1 will fill. Its default is derived from the wire payload by the transport, so
 * Requirement 22.8's reproducibility is a property of the whole chain; a test that needs audio
 * which fails 22.14 or 22.15 scripts it instead.
 *
 * Nothing here sleeps. The clock moves only when a test moves it.
 */

import { WooshEngineAdapter } from '../../adapters/woosh/woosh-engine-adapter';
import { wooshEngineDescriptor } from '../../adapters/woosh/license';
import { wooshEngineIdFor } from '../../adapters/woosh/model-tier';
import { jobFailure } from '../../domain/generation-job/failure';
import type { PcmAudio } from '../../domain/audio/pcm';
import type { QualityThresholdSource } from '../../domain/quality/threshold-source';
import type { SfxModelTier } from '../../domain/sfx/model-tier';
import { fixedSeedSource, type SeedSource } from '../../domain/sfx/seed';
import { createInProcessAudioMeasurement } from '../../services/sound/in-process-measurement';
import { createJobQualityRejection } from '../../services/sound/job-quality-rejection';
import { SfxService } from '../../services/sound/sfx-service';
import type {
  SfxCandidate,
  SfxCandidateOutcome,
  SfxCandidatePort,
} from '../../services/sound/sfx-ports';

import {
  createDeterministicWooshTransport,
  type DeterministicWooshTransport,
  type SimulatedAudioShape,
} from './deterministic-woosh-transport';
import { createGenerationHarness, type GenerationHarness } from './generation-harness';

/** Base seed the harness draws when a request names none, so tests are deterministic. */
export const TEST_SFX_BASE_SEED = 1_234_567;

/** What one scripted variant returns: audio, or nothing at all. */
export type ScriptedSfxAttempt =
  | { readonly kind: 'audio'; readonly audio: PcmAudio; readonly alignmentScore?: number | null }
  /** Requirements 6.1–6.3: the engine answered but produced no audio. */
  | { readonly kind: 'unproduced'; readonly reason?: string };

export interface ScriptedSfxCandidatePort extends SfxCandidatePort {
  /** Queue the outcomes of successive variants, in order. */
  script(...attempts: readonly ScriptedSfxAttempt[]): void;
  /** One entry per `awaitCandidate` call, so a test can count variants. */
  readonly calls: readonly { readonly jobId: string; readonly seed: number }[];
}

export interface SfxHarness {
  readonly service: SfxService;
  readonly candidates: ScriptedSfxCandidatePort;
  readonly generation: GenerationHarness;
  /** The transport behind both Woosh engines; holds every wire payload. */
  readonly transport: DeterministicWooshTransport;
  /** Which shape the simulated engine produces for unscripted variants. */
  setAudioShape(shape: SimulatedAudioShape): void;
  /** The seeds the engine was actually asked for, in submission order. */
  seeds(): readonly number[];
  /** The wire payloads, in submission order. */
  payloads(): readonly Readonly<Record<string, unknown>>[];
}

export interface SfxHarnessOptions {
  /** Requirement 34: judge against this set instead of the initial values. */
  readonly thresholds?: QualityThresholdSource;
  /** Requirement 22.13's draw. Defaults to `TEST_SFX_BASE_SEED`. */
  readonly seeds?: SeedSource;
}

export function createSfxHarness(options: SfxHarnessOptions = {}): SfxHarness {
  const generation = createGenerationHarness({ assetKind: 'sfx' });
  const transport = createDeterministicWooshTransport();

  // Both tiers, registered exactly as production would: real descriptors carrying the
  // CC-BY-NC weight licence, real adapters, and the two consecutive health successes
  // Requirement 20.21 needs before an engine is selectable.
  for (const tier of ['fast', 'high_quality'] as const) {
    registerWooshTier(generation, transport, tier);
  }

  const candidates = createScriptedSfxCandidatePort(generation, transport);

  const service = new SfxService({
    orchestrator: generation.orchestrator,
    candidates,
    measurement: createInProcessAudioMeasurement(),
    rejection: createJobQualityRejection(generation.runtime),
    seeds: options.seeds ?? fixedSeedSource(TEST_SFX_BASE_SEED),
    ...(options.thresholds === undefined ? {} : { thresholds: options.thresholds }),
  });

  return {
    service,
    candidates,
    generation,
    transport,
    setAudioShape: (shape) => {
      transport.setAudioShape(shape);
    },
    seeds: () => transport.seeds(),
    payloads: () => transport.submissions.map((entry) => entry.payload),
  };
}

function registerWooshTier(
  generation: GenerationHarness,
  transport: DeterministicWooshTransport,
  tier: SfxModelTier,
): void {
  const engineId = wooshEngineIdFor(tier);
  const descriptor = wooshEngineDescriptor(tier);
  const adapter = new WooshEngineAdapter({
    engineId,
    tier,
    transport,
    clock: generation.clock,
  });

  generation.registry.register({ descriptor, adapter, actorId: 'operator-1' });
  for (let probe = 0; probe < 2; probe += 1) {
    generation.registry.recordHealthOutcome(engineId, {
      outcome: 'success',
      checkedAtMs: generation.clock.now().getTime(),
      latencyMs: 5,
    });
  }
}

/**
 * The candidate port: scripted when a test says so, otherwise derived from the wire payload.
 *
 * The derivation is what makes the reproducibility property meaningful — see
 * `deterministic-woosh-transport.ts`. The mapping from a Generation_Job to its Woosh task goes
 * through the stored job record's `engineJobId`, which is the same field Requirement 5.1
 * records, so nothing is threaded around the lifecycle to make this work.
 */
function createScriptedSfxCandidatePort(
  generation: GenerationHarness,
  transport: DeterministicWooshTransport,
): ScriptedSfxCandidatePort {
  const queued: ScriptedSfxAttempt[] = [];
  const calls: { jobId: string; seed: number }[] = [];
  let assetCounter = 0;

  const nextAssetId = (): string => {
    assetCounter += 1;
    return `sfx-asset-${String(assetCounter)}`;
  };

  return {
    calls,
    script(...attempts) {
      queued.push(...attempts);
    },
    awaitCandidate: async (query): Promise<SfxCandidateOutcome> => {
      calls.push({ jobId: query.jobId, seed: query.seed });
      const scripted = queued.shift();

      if (scripted?.kind === 'unproduced') {
        return {
          kind: 'unproduced',
          failure: jobFailure(
            'engine_error',
            'engine_reported_failure',
            scripted.reason ?? 'no audio',
          ),
        };
      }

      if (scripted?.kind === 'audio') {
        const candidate: SfxCandidate = {
          jobId: query.jobId,
          assetId: nextAssetId(),
          audio: scripted.audio,
          seed: query.seed,
          // `in` rather than `??`, because an explicit `null` is the meaningful case — it is how
          // a test says "the engine reported no alignment score at all".
          alignmentScore: 'alignmentScore' in scripted ? (scripted.alignmentScore ?? null) : 0.5,
        };
        return { kind: 'produced', candidate };
      }

      const record = await generation.store.find(query.jobId);
      const taskId = record?.engineJobId;
      if (taskId === null || taskId === undefined) {
        throw new Error(`job ${query.jobId} has no engine task to derive audio from`);
      }

      const candidate: SfxCandidate = {
        jobId: query.jobId,
        assetId: nextAssetId(),
        audio: transport.pcmFor(taskId),
        seed: query.seed,
        alignmentScore: transport.alignmentScoreFor(taskId),
      };
      return { kind: 'produced', candidate };
    },
  };
}

/** A minimal valid request (Requirements 22.2, 22.17). */
export function sfxRequest(overrides: Record<string, unknown> = {}) {
  return {
    prompt: 'a heavy wooden door slams shut',
    ...overrides,
  };
}
