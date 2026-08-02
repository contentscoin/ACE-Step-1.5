import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { estimateCompletion } from '../../domain/generation-job/eta';
import { jobFailure, JOB_FAILURE_CLASSES } from '../../domain/generation-job/failure';
import {
  applyJobLifecycleEvent,
  initialJobLifecycle,
  isTerminalGenerationJobState,
  type JobLifecycle,
  type JobLifecycleEvent,
} from '../../domain/generation-job/lifecycle';
import {
  isWithinResumeBound,
  nextPollDelayMs,
  POLL_INTERVAL_MS,
} from '../../domain/generation-job/poll-schedule';
import {
  MAX_ENGINE_RETRY_ATTEMPTS,
  respectsMinimumRetryGap,
  retryDelayMs,
} from '../../domain/generation-job/retry-policy';

/**
 * Local invariants of the job lifecycle (task 1.5). These are *not* the numbered
 * correctness properties of design §10, which cover parsers, mixdown, loudness and
 * licensing; they pin the Requirement 5 and 6 rules whose correctness is a claim
 * about *all* event orderings rather than about a handful of examples.
 *
 * The refund invariant is the one that matters most. Requirements 5.7, 5.8 and 6.3
 * each refund, and three separate code paths can trigger them, so "the credits come
 * back exactly once" has to hold for every interleaving — including a cancel racing
 * a timeout racing a late engine poll.
 */

const NUM_RUNS = 100;

const failureArbitrary = fc
  .constantFrom(...JOB_FAILURE_CLASSES)
  .map((classification) => jobFailure(classification, 'engine_reported_failure'));

const eventArbitrary: fc.Arbitrary<JobLifecycleEvent> = fc.oneof(
  fc.constant<JobLifecycleEvent>({ kind: 'engine_running' }),
  fc.constant<JobLifecycleEvent>({ kind: 'engine_succeeded' }),
  failureArbitrary.map<JobLifecycleEvent>((failure) => ({ kind: 'engine_failed', failure })),
  fc.constant<JobLifecycleEvent>({ kind: 'cancel_requested' }),
  fc.constant<JobLifecycleEvent>({ kind: 'timeout_elapsed' }),
  fc
    .string({ minLength: 1, maxLength: 20 })
    .map<JobLifecycleEvent>((detail) => ({ kind: 'engine_unreachable', detail })),
);

interface FoldTally {
  readonly lifecycle: JobLifecycle;
  readonly refunds: number;
  readonly publications: number;
  readonly audits: number;
  readonly notifications: number;
}

function fold(events: readonly JobLifecycleEvent[]): FoldTally {
  return events.reduce<FoldTally>(
    (tally, event) => {
      const transition = applyJobLifecycleEvent(tally.lifecycle, event);
      return {
        lifecycle: transition.lifecycle,
        refunds: tally.refunds + (transition.effects.refundCredits ? 1 : 0),
        publications: tally.publications + (transition.effects.publishResults ? 1 : 0),
        audits: tally.audits + (transition.effects.auditFailure ? 1 : 0),
        notifications: tally.notifications + (transition.effects.notifyClients ? 1 : 0),
      };
    },
    { lifecycle: initialJobLifecycle, refunds: 0, publications: 0, audits: 0, notifications: 0 },
  );
}

describe('a job owes at most one refund, whatever happens to it', () => {
  it('never obliges a second refund for any event sequence (Requirements 5.7, 5.8, 6.3)', () => {
    fc.assert(
      fc.property(fc.array(eventArbitrary, { maxLength: 12 }), (events) => {
        const tally = fold(events);

        expect(tally.refunds).toBeLessThanOrEqual(1);
        expect(tally.publications).toBeLessThanOrEqual(1);
        expect(tally.audits).toBeLessThanOrEqual(1);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('refunds exactly when the job ends failed or cancelled', () => {
    fc.assert(
      fc.property(fc.array(eventArbitrary, { maxLength: 12 }), (events) => {
        const tally = fold(events);
        const refundOwed = tally.lifecycle.state === 'failed' || tally.lifecycle.state === 'cancelled';

        expect(tally.refunds).toBe(refundOwed ? 1 : 0);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('publishes results exactly when the job ends succeeded (Requirement 5.6)', () => {
    fc.assert(
      fc.property(fc.array(eventArbitrary, { maxLength: 12 }), (events) => {
        const tally = fold(events);

        expect(tally.publications).toBe(tally.lifecycle.state === 'succeeded' ? 1 : 0);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('changes nothing after the first terminal state', () => {
    fc.assert(
      fc.property(fc.array(eventArbitrary, { minLength: 1, maxLength: 12 }), (events) => {
        let lifecycle = initialJobLifecycle;
        let frozen: JobLifecycle | null = null;

        for (const event of events) {
          const transition = applyJobLifecycleEvent(lifecycle, event);
          if (frozen !== null) expect(transition.lifecycle).toEqual(frozen);
          lifecycle = transition.lifecycle;
          if (frozen === null && isTerminalGenerationJobState(lifecycle.state)) frozen = lifecycle;
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('keeps a failure attached to the failed state and to no other', () => {
    fc.assert(
      fc.property(fc.array(eventArbitrary, { maxLength: 12 }), (events) => {
        const { lifecycle } = fold(events);

        expect(lifecycle.failure === null).toBe(lifecycle.state !== 'failed');
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('delay bounds hold for every input', () => {
  it('keeps every retry gap at two seconds or more (Requirement 6.2)', () => {
    fc.assert(
      fc.property(fc.integer({ min: -50, max: 50 }), (attempt) => {
        expect(respectsMinimumRetryGap(retryDelayMs(attempt))).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('grows the retry delay monotonically across the permitted attempts', () => {
    for (let attempt = 2; attempt <= MAX_ENGINE_RETRY_ATTEMPTS; attempt += 1) {
      expect(retryDelayMs(attempt)).toBeGreaterThan(retryDelayMs(attempt - 1));
    }
  });

  it('resumes polling within sixty seconds however long the outage (Requirement 6.5)', () => {
    fc.assert(
      fc.property(fc.integer({ min: -10, max: 10_000 }), (streak) => {
        const delay = nextPollDelayMs(streak);

        expect(delay).toBeGreaterThanOrEqual(POLL_INTERVAL_MS);
        expect(isWithinResumeBound(delay)).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('the expected completion time is monotone in queue position (Requirement 5.5)', () => {
  it('never predicts an earlier finish for a job further back', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 500 }),
        fc.integer({ min: 1, max: 200 }),
        fc.integer({ min: 1_000, max: 600_000 }),
        fc.integer({ min: 0, max: 2_000_000_000 }),
        (position, step, averageDurationMs, nowMs) => {
          const earlier = estimateCompletion({ queuePosition: position, averageDurationMs, nowMs });
          const later = estimateCompletion({
            queuePosition: position + step,
            averageDurationMs,
            nowMs,
          });

          expect(later?.estimatedCompletionAtMs).toBeGreaterThan(
            earlier?.estimatedCompletionAtMs ?? 0,
          );
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
