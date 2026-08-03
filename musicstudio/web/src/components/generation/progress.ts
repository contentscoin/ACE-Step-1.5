/**
 * What the progress display says, and when (Requirements 31.6, 31.7).
 *
 * Pure, and separate from the component that renders it, because both criteria are about *timing
 * and content* rather than about pixels:
 *
 * - **31.6** — the indicator appears within **300 ms** of the job entering waiting or running.
 * - **31.7** — a text label shows either a progress percentage (integer, 0–100) or a queue
 *   position (integer, ≥1), refreshed at **no more than 2-second** intervals.
 *
 * ### Percentage *or* queue position, never a guess at both
 *
 * A job that is queued has no progress — it has a place in a line — and showing "0%" for it is a
 * lie that gets worse the longer the queue is: the user watches a number that cannot move. So
 * `progressLabel` returns the queue position while the job waits and the percentage once it runs,
 * and it has no third branch that invents one from the other.
 *
 * The percentage is **floored, not rounded**. A job at 99.6% rounds to 100%, and a progress display
 * that says 100% while the work continues is the one number a user will remember as a lie.
 */

export const PROGRESS_INDICATOR_DEADLINE_MS = 300;
export const PROGRESS_TEXT_REFRESH_MAX_MS = 2_000;

/** The states Requirement 31.6 covers: 대기 or 진행. */
export type ProgressPhase = 'queued' | 'running';

export interface ProgressState {
  readonly phase: ProgressPhase;
  /** 0–100 while running. `null` until the engine reports one. */
  readonly percent: number | null;
  /** 1-based position while queued. `null` once running. */
  readonly queuePosition: number | null;
}

export type ProgressLabel =
  | { readonly kind: 'queue'; readonly position: number; readonly text: string }
  | { readonly kind: 'percent'; readonly percent: number; readonly text: string }
  /** The engine has reported nothing yet; the indicator shows, the number does not. */
  | { readonly kind: 'pending'; readonly text: string };

/** Requirement 31.7's text. */
export function progressLabel(state: ProgressState): ProgressLabel {
  if (state.phase === 'queued') {
    const position = state.queuePosition;
    if (position === null || !Number.isFinite(position) || position < 1) {
      return { kind: 'pending', text: '대기 중' };
    }
    const rounded = Math.max(1, Math.floor(position));
    return { kind: 'queue', position: rounded, text: `대기 순번 ${String(rounded)}` };
  }

  const percent = state.percent;
  if (percent === null || !Number.isFinite(percent)) {
    return { kind: 'pending', text: '생성 중' };
  }

  // Floored and clamped — see the header on why not rounded.
  const bounded = Math.max(0, Math.min(100, Math.floor(percent)));
  return { kind: 'percent', percent: bounded, text: `${String(bounded)}%` };
}

/** Requirement 31.6 — has the indicator appeared in time? */
export function indicatorShownInTime(enteredAtMs: number, shownAtMs: number): boolean {
  return shownAtMs - enteredAtMs <= PROGRESS_INDICATOR_DEADLINE_MS;
}

/** Requirement 31.7 — is a refresh cadence inside the permitted interval? */
export function refreshIntervalAcceptable(intervalMs: number): boolean {
  return intervalMs > 0 && intervalMs <= PROGRESS_TEXT_REFRESH_MAX_MS;
}

/**
 * The interval the UI polls at.
 *
 * One second, which is half the ceiling. Sitting exactly on 2000 ms would make the criterion hold
 * only if every timer fired on time, and no timer does — a late frame under load would put the
 * refresh past the bound the product advertises.
 */
export const PROGRESS_TEXT_REFRESH_MS = 1_000;
