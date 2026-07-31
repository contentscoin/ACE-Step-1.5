/**
 * Job_Orchestrator (Requirements 5.1–5.8, 6.1–6.6; design §2.3, §3.4).
 *
 * The public surface of the job lifecycle: accept, observe, cancel, retry. It owns
 * the *ordering* of the steps and nothing else — each individual rule lives in a
 * module it delegates to, which is what keeps this file readable at the size the
 * eight-plus-six acceptance criteria would otherwise force on it.
 *
 * The ordering of `submit` is the part worth reading carefully, because three
 * separate criteria depend on it:
 *
 * 1. **Route first** (Requirements 6.6, 20.x). Routing is free and rejects early.
 *    Requirement 6.6's "every engine for this Asset_Kind is unhealthy" is not
 *    re-derived here: it *is* the Provider_Registry's 503 `no_available_engine`,
 *    which already carries each candidate's last check time and result. One source
 *    of truth for engine health, one rejection.
 * 2. **Moderate before charging** (Requirements 16.2, 16.11). Everything that can
 *    cost credits is inside the `withModerationGate` callback, so a blocked request
 *    never reaches a callable that could debit. That is structural, not a
 *    convention — see `services/moderation/generation-gate.ts`.
 * 3. **Charge, then submit** (Requirements 5.1, 6.2, 6.3). The debit precedes the
 *    engine call so the amount to refund is known if the call fails, and the
 *    submission runs under the Requirement 6.2 backoff.
 */

import type { InputModality } from '../../adapters/normalized-generation';
import { routeGenerationRequest } from '../../adapters/registry/routing';
import type { AssetKind } from '../../domain/asset-kind';
import type { EditParameters } from '../../domain/edit/request';
import type { SongParameters } from '../../domain/song/request';
import type { JobFailure } from '../../domain/generation-job/failure';
import { isRetryableFailureClass } from '../../domain/generation-job/failure';
import type { GenerationJobState } from '../../domain/generation-job/lifecycle';
import { withModerationGate } from '../moderation/generation-gate';
import type { BlockedModeration, ModerationDecision } from '../moderation/decision';

import { submitWithRetry } from './engine-submission';
import {
  jobForbidden,
  jobNotCancellable,
  jobNotFound,
  jobNotRetryable,
} from './errors';
import { createJobRecord, retryRequestOf, type GenerationJobRecord } from './job-record';
import { jobStatusView, type JobStatusView } from './job-status';
import { applyJobEvent } from './job-transitions';
import { pollJobOnce, type PollResult } from './job-poller';
import type { JobRuntime } from './runtime';
import { sweepTimedOutJobs, type SweepResult } from './timeout-sweep';

export interface SubmitJobInput {
  readonly accountId: string;
  readonly assetKind: AssetKind;
  readonly inputModality: InputModality;
  readonly durationMs: number;
  readonly prompt?: string;
  readonly inputAssetIds?: readonly string[];
  readonly seed?: number | null;
  /** Engine named by the caller (Requirement 20.3); omitted means "route it". */
  readonly engineId?: string;
  /** Requirement 5.6: how many audio results are expected. */
  readonly resultCount?: number;
  /**
   * Validated song parameters (Requirements 3, 4), for Simple/Custom mode requests.
   *
   * Carried through untouched: the orchestrator neither reads nor defaults any of
   * it, because Requirements 3.3 and 4.7 make an absent field an instruction to the
   * engine rather than a gap to fill. It becomes part of the stored `input`, so a
   * Requirement 6.4 retry reproduces the same musical request.
   */
  readonly song?: SongParameters;
  /**
   * Validated Edit_Task parameters (Requirement 7).
   *
   * Carried through untouched, exactly like `song`: the orchestrator neither reads
   * nor defaults any of it. It becomes part of the stored `input`, so a Requirement
   * 6.4 retry reproduces the same edit against the same source audio, and the
   * Requirement 7.12 lineage recorded on completion names the same parent.
   */
  readonly edit?: EditParameters;
  /**
   * Content policy verdict, evaluated lazily.
   *
   * A thunk rather than a value so it cannot be computed after the expensive work
   * (design §9.1). Omitted only in compositions with no Moderation_Service, where
   * it defaults to approval of nothing.
   */
  readonly moderate?: () => ModerationDecision;
}

/** Requirement 5.1 response. */
export interface JobAcceptance {
  readonly jobId: string;
  readonly engineId: string;
  /** Requirement 5.1: 1-based waiting position. */
  readonly queuePosition: number;
  readonly engineJobId: string | null;
  readonly state: GenerationJobState;
  /** Requirement 5.5. */
  readonly estimatedCompletionAtMs: number | null;
  /** Requirement 20.10: set when routing substituted the default engine. */
  readonly substitutedEngine: boolean;
}

export type SubmitOutcome =
  | { readonly kind: 'blocked'; readonly decision: BlockedModeration }
  | { readonly kind: 'accepted'; readonly acceptance: JobAcceptance }
  /** Requirements 6.1, 6.3: the engine refused every permitted attempt. */
  | { readonly kind: 'failed'; readonly jobId: string; readonly failure: JobFailure };

const APPROVE_NOTHING: () => ModerationDecision = () => ({
  outcome: 'approved',
  texts: [],
  notices: [],
});

export class JobOrchestrator {
  constructor(private readonly runtime: JobRuntime) {}

  /** Requirements 5.1, 6.2, 6.3, 6.6, 16.2/16.11 ordering. */
  async submit(input: SubmitJobInput): Promise<SubmitOutcome> {
    // Step 1 — routing. Throws the registry's own rejection, including the
    // Requirement 6.6 maintenance notice (503 `no_available_engine`).
    const route = routeGenerationRequest(this.runtime.registry, {
      assetKind: input.assetKind,
      durationMs: input.durationMs,
      ...(input.engineId === undefined ? {} : { engineId: input.engineId }),
    });

    // Step 2 — the moderation gate. Nothing inside is reachable on a block.
    const gated = await withModerationGate(input.moderate ?? APPROVE_NOTHING, async () =>
      this.accept(
        { input: normaliseInput(input), resultCount: input.resultCount ?? 1 },
        route.engineId,
        route.substituted,
      ),
    );

    return gated.kind === 'blocked' ? { kind: 'blocked', decision: gated.decision } : gated.value;
  }

  /** Requirements 5.1, 5.3, 5.5, 6.1 projection. */
  async statusOf(jobId: string, accountId: string): Promise<JobStatusView> {
    return jobStatusView(this.runtime, await this.ownedJob(jobId, accountId));
  }

  /**
   * Requirement 5.7 — cancel a pending job and refund it.
   *
   * The engine is told too, best-effort: a cancel that the engine ignores must not
   * leave the user's job stuck, so the local transition is authoritative and an
   * engine-side failure is swallowed.
   */
  async cancel(jobId: string, accountId: string): Promise<JobStatusView> {
    const record = await this.ownedJob(jobId, accountId);
    const applied = await applyJobEvent(this.runtime, record, { kind: 'cancel_requested' });

    if (applied.transition.rejection !== null) {
      throw jobNotCancellable(jobId, record.lifecycle.state);
    }

    await this.tellEngineToCancel(record);
    return jobStatusView(this.runtime, applied.record);
  }

  /** Requirement 6.4 — a new job with identical input parameters. */
  async retry(jobId: string, accountId: string): Promise<SubmitOutcome> {
    const record = await this.ownedJob(jobId, accountId);
    const failure = record.lifecycle.failure;

    if (record.lifecycle.state !== 'failed' || failure === null) {
      throw jobNotRetryable(jobId, { state: record.lifecycle.state });
    }
    if (!isRetryableFailureClass(failure.classification)) {
      throw jobNotRetryable(jobId, {
        state: record.lifecycle.state,
        classification: failure.classification,
      });
    }

    const route = routeGenerationRequest(this.runtime.registry, {
      assetKind: record.input.assetKind,
      durationMs: record.input.durationMs,
      ...(record.input.engineId === undefined ? {} : { engineId: record.input.engineId }),
    });

    return this.accept(
      { input: record.input, resultCount: 1 },
      route.engineId,
      route.substituted,
      record.jobId,
    );
  }

  /** Requirements 5.2, 5.3, 5.6, 6.5 — one poll of one job. */
  pollOnce(jobId: string): Promise<PollResult> {
    return pollJobOnce(this.runtime, jobId);
  }

  /** Requirement 5.8 — fail and refund every job past its budget. */
  sweepTimeouts(): Promise<SweepResult> {
    return sweepTimedOutJobs(this.runtime);
  }

  /**
   * The charged part of submission: debit, enqueue, submit under backoff.
   *
   * Only reachable from inside the moderation gate, which is the whole point of
   * it being a private method rather than inline in `submit`.
   */
  private async accept(
    accepting: AcceptingJob,
    engineId: string,
    substituted: boolean,
    retryOfJobId?: string,
  ): Promise<SubmitOutcome> {
    const jobId = this.runtime.newId();
    const jobInput = accepting.input;
    const acceptedAtMs = this.runtime.clock.now().getTime();

    const { debitedAmount } = await this.runtime.charges.charge({
      accountId: jobInput.accountId,
      jobId,
      assetKind: jobInput.assetKind,
      engineId,
      durationMs: jobInput.durationMs,
      resultCount: accepting.resultCount,
    });

    // Requirement 20.13: the quota was checked by routing; consumption is recorded
    // here, once the job is genuinely accepted, so a rejected request leaves the
    // counters untouched.
    this.runtime.registry.quotas.consume(
      engineId,
      this.runtime.registry.quotaRequirementFor(engineId),
    );

    const record = createJobRecord({
      jobId,
      accountId: jobInput.accountId,
      input: jobInput,
      engineId,
      acceptedAtMs,
      debitedAmount,
      ...(retryOfJobId === undefined ? {} : { retryOfJobId }),
    });
    await this.runtime.store.save(record);
    const placement = await this.runtime.queue.enqueue(jobId);

    const adapter = this.runtime.registry.require(engineId).adapter;
    const submitted = await submitWithRetry(
      this.runtime,
      adapter,
      retryRequestOf(record, this.runtime.newId()),
      { engineId, accountId: jobInput.accountId, jobId, debitedAmount },
    );

    if (submitted.kind === 'failed') {
      const applied = await applyJobEvent(
        this.runtime,
        record,
        { kind: 'engine_failed', failure: submitted.failure },
        {
          attemptsMade: submitted.attemptsMade,
          refundSettledElsewhere: submitted.refundSettled,
        },
      );
      return { kind: 'failed', jobId, failure: applied.record.lifecycle.failure ?? submitted.failure };
    }

    // The lifecycle state is unchanged (still pending), so this is a field update
    // rather than a transition: Requirement 5.1's engine identifier and the
    // attempt count from Requirement 6.2.
    const accepted: GenerationJobRecord = {
      ...record,
      engineJobId: submitted.handle.engineJobId,
      attemptsMade: submitted.attemptsMade,
      updatedAtMs: this.runtime.clock.now().getTime(),
    };
    await this.runtime.store.save(accepted);

    const view = await jobStatusView(this.runtime, accepted);
    return {
      kind: 'accepted',
      acceptance: {
        jobId,
        engineId,
        queuePosition: view.queuePosition ?? placement.position,
        engineJobId: accepted.engineJobId,
        state: accepted.lifecycle.state,
        estimatedCompletionAtMs: view.estimatedCompletionAtMs,
        substitutedEngine: substituted,
      },
    };
  }

  private async ownedJob(jobId: string, accountId: string): Promise<GenerationJobRecord> {
    const record = await this.runtime.store.find(jobId);
    if (record === undefined) throw jobNotFound(jobId);
    if (record.accountId !== accountId) throw jobForbidden(jobId);
    return record;
  }

  private async tellEngineToCancel(record: GenerationJobRecord): Promise<void> {
    if (record.engineJobId === null) return;
    const adapter = this.runtime.registry.find(record.engineId)?.adapter;
    if (adapter === undefined) return;

    try {
      await adapter.cancel({
        engineId: record.engineId,
        engineJobId: record.engineJobId,
        submittedAtMs: record.acceptedAtMs,
      });
    } catch {
      // Requirement 5.7 is about the user's job and their credits, both of which
      // are already settled locally. An engine that refuses the cancel wastes GPU
      // time; it does not make the job uncancelled.
    }
  }
}

/** What `accept` needs: the reusable request, plus the count it is charged for. */
interface AcceptingJob {
  readonly input: GenerationJobRecord['input'];
  readonly resultCount: number;
}

/** Drops the fields that belong to the HTTP request rather than the job. */
function normaliseInput(input: SubmitJobInput): GenerationJobRecord['input'] {
  return {
    accountId: input.accountId,
    assetKind: input.assetKind,
    inputModality: input.inputModality,
    durationMs: input.durationMs,
    ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
    ...(input.inputAssetIds === undefined ? {} : { inputAssetIds: input.inputAssetIds }),
    ...(input.seed === undefined ? {} : { seed: input.seed }),
    ...(input.engineId === undefined ? {} : { engineId: input.engineId }),
    ...(input.song === undefined ? {} : { song: input.song }),
    ...(input.edit === undefined ? {} : { edit: input.edit }),
  };
}
