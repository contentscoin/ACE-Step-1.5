/**
 * Generation_Job lifecycle as a pure state machine (Requirements 5.3, 5.6, 5.7,
 * 5.8, 6.1, 6.3, 6.5).
 *
 * Five criteria all describe transitions of the same object, and each of them
 * attaches consequences: a refund (5.7, 5.8, 6.3), an asset publication (5.6), an
 * audit entry (6.3), a push to open connections (5.4). Spread across the poller,
 * the cancel route and the timeout sweep, those consequences would be four
 * independent chances to refund twice or not at all.
 *
 * So the transition and its obligations are one pure function. Every caller gets
 * the next state *and* the exact set of effects that state change owes, and the
 * function is the only place that decides either. `services/generation/` performs
 * the effects; it does not choose them.
 *
 * The single most important rule here is that a terminal state absorbs everything.
 * That is what makes the two timeout mechanisms compose: a job already failed by
 * the Requirement 5.8 sweep cannot be failed again by a late Requirement 20.15
 * remote-call timeout, and neither can refund twice.
 *
 * Pure: no clock, no I/O, no storage.
 */

import { jobTimeoutFailure, type JobFailure } from './failure';

export const GENERATION_JOB_STATES = [
  'pending',
  'running',
  'succeeded',
  'failed',
  'cancelled',
] as const;

export type GenerationJobState = (typeof GENERATION_JOB_STATES)[number];

export const TERMINAL_GENERATION_JOB_STATES: readonly GenerationJobState[] = [
  'succeeded',
  'failed',
  'cancelled',
];

export function isTerminalGenerationJobState(state: GenerationJobState): boolean {
  return TERMINAL_GENERATION_JOB_STATES.includes(state);
}

/**
 * Events the lifecycle recognises.
 *
 * Deliberately stated in product vocabulary rather than engine wire codes: the
 * 0/1/2 mapping of Requirement 5.3 lives in `services/generation/engine-status.ts`
 * next to the adapter types, so this module stays free of any engine detail.
 */
export type JobLifecycleEvent =
  /** Engine reports work in progress (status 0). */
  | { readonly kind: 'engine_running' }
  /** Engine reports completion (status 1). */
  | { readonly kind: 'engine_succeeded' }
  /** Engine reports failure (status 2), or its retries are spent (6.3). */
  | { readonly kind: 'engine_failed'; readonly failure: JobFailure }
  /** Requirement 6.5: the engine could not be reached at all. */
  | { readonly kind: 'engine_unreachable'; readonly detail: string }
  /** Requirement 5.7: the owner asked to cancel. */
  | { readonly kind: 'cancel_requested' }
  /** Requirement 5.8: the 900 s job budget elapsed. */
  | { readonly kind: 'timeout_elapsed' };

export interface JobLifecycle {
  readonly state: GenerationJobState;
  /** Non-null exactly when `state` is `failed`. */
  readonly failure: JobFailure | null;
}

export const initialJobLifecycle: JobLifecycle = { state: 'pending', failure: null };

/**
 * What the transition obliges its caller to do, exactly once.
 *
 * Every flag is false on a no-op transition, which is how replaying a poll or
 * racing two timeout sources stays harmless.
 */
export interface JobLifecycleEffects {
  /** Requirements 5.7, 5.8, 6.3: return the full debited amount. */
  readonly refundCredits: boolean;
  /** Requirement 5.6: create one Audio_Asset per result audio. */
  readonly publishResults: boolean;
  /** Requirement 6.3: record the failure event in the Audit_Log. */
  readonly auditFailure: boolean;
  /** Requirement 5.4: push the new state to the owner's open connections. */
  readonly notifyClients: boolean;
}

const NO_EFFECTS: JobLifecycleEffects = {
  refundCredits: false,
  publishResults: false,
  auditFailure: false,
  notifyClients: false,
};

export type JobLifecycleRejection =
  /** The job already reached a terminal state; the event is ignored. */
  | 'already_terminal'
  /** Requirement 5.7 permits cancelling a *pending* job only. */
  | 'cancel_after_start';

export interface JobLifecycleTransition {
  readonly lifecycle: JobLifecycle;
  readonly changed: boolean;
  readonly effects: JobLifecycleEffects;
  readonly rejection: JobLifecycleRejection | null;
}

/**
 * The state machine.
 *
 * Requirement 6.5 is the one event that intentionally changes nothing: a
 * connection failure is not evidence about the work, so the job stays in its
 * current non-terminal state and the caller resumes polling (see
 * `poll-schedule.ts`). Reporting `changed: false` is what keeps 6.5 distinct from
 * 6.1 — an unreachable engine is not a failed job.
 */
export function applyJobLifecycleEvent(
  current: JobLifecycle,
  event: JobLifecycleEvent,
): JobLifecycleTransition {
  if (isTerminalGenerationJobState(current.state)) {
    return unchanged(current, 'already_terminal');
  }

  switch (event.kind) {
    case 'engine_running':
      return current.state === 'running'
        ? unchanged(current, null)
        : moved({ state: 'running', failure: null }, { ...NO_EFFECTS, notifyClients: true });

    case 'engine_succeeded':
      return moved(
        { state: 'succeeded', failure: null },
        { ...NO_EFFECTS, publishResults: true, notifyClients: true },
      );

    case 'engine_failed':
      return moved({ state: 'failed', failure: event.failure }, terminalFailureEffects());

    case 'timeout_elapsed':
      return moved({ state: 'failed', failure: jobTimeoutFailure() }, terminalFailureEffects());

    case 'cancel_requested':
      return current.state === 'pending'
        ? moved(
            { state: 'cancelled', failure: null },
            { ...NO_EFFECTS, refundCredits: true, notifyClients: true },
          )
        : unchanged(current, 'cancel_after_start');

    case 'engine_unreachable':
      return unchanged(current, null);
  }
}

/** Requirements 5.8/6.3 both refund and audit; 5.4 pushes the change. */
function terminalFailureEffects(): JobLifecycleEffects {
  return { refundCredits: true, publishResults: false, auditFailure: true, notifyClients: true };
}

function moved(lifecycle: JobLifecycle, effects: JobLifecycleEffects): JobLifecycleTransition {
  return { lifecycle, changed: true, effects, rejection: null };
}

function unchanged(
  lifecycle: JobLifecycle,
  rejection: JobLifecycleRejection | null,
): JobLifecycleTransition {
  return { lifecycle, changed: false, effects: NO_EFFECTS, rejection };
}
