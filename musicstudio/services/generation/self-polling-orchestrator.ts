/**
 * The orchestrator that follows through (roadmap §4.4, slice S5).
 *
 * `JobOrchestrator.submit` charges, enqueues and hands the request to the engine, and then
 * returns. Something has to come back for the answer: `schedulePolling` in `job-poller.ts`
 * re-arms a Requirement 5.2 poll until the job is terminal, and until this file *nothing in
 * production code called it*. The tests drive `pollOnce` by hand, the HTTP routes call
 * `submit` and `statusOf`, and a job submitted through a real gateway would have stayed
 * `pending` forever — accepted, paid for, never collected.
 *
 * A subclass rather than a change to `JobOrchestrator`, because the base class is exercised by
 * the Requirement 5 and 6 suites through explicit `pollOnce` calls, and giving it a timer would
 * make every one of those tests race a scheduler. The base stays a pure sequence of steps; this
 * adds the one side effect a deployment needs, and only a deployment constructs it.
 *
 * Cancel forgets the poll loop too: a job the user cancelled is terminal, so the next poll would
 * only be skipped, but not arming it at all is cheaper and leaves nothing to wonder about in a
 * process that runs for weeks.
 */

import type { ScheduledTask, Scheduler } from '../../adapters/registry/health-schedule';

import { JobOrchestrator, type SubmitJobInput, type SubmitOutcome } from './job-orchestrator';
import { schedulePolling } from './job-poller';
import type { JobStatusView } from './job-status';
import type { JobRuntime } from './runtime';

export interface SelfPollingOptions {
  /**
   * Told when a poll loop stopped because a poll threw. The job is left non-terminal for the
   * Requirement 5.8 sweep; a composition root logs it. Optional because a test may not care.
   */
  readonly onPollError?: (jobId: string, error: unknown) => void;
}

export class SelfPollingJobOrchestrator extends JobOrchestrator {
  private readonly pollLoops = new Map<string, ScheduledTask>();

  constructor(
    private readonly pollingRuntime: JobRuntime,
    private readonly options: SelfPollingOptions = {},
  ) {
    super(pollingRuntime);
  }

  override async submit(input: SubmitJobInput): Promise<SubmitOutcome> {
    return this.armed(await super.submit(input));
  }

  override async retry(jobId: string, accountId: string): Promise<SubmitOutcome> {
    return this.armed(await super.retry(jobId, accountId));
  }

  override async cancel(jobId: string, accountId: string): Promise<JobStatusView> {
    const view = await super.cancel(jobId, accountId);
    this.forget(jobId);
    return view;
  }

  /** Jobs with a live poll loop — what a readiness probe or a test wants to know. */
  get pollingJobIds(): readonly string[] {
    return [...this.pollLoops.keys()];
  }

  /** Cancels every loop. Shutdown; the jobs themselves are untouched. */
  stopPolling(): void {
    for (const loop of this.pollLoops.values()) loop.cancel();
    this.pollLoops.clear();
  }

  private armed(outcome: SubmitOutcome): SubmitOutcome {
    if (outcome.kind !== 'accepted') return outcome;
    const { jobId } = outcome.acceptance;
    // A retry submits under a *new* job id, so a loop for this id cannot already exist; the
    // guard is for the day that stops being true rather than a case reachable today.
    this.forget(jobId);
    this.pollLoops.set(
      jobId,
      schedulePolling(this.pollingRuntime, jobId, (settled) => {
        this.pollLoops.delete(jobId);
        if (settled.kind === 'threw') this.options.onPollError?.(jobId, settled.error);
      }),
    );
    return outcome;
  }

  private forget(jobId: string): void {
    this.pollLoops.get(jobId)?.cancel();
    this.pollLoops.delete(jobId);
  }
}

/**
 * Requirement 5.8 on a timer: `sweepTimeouts` every `intervalMs`, re-armed after each run.
 *
 * Returned as a `ScheduledTask` so the composition root can stop it at shutdown. Errors go to
 * `onError` and do not stop the loop — a sweep that failed once must run again, because the
 * jobs it would have failed are still overdue.
 */
export function startTimeoutSweep(
  orchestrator: JobOrchestrator,
  scheduler: Scheduler,
  intervalMs: number,
  onError: (error: unknown) => void = () => {},
): ScheduledTask {
  let stopped = false;
  let current: ScheduledTask | null = null;

  const arm = (): void => {
    if (stopped) return;
    current = scheduler.after(intervalMs, () => {
      void orchestrator
        .sweepTimeouts()
        .catch(onError)
        .finally(arm);
    });
  };
  arm();

  return {
    cancel: () => {
      stopped = true;
      current?.cancel();
    },
  };
}
