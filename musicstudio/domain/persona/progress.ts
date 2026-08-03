/**
 * Requirement 15.3 — "현재 학습 단계와 진행률".
 *
 * Two values, and the second is the hard one. The engine's `/v1/training/status` reports
 * `current_step`, `current_epoch`, a loss history and an `estimated_time_remaining`, but no
 * fraction; a percentage has to be derived, and every way of deriving one is wrong in some
 * regime. This module picks **completed steps over planned steps** and states why:
 *
 * - *Loss* is not progress. It falls unevenly, plateaus, and a run that has converged early
 *   is not 90% done — it has 90% of its steps left to run.
 * - *Elapsed over estimated remaining* moves backwards when the estimate rises, and a
 *   progress bar that goes back is worse than no bar.
 * - *Steps* is monotonic, bounded, and known in advance from epochs × steps-per-epoch.
 *
 * The fraction is therefore honest about what it measures and nothing more. When the step
 * total is not yet known — the engine has not begun — progress is `null` rather than 0,
 * because "0%" and "not started" are different things to whoever is watching.
 */

import { type PersonaStatus } from './persona';

/** The stage names a client shows. Mapped from the engine's state by the service. */
export const TRAINING_STAGES = [
  /** Waiting for the single-tenant engine to be free. See `persona.ts`. */
  'queued',
  /** The engine is preparing the reference audio into training tensors. */
  'preprocessing',
  'training',
  /** Weights are being written out and registered as an adapter (15.4). */
  'exporting',
  'completed',
  'failed',
] as const;

export type TrainingStage = (typeof TRAINING_STAGES)[number];

export function isTrainingStage(value: unknown): value is TrainingStage {
  return typeof value === 'string' && (TRAINING_STAGES as readonly string[]).includes(value);
}

export interface TrainingProgress {
  readonly stage: TrainingStage;
  /** `[0, 1]`, or `null` when the total is not yet known. See the header. */
  readonly fraction: number | null;
  readonly currentStep: number | null;
  readonly totalSteps: number | null;
  /** How many personas are ahead in the queue. `0` once this one is running. */
  readonly queuePosition: number;
  /** The engine's own estimate, carried through unjudged. */
  readonly estimatedSecondsRemaining: number | null;
}

/**
 * Derive the fraction, clamped.
 *
 * Clamped rather than trusted: an engine reporting a step past its own total (a resumed run,
 * an extra epoch) would otherwise produce a progress bar past 100%, and a client that draws
 * a width from it would overflow its container.
 */
export function progressFraction(
  currentStep: number | null,
  totalSteps: number | null,
): number | null {
  if (currentStep === null || totalSteps === null || totalSteps <= 0) return null;
  return Math.max(0, Math.min(1, currentStep / totalSteps));
}

/** The stage a persona's stored status implies, before the engine has been asked. */
export function stageForStatus(status: PersonaStatus): TrainingStage {
  switch (status) {
    case 'queued':
      return 'queued';
    case 'training':
      return 'training';
    case 'ready':
      return 'completed';
    case 'failed':
    case 'deleted':
      return 'failed';
  }
}
