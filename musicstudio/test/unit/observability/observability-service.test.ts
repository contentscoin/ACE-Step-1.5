import { describe, expect, it } from 'vitest';

import { ALERT_RENOTIFY_MS, createObservabilityService } from '../../../services/observability/observability-service';
import type { MetricsSnapshot } from '../../../domain/observability/alerts';
import type { JobLogRecord } from '../../../domain/observability/job-log';
import { createMutableClock } from '../../support/mutable-clock';

/**
 * Observability_Service.
 *
 * **Validates: Requirements 18.3, 18.5, 18.8**
 *
 * The domain decides *which* conditions hold. What is checked here is the part that is about
 * time and repetition: a condition that stays true is announced once and then re-announced only
 * after the stated interval, and a condition that clears is forgotten so its return is news
 * again.
 */

const QUIET: MetricsSnapshot = {
  queue: { queueDepth: 0, queueCapacity: 100 },
  overallWindow: { total: 100, failed: 0 },
  engines: [],
  thresholds: [],
};

const BUSY: MetricsSnapshot = { ...QUIET, queue: { queueDepth: 85, queueCapacity: 100 } };

function build(initial: MetricsSnapshot = QUIET) {
  let snapshot = initial;
  const sent: string[] = [];
  const emitted: JobLogRecord[] = [];
  const clock = createMutableClock(new Date(1_700_000_000_000));

  const service = createObservabilityService({
    metrics: { snapshot: async () => snapshot },
    alerts: { send: async (alert) => void sent.push(alert.message) },
    logs: { emit: (record) => void emitted.push(record) },
    clock,
  });

  return {
    service,
    sent,
    emitted,
    clock,
    set(next: MetricsSnapshot) {
      snapshot = next;
    },
  };
}

describe('alert notification (Req 18.3)', () => {
  it('sends when a condition becomes true', async () => {
    const { service, sent } = build(BUSY);
    const outcome = await service.evaluate();

    expect(outcome.firing.map((alert) => alert.kind)).toEqual(['queue_utilisation']);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('큐 사용률');
  });

  it('does not repeat while the condition simply persists', async () => {
    const { service, sent, clock } = build(BUSY);

    await service.evaluate();
    clock.advanceSeconds(60);
    await service.evaluate();
    clock.advanceSeconds(60);
    const third = await service.evaluate();

    // Still firing every time; announced once. Sixty identical messages produce a filter rule.
    expect(third.firing).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(third.sent).toEqual([]);
  });

  it('does not treat a changed observed value as a new condition', async () => {
    const { service, sent, set } = build(BUSY);

    await service.evaluate();
    // 85% then 91% — the same ongoing problem, not two.
    set({ ...QUIET, queue: { queueDepth: 91, queueCapacity: 100 } });
    await service.evaluate();

    expect(sent).toHaveLength(1);
  });

  it('re-announces a condition that has outlived the interval', async () => {
    const { service, sent, clock } = build(BUSY);

    await service.evaluate();
    clock.advanceSeconds(ALERT_RENOTIFY_MS / 1000 - 1);
    await service.evaluate();
    expect(sent).toHaveLength(1);

    clock.advanceSeconds(1);
    await service.evaluate();
    // A condition surviving a shift change should be seen by the next person.
    expect(sent).toHaveLength(2);
  });

  it('forgets a cleared condition, so its return is news again', async () => {
    const { service, sent, set, clock } = build(BUSY);

    await service.evaluate();
    set(QUIET);
    const cleared = await service.evaluate();
    // The key's separator is U+0000 — see `alertKey`'s comment on why not a space or a hyphen.
    expect(cleared.cleared).toEqual(['queue_utilisation\u0000']);
    expect(service.activeAlertKeys()).toEqual([]);

    set(BUSY);
    clock.advanceSeconds(1);
    await service.evaluate();
    // Immediately, without waiting out the re-notify interval — it is a new incident.
    expect(sent).toHaveLength(2);
  });

  it('tracks engines independently', async () => {
    const { service, sent, set } = build({
      ...QUIET,
      engines: [
        {
          engineId: 'alpha',
          window: { total: 100, failed: 40 },
          dailyQuota: 1_000,
          quotaRemaining: 1_000,
          meanLatencyMs: null,
        },
      ],
    });

    await service.evaluate();
    expect(sent).toHaveLength(1);

    set({
      ...QUIET,
      engines: [
        {
          engineId: 'alpha',
          window: { total: 100, failed: 40 },
          dailyQuota: 1_000,
          quotaRemaining: 1_000,
          meanLatencyMs: null,
        },
        {
          engineId: 'beta',
          window: { total: 100, failed: 40 },
          dailyQuota: 1_000,
          quotaRemaining: 1_000,
          meanLatencyMs: null,
        },
      ],
    });
    await service.evaluate();

    // Beta is new; alpha is not. A key that ignored the subject would have sent nothing.
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain('beta');
  });
});

describe('job logging (Reqs 18.5, 18.8)', () => {
  it('emits a record with design §11.2’s fields', () => {
    const { service, emitted } = build();

    service.logJob({
      requestId: 'req-1',
      userId: 'user-1',
      engineId: 'ace-step-1.5',
      engineJobId: 'engine-job-1',
      modelName: 'ace-step-v1.5',
      durationMs: 4_200,
      assetKind: 'song',
      status: 'succeeded',
      timestampMs: 1_700_000_000_000,
    });

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      requestId: 'req-1',
      engineJobId: 'engine-job-1',
      modelName: 'ace-step-v1.5',
      durationMs: 4_200,
    });
  });

  it('masks an email and a key on the way in', () => {
    const { service, emitted } = build();

    service.logJob({
      requestId: 'req-1',
      userId: 'user-1',
      durationMs: 1,
      assetKind: 'song',
      status: 'failed',
      timestampMs: 1,
      actorEmail: 'alice@example.com',
      apiKey: 'sk-live-8f2a91c4',
    });

    expect(emitted[0]?.actorEmailMasked).toBe('***@example.com');
    expect(emitted[0]?.apiKeyMasked).toBe('sk-***91c4');
    expect(JSON.stringify(emitted[0])).not.toContain('alice');
  });

  it('masks rather than dropping when the input is raw, and counts nothing', () => {
    const { service, emitted } = build();
    const before = service.droppedUnmaskedLogCount();

    service.logJob({
      requestId: 'r',
      userId: 'u',
      durationMs: 1,
      assetKind: 'song',
      status: 'failed',
      timestampMs: 1,
      actorEmail: 'alice@example.com',
    });

    // The builder masks, so nothing is dropped on the normal path. The drop path is the gate
    // catching a record that did *not* come through the builder, and it is exercised by
    // `test/property/log-masking.test.ts`, which is where the record shapes are generated.
    expect(service.droppedUnmaskedLogCount()).toBe(before);
    expect(emitted.at(-1)?.actorEmailMasked).toBe('***@example.com');
  });
});
