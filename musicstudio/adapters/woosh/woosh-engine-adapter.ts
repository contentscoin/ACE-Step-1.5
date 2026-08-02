/**
 * Woosh_Adapter (design §3.1, §3.6; Requirement 22).
 *
 * The single coupling point between MusicStudio and a Woosh deployment. It implements
 * `EngineAdapter` and nothing more: the job lifecycle, the Requirement 6.2 retry schedule,
 * the Requirement 20.14 budget and the 0/1/2 status translation all belong to the
 * Job_Orchestrator, and re-deriving any of them here would create a second answer to a
 * settled question. This class is transport plus translation, exactly like
 * `AceEngineAdapter`.
 *
 * One instance serves one tier. Design §3.6 makes 고속 and 고품질 two engines
 * (`woosh-dflow`, `woosh-flow`), each with its own Engine_Descriptor, health history and
 * quota, so a tier is chosen by choosing an adapter rather than by a parameter inside one.
 * The tier is still recorded on the instance so the payload can name the right checkpoint.
 *
 * **No Woosh service is reachable from this environment.** Everything below is exercised
 * against a scripted transport; see the note in `transport.ts` for what that leaves
 * unverified.
 */

import type { EngineAdapter } from '../engine-adapter';
import type {
  EngineJobHandle,
  EngineJobStatus,
  HealthCheckResult,
  RawAudioResult,
} from '../engine-job';
import { ENGINE_JOB_STATE } from '../engine-job';
import type { NormalizedGenerationRequest } from '../normalized-generation';
import type { SfxModelTier } from '../../domain/sfx/model-tier';
import type { SfxParameters } from '../../domain/sfx/request';
import type { Clock } from '../../services/clock';

import { wooshMalformedResponse, wooshTaskUnknown } from './errors';
import { buildWooshSubmitPayload } from './submit-payload';
import {
  asRecord,
  decodeWooshSubmitAck,
  decodeWooshTaskResult,
  unwrapWooshEnvelope,
  wooshEngineStateOf,
  type WooshTaskResult,
} from './query-result';
import type { WooshTransport } from './transport';

export const WOOSH_PATHS = {
  submit: '/v1/sfx/submit',
  status: '/v1/sfx/status',
  audio: '/v1/sfx/audio',
  health: '/health',
} as const;

/**
 * Woosh's native output rate.
 *
 * Design §5.1 records that both ACE-Step and Woosh output 48 kHz, which is already the
 * canonical rate — so `normalizeEngineResult` resamples nothing for `sfx` and
 * `originalSampleRate` equals `sampleRate`. Stated as a constant rather than assumed, so a
 * deployment that turns out to differ changes one value.
 */
export const WOOSH_ENGINE_SAMPLE_RATE = 48_000;

/**
 * One produced sample, with the Requirement 22.6 alignment score attached.
 *
 * A `RawAudioResult` with one extra field, exactly as `AceRawAudioResult` extends it with
 * ACE-Step's musical metadata. Callers bound by the `EngineAdapter` interface see the plain
 * form; the SFX_Service narrows to read the score it has to rank by.
 */
export interface WooshRawAudioResult extends RawAudioResult {
  /** As the engine reported it, un-normalised. `null` when it reported none. */
  readonly alignmentScore: number | null;
}

export interface WooshEngineAdapterOptions {
  readonly engineId: string;
  /** Which of Requirement 22.9's two tiers this instance serves. */
  readonly tier: SfxModelTier;
  readonly transport: WooshTransport;
  readonly clock: Clock;
}

export class WooshEngineAdapter implements EngineAdapter {
  readonly engineId: string;
  readonly tier: SfxModelTier;

  private readonly transport: WooshTransport;
  private readonly clock: Clock;

  constructor(options: WooshEngineAdapterOptions) {
    this.engineId = options.engineId;
    this.tier = options.tier;
    this.transport = options.transport;
    this.clock = options.clock;
  }

  /**
   * Requirements 22.1, 22.4, 22.8, 22.10–22.13 all land on this wire body.
   *
   * The seed sent is `request.seed`, which is the *variant's* seed as derived by
   * `domain/sfx/seed.ts` — not `request.sfx.seed`, which records only what the caller named.
   * A request that reaches here with no `sfx` block is a programming error rather than a bad
   * user input: routing sent an `sfx` job to this adapter, so the parameters must be
   * present, and inventing defaults for them would submit a generation nobody validated.
   */
  async submit(request: NormalizedGenerationRequest): Promise<EngineJobHandle> {
    const parameters = sfxParametersOf(request);
    const payload = buildWooshSubmitPayload({
      parameters,
      seed: seedOf(request),
    });

    const response = await this.transport.postJson({ path: WOOSH_PATHS.submit, body: payload });
    const ack = decodeWooshSubmitAck(
      WOOSH_PATHS.submit,
      unwrapWooshEnvelope(WOOSH_PATHS.submit, response),
    );

    return {
      engineId: this.engineId,
      engineJobId: ack.taskId,
      submittedAtMs: this.clock.now().getTime(),
    };
  }

  /** Requirement 5.3's status, reported in design §3.1's 0/1/2 vocabulary. */
  async poll(handle: EngineJobHandle): Promise<EngineJobStatus> {
    const result = await this.queryResult(handle);
    const state = wooshEngineStateOf(result.statusCode);

    return {
      state,
      ...(result.progressPercent === null ? {} : { progressPercent: result.progressPercent }),
      ...(state === ENGINE_JOB_STATE.failed && result.failureReason !== null
        ? { failureReason: result.failureReason }
        : {}),
    };
  }

  /**
   * Downloads every produced sample, each carrying its alignment score.
   *
   * A sample the engine listed but has no path for is skipped rather than failing the whole
   * fetch: with `num_samples: 1` per submission that case does not arise today, and dropping
   * an incomplete entry is the behaviour that keeps a partially-written batch usable.
   */
  async fetchResult(handle: EngineJobHandle): Promise<WooshRawAudioResult[]> {
    const result = await this.queryResult(handle);

    const downloads = await Promise.all(
      result.entries.map(async (entry) => {
        if (entry.filePath === null) return null;
        const response = await this.transport.getBinary({
          path: WOOSH_PATHS.audio,
          query: { path: entry.filePath },
        });
        if (response.httpStatus < 200 || response.httpStatus >= 300) {
          throw wooshMalformedResponse(
            WOOSH_PATHS.audio,
            `Woosh answered ${String(response.httpStatus)} for a produced audio file.`,
          );
        }
        return {
          audioBuffer: response.body,
          sampleRate: WOOSH_ENGINE_SAMPLE_RATE,
          durationMs: entry.durationMs ?? 0,
          seed: entry.seed,
          alignmentScore: entry.alignmentScore,
        };
      }),
    );

    return downloads.filter((download): download is WooshRawAudioResult => download !== null);
  }

  /**
   * Requirement 20.7 liveness probe.
   *
   * The 10-second budget is applied by `health-monitor.ts`, so no timeout is set here. An
   * unreachable engine is an *unhealthy* engine rather than a thrown error, because the
   * monitor's job is to record an outcome for every probe.
   */
  async healthCheck(): Promise<HealthCheckResult> {
    const startedAtMs = this.clock.now().getTime();
    try {
      const response = await this.transport.postJson({ path: WOOSH_PATHS.health, body: {} });
      const data = asRecord(unwrapWooshEnvelope(WOOSH_PATHS.health, response));
      const status = data?.status;
      return {
        healthy: status === 'ok',
        latencyMs: this.elapsedSince(startedAtMs),
        ...(status === 'ok' ? {} : { detail: `unexpected status ${String(status)}` }),
      };
    } catch (error) {
      return {
        healthy: false,
        latencyMs: this.elapsedSince(startedAtMs),
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * No-op, for the reason `AceEngineAdapter.cancel` is one: no cancellation route is
   * documented, and the Job_Orchestrator already treats the local transition as
   * authoritative and the engine call as best-effort (Requirement 5.7). Resolving is the
   * honest answer — the user's job is cancelled and refunded, and the engine finishes work
   * nobody will collect.
   */
  async cancel(): Promise<void> {
    return Promise.resolve();
  }

  private async queryResult(handle: EngineJobHandle): Promise<WooshTaskResult> {
    const response = await this.transport.postJson({
      path: WOOSH_PATHS.status,
      body: { task_id_list: [handle.engineJobId] },
    });
    const result = decodeWooshTaskResult(
      WOOSH_PATHS.status,
      unwrapWooshEnvelope(WOOSH_PATHS.status, response),
      handle.engineJobId,
    );
    if (result === null) throw wooshTaskUnknown(handle.engineJobId);
    return result;
  }

  private elapsedSince(startedAtMs: number): number {
    return Math.max(0, this.clock.now().getTime() - startedAtMs);
  }
}

/** The validated SFX parameters a `sfx` request must carry. */
export function sfxParametersOf(request: NormalizedGenerationRequest): SfxParameters {
  const parameters = request.sfx;
  if (parameters === undefined) {
    throw wooshMalformedResponse(
      WOOSH_PATHS.submit,
      'a Woosh submission needs validated sfx parameters; none were carried on the request',
    );
  }
  return parameters;
}

/** Requirement 22.13: a submission always names a seed by the time it reaches an engine. */
function seedOf(request: NormalizedGenerationRequest): number {
  const seed = request.seed;
  if (typeof seed !== 'number' || !Number.isInteger(seed)) {
    throw wooshMalformedResponse(
      WOOSH_PATHS.submit,
      'a Woosh submission needs an integer seed; Requirement 22.13 draws one when the caller names none',
    );
  }
  return seed;
}
