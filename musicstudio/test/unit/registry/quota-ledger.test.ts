import { describe, expect, it } from 'vitest';

import {
  createQuotaLedger,
  nextQuotaResetAtMs,
  utcDayStartMs,
} from '../../../adapters/registry/quota-ledger';
import { createMutableClock } from '../../support/mutable-clock';

/** Requirement 20.12 (counters and the 00:00 UTC reset) and 20.13 (insufficiency). */
describe('daily engine quota ledger (Req 20.12, 20.13)', () => {
  const limits = { maxRequests: 3, maxGpuSeconds: 10 };

  it('computes the UTC day boundary and the next reset instant', () => {
    const noon = Date.parse('2025-03-01T12:34:56.789Z');

    expect(utcDayStartMs(noon)).toBe(Date.parse('2025-03-01T00:00:00.000Z'));
    expect(nextQuotaResetAtMs(noon)).toBe(Date.parse('2025-03-02T00:00:00.000Z'));
    // Exactly at midnight the next reset is a full day later, not immediate.
    expect(nextQuotaResetAtMs(Date.parse('2025-03-01T00:00:00.000Z'))).toBe(
      Date.parse('2025-03-02T00:00:00.000Z'),
    );
  });

  it('accumulates both counters', () => {
    const clock = createMutableClock(new Date('2025-03-01T10:00:00.000Z'));
    const ledger = createQuotaLedger(clock);

    ledger.consume('engine-a', { requests: 1, gpuSeconds: 4 });
    ledger.consume('engine-a', { requests: 1, gpuSeconds: 3 });

    expect(ledger.usage('engine-a')).toMatchObject({ requests: 2, gpuSeconds: 7 });
    // Counters are per engine.
    expect(ledger.usage('engine-b')).toMatchObject({ requests: 0, gpuSeconds: 0 });
  });

  it('reports which counter is exhausted and when it resets (Req 20.13)', () => {
    const clock = createMutableClock(new Date('2025-03-01T22:00:00.000Z'));
    const ledger = createQuotaLedger(clock);

    ledger.consume('engine-a', { requests: 3, gpuSeconds: 2 });
    const check = ledger.check('engine-a', limits, { requests: 1, gpuSeconds: 1 });

    expect(check.sufficient).toBe(false);
    if (check.sufficient) throw new Error('unreachable');
    expect(check.exhausted).toEqual(['requests']);
    expect(check.nextResetAtMs).toBe(Date.parse('2025-03-02T00:00:00.000Z'));
    expect(check.remaining).toEqual({ requests: 0, gpuSeconds: 8 });
  });

  it('reports both counters when both are short', () => {
    const clock = createMutableClock(new Date('2025-03-01T22:00:00.000Z'));
    const ledger = createQuotaLedger(clock);

    ledger.consume('engine-a', { requests: 3, gpuSeconds: 10 });
    const check = ledger.check('engine-a', limits, { requests: 1, gpuSeconds: 1 });

    if (check.sufficient) throw new Error('unreachable');
    expect(check.exhausted).toEqual(['requests', 'gpuSeconds']);
  });

  it('permits a request that exactly consumes the remaining quota', () => {
    const clock = createMutableClock(new Date('2025-03-01T10:00:00.000Z'));
    const ledger = createQuotaLedger(clock);

    ledger.consume('engine-a', { requests: 2, gpuSeconds: 9 });

    expect(ledger.check('engine-a', limits, { requests: 1, gpuSeconds: 1 }).sufficient).toBe(true);
    expect(ledger.check('engine-a', limits, { requests: 2, gpuSeconds: 1 }).sufficient).toBe(false);
  });

  it('resets both counters at 00:00 UTC (Req 20.12)', () => {
    const clock = createMutableClock(new Date('2025-03-01T23:59:59.000Z'));
    const ledger = createQuotaLedger(clock);

    ledger.consume('engine-a', { requests: 3, gpuSeconds: 10 });
    expect(ledger.check('engine-a', limits, { requests: 1, gpuSeconds: 1 }).sufficient).toBe(false);

    // One second later it is the next UTC day.
    clock.advanceSeconds(1);

    expect(ledger.usage('engine-a')).toMatchObject({ requests: 0, gpuSeconds: 0 });
    expect(ledger.check('engine-a', limits, { requests: 1, gpuSeconds: 1 }).sufficient).toBe(true);
  });

  it('does not reset on a local-time boundary that is not 00:00 UTC', () => {
    // 15:00 UTC on 1 March is midnight in UTC+9; usage must survive it.
    const clock = createMutableClock(new Date('2025-03-01T14:59:59.000Z'));
    const ledger = createQuotaLedger(clock);

    ledger.consume('engine-a', { requests: 2, gpuSeconds: 1 });
    clock.advanceSeconds(2);

    expect(ledger.usage('engine-a').requests).toBe(2);
  });
});
