import { describe, expect, it } from 'vitest';

import {
  classifyEngineFailure,
  isRetryableFailureClass,
  jobFailure,
  JOB_FAILURE_CLASSES,
  retriesExhaustedFailure,
} from '../../../domain/generation-job/failure';
import {
  applyJobLifecycleEvent,
  GENERATION_JOB_STATES,
  initialJobLifecycle,
  isTerminalGenerationJobState,
  type JobLifecycle,
  type JobLifecycleEvent,
} from '../../../domain/generation-job/lifecycle';
import {
  estimateCompletion,
} from '../../../domain/generation-job/eta';
import {
  isWithinPollInterval,
  isWithinResumeBound,
  nextPollDelayMs,
  POLL_INTERVAL_MS,
  RESUME_POLL_MAX_DELAY_MS,
} from '../../../domain/generation-job/poll-schedule';
import { USER_VISIBLE_STATE_FOR_ENGINE_STATE } from '../../../services/generation/engine-status';
import { ENGINE_JOB_STATE } from '../../../adapters/engine-job';

/**
 * The pure half of Requirements 5 and 6: the lifecycle state machine and the
 * arithmetic around it. No clock, no ports, no HTTP.
 */

const running: JobLifecycle = { state: 'running', failure: null };

describe('Requirement 5.3 — engine status codes map to user-visible states', () => {
  it('maps 0 to running, 1 to succeeded and 2 to failed', () => {
    expect(USER_VISIBLE_STATE_FOR_ENGINE_STATE[ENGINE_JOB_STATE.running]).toBe('running');
    expect(USER_VISIBLE_STATE_FOR_ENGINE_STATE[ENGINE_JOB_STATE.succeeded]).toBe('succeeded');
    expect(USER_VISIBLE_STATE_FOR_ENGINE_STATE[ENGINE_JOB_STATE.failed]).toBe('failed');
  });

  it('never exposes a numeric engine code as a job state', () => {
    for (const state of GENERATION_JOB_STATES) {
      expect(Number.isNaN(Number(state))).toBe(true);
    }
  });
});

describe('job lifecycle transitions', () => {
  it('starts pending and moves to running on the first progress report', () => {
    expect(initialJobLifecycle.state).toBe('pending');

    const transition = applyJobLifecycleEvent(initialJobLifecycle, { kind: 'engine_running' });

    expect(transition.lifecycle.state).toBe('running');
    expect(transition.changed).toBe(true);
    expect(transition.effects.notifyClients).toBe(true);
  });

  it('reports no change when a running job is reported running again', () => {
    const transition = applyJobLifecycleEvent(running, { kind: 'engine_running' });

    expect(transition.changed).toBe(false);
    // Requirement 5.4 pushes on a *change*; a repeated poll must not emit.
    expect(transition.effects.notifyClients).toBe(false);
  });

  it('Requirement 5.6 — success obliges the caller to publish the results', () => {
    const transition = applyJobLifecycleEvent(running, { kind: 'engine_succeeded' });

    expect(transition.lifecycle.state).toBe('succeeded');
    expect(transition.effects.publishResults).toBe(true);
    expect(transition.effects.refundCredits).toBe(false);
  });

  it('Requirement 6.3 — a failure obliges a refund and an audit entry', () => {
    const failure = jobFailure('engine_error', 'retries_exhausted');

    const transition = applyJobLifecycleEvent(running, { kind: 'engine_failed', failure });

    expect(transition.lifecycle).toEqual({ state: 'failed', failure });
    expect(transition.effects.refundCredits).toBe(true);
    expect(transition.effects.auditFailure).toBe(true);
  });

  it('Requirement 5.7 — cancelling a pending job refunds it', () => {
    const transition = applyJobLifecycleEvent(initialJobLifecycle, { kind: 'cancel_requested' });

    expect(transition.lifecycle.state).toBe('cancelled');
    expect(transition.effects.refundCredits).toBe(true);
    expect(transition.rejection).toBeNull();
  });

  it('Requirement 5.7 — cancelling a job that already started is refused', () => {
    const transition = applyJobLifecycleEvent(running, { kind: 'cancel_requested' });

    expect(transition.rejection).toBe('cancel_after_start');
    expect(transition.lifecycle).toEqual(running);
    expect(transition.effects.refundCredits).toBe(false);
  });

  it('Requirement 5.8 — the timeout event fails the job and refunds it', () => {
    const transition = applyJobLifecycleEvent(running, { kind: 'timeout_elapsed' });

    expect(transition.lifecycle.state).toBe('failed');
    expect(transition.lifecycle.failure?.reason).toBe('job_timeout');
    expect(transition.effects.refundCredits).toBe(true);
    expect(transition.effects.auditFailure).toBe(true);
  });

  it('Requirement 6.5 — an unreachable engine leaves the job pending and unchanged', () => {
    const transition = applyJobLifecycleEvent(initialJobLifecycle, {
      kind: 'engine_unreachable',
      detail: 'ECONNREFUSED',
    });

    expect(transition.lifecycle).toEqual(initialJobLifecycle);
    expect(transition.changed).toBe(false);
    expect(transition.rejection).toBeNull();
    expect(transition.effects).toEqual({
      refundCredits: false,
      publishResults: false,
      auditFailure: false,
      notifyClients: false,
    });
  });

  it('absorbs every event once terminal, so no effect can fire twice', () => {
    const terminals = GENERATION_JOB_STATES.filter(isTerminalGenerationJobState);
    const events: JobLifecycleEvent[] = [
      { kind: 'engine_running' },
      { kind: 'engine_succeeded' },
      { kind: 'engine_failed', failure: jobFailure('engine_error', 'engine_reported_failure') },
      { kind: 'timeout_elapsed' },
      { kind: 'cancel_requested' },
      { kind: 'engine_unreachable', detail: 'gone' },
    ];

    for (const state of terminals) {
      for (const event of events) {
        const transition = applyJobLifecycleEvent({ state, failure: null }, event);

        expect(transition.rejection).toBe('already_terminal');
        expect(transition.changed).toBe(false);
        expect(transition.effects.refundCredits).toBe(false);
        expect(transition.lifecycle.state).toBe(state);
      }
    }
  });
});

describe('Requirement 6.1 — failure classification and retryability', () => {
  it('names one of the three classes for every signal', () => {
    const signals = [
      { httpStatus: 400 },
      { httpStatus: 429 },
      { httpStatus: 503 },
      { reason: 'lyrics field invalid' },
      { reason: 'worker out of memory' },
      { reason: 'unexpected engine condition' },
      {},
    ];

    for (const signal of signals) {
      expect(JOB_FAILURE_CLASSES).toContain(classifyEngineFailure(signal).classification);
    }
  });

  it('classifies 429 as resource exhaustion rather than an input error', () => {
    // Requirement 6.2 retries a 429; retrying an input error would be incoherent.
    expect(classifyEngineFailure({ httpStatus: 429 }).classification).toBe('resource_exhaustion');
    expect(classifyEngineFailure({ httpStatus: 429 }).retryable).toBe(true);
  });

  it('classifies other 4xx as input errors and marks them not retryable', () => {
    const failure = classifyEngineFailure({ httpStatus: 422 });

    expect(failure.classification).toBe('input_error');
    expect(failure.retryable).toBe(false);
  });

  it('classifies 5xx and unrecognised text as engine errors', () => {
    expect(classifyEngineFailure({ httpStatus: 500 }).classification).toBe('engine_error');
    expect(classifyEngineFailure({ reason: 'something odd' }).classification).toBe('engine_error');
  });

  it('derives retryability from the class rather than storing it separately', () => {
    for (const classification of JOB_FAILURE_CLASSES) {
      expect(jobFailure(classification, 'engine_reported_failure').retryable).toBe(
        isRetryableFailureClass(classification),
      );
    }
  });

  it('Requirement 6.3 — exhausting the retries keeps the original class', () => {
    const last = classifyEngineFailure({ httpStatus: 429 });
    const exhausted = retriesExhaustedFailure(last);

    expect(exhausted.reason).toBe('retries_exhausted');
    expect(exhausted.classification).toBe('resource_exhaustion');
  });
});

describe('Requirement 5.2 / 6.5 — poll cadence', () => {
  it('polls at 5 seconds or less while the engine is answering', () => {
    expect(nextPollDelayMs(0)).toBe(POLL_INTERVAL_MS);
    expect(isWithinPollInterval(nextPollDelayMs(0))).toBe(true);
  });

  it('backs off after contact failures but always resumes within 60 seconds', () => {
    for (let streak = 1; streak <= 12; streak += 1) {
      const delay = nextPollDelayMs(streak);

      expect(delay).toBeGreaterThan(POLL_INTERVAL_MS);
      expect(isWithinResumeBound(delay)).toBe(true);
    }

    expect(nextPollDelayMs(99)).toBe(RESUME_POLL_MAX_DELAY_MS);
  });
});

describe('Requirement 5.5 — expected completion from position and engine average', () => {
  it('makes the next job finish one average duration from now', () => {
    const estimate = estimateCompletion({ queuePosition: 1, averageDurationMs: 30_000, nowMs: 1_000 });

    expect(estimate?.queueWaitMs).toBe(0);
    expect(estimate?.estimatedCompletionAtMs).toBe(31_000);
  });

  it('adds one average duration per job ahead in the queue', () => {
    const estimate = estimateCompletion({ queuePosition: 4, averageDurationMs: 10_000, nowMs: 0 });

    expect(estimate?.queueWaitMs).toBe(30_000);
    expect(estimate?.estimatedCompletionAtMs).toBe(40_000);
    expect(estimate?.basis).toEqual({ queuePosition: 4, averageDurationMs: 10_000 });
  });

  it('offers no estimate when the engine has reported no average', () => {
    expect(estimateCompletion({ queuePosition: 1, averageDurationMs: 0, nowMs: 0 })).toBeNull();
  });
});
