import { describe, expect, it } from 'vitest';

import {
  PROGRESS_INDICATOR_DEADLINE_MS,
  PROGRESS_TEXT_REFRESH_MAX_MS,
  PROGRESS_TEXT_REFRESH_MS,
  indicatorShownInTime,
  progressLabel,
  refreshIntervalAcceptable,
} from '../../src/components/generation/progress';

/**
 * The progress display.
 *
 * **Validates: Requirements 31.6, 31.7**
 *
 * The interesting assertions are the two the criterion does *not* spell out and a naive
 * implementation gets wrong: a queued job is not "0%", and 99.6% is not "100%".
 */

describe('Requirement 31.7 — the text', () => {
  it('shows the queue position while the job waits', () => {
    expect(progressLabel({ phase: 'queued', percent: null, queuePosition: 3 })).toEqual({
      kind: 'queue',
      position: 3,
      text: '대기 순번 3',
    });
  });

  it('never renders a queued job as 0%', () => {
    // The number a user would watch not move. A queued job has a place in a line, not progress.
    const label = progressLabel({ phase: 'queued', percent: 0, queuePosition: 5 });
    expect(label.kind).toBe('queue');
    expect(label.text).not.toContain('%');
  });

  it('shows the percentage once it runs', () => {
    expect(progressLabel({ phase: 'running', percent: 42, queuePosition: null })).toEqual({
      kind: 'percent',
      percent: 42,
      text: '42%',
    });
  });

  it('floors rather than rounds, so 100% means finished', () => {
    expect(progressLabel({ phase: 'running', percent: 99.6, queuePosition: null }).text).toBe('99%');
    expect(progressLabel({ phase: 'running', percent: 100, queuePosition: null }).text).toBe('100%');
  });

  it('clamps a percentage outside the published range', () => {
    expect(progressLabel({ phase: 'running', percent: -5, queuePosition: null }).text).toBe('0%');
    expect(progressLabel({ phase: 'running', percent: 140, queuePosition: null }).text).toBe('100%');
  });

  it('reports an integer, as the criterion requires', () => {
    for (const percent of [0, 0.4, 33.333, 99.999, 100]) {
      const label = progressLabel({ phase: 'running', percent, queuePosition: null });
      if (label.kind !== 'percent') throw new Error('expected a percentage');
      expect(Number.isInteger(label.percent)).toBe(true);
    }
  });

  it('says something honest before the engine has reported anything', () => {
    expect(progressLabel({ phase: 'running', percent: null, queuePosition: null }).kind).toBe(
      'pending',
    );
    expect(progressLabel({ phase: 'queued', percent: null, queuePosition: null }).kind).toBe(
      'pending',
    );
  });

  it('refuses a queue position below one', () => {
    // 31.7 says 1 이상; a zeroth place in a queue is not a thing.
    expect(progressLabel({ phase: 'queued', percent: null, queuePosition: 0 }).kind).toBe('pending');
  });
});

describe('Requirement 31.6 — the indicator appears within 300 ms', () => {
  it('accepts a display inside the deadline, including on it', () => {
    expect(indicatorShownInTime(1_000, 1_000)).toBe(true);
    expect(indicatorShownInTime(1_000, 1_000 + PROGRESS_INDICATOR_DEADLINE_MS)).toBe(true);
  });

  it('refuses one past it', () => {
    expect(indicatorShownInTime(1_000, 1_000 + PROGRESS_INDICATOR_DEADLINE_MS + 1)).toBe(false);
  });
});

describe('Requirement 31.7 — the refresh cadence', () => {
  it('polls at half the ceiling, so a late frame does not breach it', () => {
    expect(PROGRESS_TEXT_REFRESH_MS).toBeLessThan(PROGRESS_TEXT_REFRESH_MAX_MS);
    expect(refreshIntervalAcceptable(PROGRESS_TEXT_REFRESH_MS)).toBe(true);
  });

  it('accepts the ceiling and refuses past it', () => {
    expect(refreshIntervalAcceptable(PROGRESS_TEXT_REFRESH_MAX_MS)).toBe(true);
    expect(refreshIntervalAcceptable(PROGRESS_TEXT_REFRESH_MAX_MS + 1)).toBe(false);
    expect(refreshIntervalAcceptable(0)).toBe(false);
  });
});
