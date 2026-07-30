import { describe, expect, it } from 'vitest';

import {
  HEALTH_HISTORY_MIN_ENTRIES,
  HEALTH_HISTORY_RETENTION_MS,
  createHealthHistory,
  recordsWithinRetentionWindow,
  type HealthCheckRecord,
} from '../../../adapters/registry/health-history';

/** Requirement 20.7 retention: at least 100 records and at least 24 hours of them. */
describe('health check history retention (Req 20.7)', () => {
  const record = (checkedAtMs: number, outcome: 'success' | 'failure' = 'success'): HealthCheckRecord => ({
    checkedAtMs,
    outcome,
    latencyMs: 10,
  });

  it('keeps the check time in milliseconds and the outcome of each check', () => {
    const history = createHealthHistory()
      .append(record(1_700_000_000_123, 'success'))
      .append(record(1_700_000_060_456, 'failure'));

    expect(history.records.map((entry) => [entry.checkedAtMs, entry.outcome])).toEqual([
      [1_700_000_000_123, 'success'],
      [1_700_000_060_456, 'failure'],
    ]);
    expect(history.latest?.outcome).toBe('failure');
  });

  it('retains at least 100 records even when all are older than 24 hours', () => {
    // 150 checks a week apart: every one is outside the retention window.
    let history = createHealthHistory();
    const weekMs = 7 * 24 * 60 * 60 * 1_000;
    for (let i = 0; i < 150; i += 1) {
      history = history.append(record(i * weekMs));
    }

    expect(history.records.length).toBe(HEALTH_HISTORY_MIN_ENTRIES);
    // The retained ones are the newest.
    expect(history.records[0]?.checkedAtMs).toBe(50 * weekMs);
  });

  it('retains a full 24 hours of checks even when that is far more than 100', () => {
    // 24 hours at the 60 s cadence is 1440 checks; none may be dropped.
    let history = createHealthHistory();
    const startMs = Date.parse('2025-03-01T00:00:00.000Z');
    for (let i = 0; i < 1_440; i += 1) {
      history = history.append(record(startMs + i * 60_000));
    }
    const nowMs = startMs + 1_439 * 60_000;

    expect(history.records.length).toBe(1_440);
    expect(recordsWithinRetentionWindow(history, nowMs).length).toBe(1_440);
  });

  it('drops a record only once it is both outside the newest 100 and older than 24 hours', () => {
    let history = createHealthHistory();
    const startMs = Date.parse('2025-03-01T00:00:00.000Z');
    const stepMs = 30 * 60_000;
    // 200 checks 30 minutes apart span 99.5 hours, and only 48 of them fall
    // inside the 24-hour window — fewer than the 100-record floor.
    for (let i = 0; i < 200; i += 1) {
      history = history.append(record(startMs + i * stepMs));
    }
    const nowMs = startMs + 199 * stepMs;
    const cutoffMs = nowMs - HEALTH_HISTORY_RETENTION_MS;

    // The 100-record floor wins here, so records older than 24 hours are kept.
    expect(history.records.length).toBe(HEALTH_HISTORY_MIN_ENTRIES);
    expect(history.records[0]?.checkedAtMs).toBe(startMs + 100 * stepMs);
    // Nothing inside the retention window was dropped: 20.7's two floors hold
    // together, and a record only leaves once it fails both.
    // 24 hours at a 30-minute cadence is 48 intervals, so 49 records including
    // the one exactly on the cutoff.
    expect(recordsWithinRetentionWindow(history, nowMs).length).toBe(49);
    const dropped = startMs + 99 * stepMs;
    expect(dropped).toBeLessThan(cutoffMs);
    expect(history.records.some((entry) => entry.checkedAtMs === dropped)).toBe(false);
  });

  it('keeps records ordered oldest first regardless of append order', () => {
    const history = createHealthHistory([record(300), record(100), record(200)]);
    expect(history.records.map((entry) => entry.checkedAtMs)).toEqual([100, 200, 300]);
  });
});
