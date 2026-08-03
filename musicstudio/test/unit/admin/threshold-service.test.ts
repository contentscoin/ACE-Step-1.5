import { describe, expect, it } from 'vitest';

import {
  MIN_CALIBRATION_SAMPLES,
  createThresholdService,
  summariseCalibration,
  type AdminCaller,
  type CalibrationRecord,
} from '../../../services/admin/threshold-service';
import { GenerationError } from '../../../services/generation/errors';
import {
  INITIAL_QUALITY_THRESHOLD_SET,
  listThresholds,
} from '../../../domain/quality/threshold-set';
import { QUALITY_THRESHOLD_NAMES } from '../../../domain/quality/threshold-name';
import type { AuditLogDraft } from '../../../domain/audit-log/entry';
import { createMutableClock } from '../../support/mutable-clock';

/**
 * Quality_Threshold_Set CRUD.
 *
 * **Validates: Requirements 34.4, 34.5, 34.7, 34.9, 34.10**
 *
 * The domain already decides whether a value is in range. What is checked here is what the
 * service adds: that the gate refuses **reads** as well as writes, that a rejected change leaves
 * the set and the version untouched, that the audit entry carries both sides, and that an old
 * version keeps meaning what it meant.
 */

const OPERATOR: AdminCaller = { accountId: 'operator-1', isOperator: true };
const USER: AdminCaller = { accountId: 'user-1', isOperator: false };

function build() {
  const drafts: AuditLogDraft[] = [];
  const records = new Map<string, CalibrationRecord>();
  const clock = createMutableClock(new Date(1_700_000_000_000));

  const service = createThresholdService({
    audit: { record: (draft) => void drafts.push(draft) },
    clock,
    calibration: {
      async find(name) {
        return records.get(name) ?? null;
      },
      async put(record) {
        records.set(record.thresholdName, record);
      },
    },
  });

  return { service, drafts, clock };
}

describe('the operator gate (Req 34.9)', () => {
  it('refuses a non-operator on every entry point, reads included', async () => {
    const { service } = build();

    // 조회 **및** 변경. A console that let anyone read would leak the tuning of every quality
    // check — which tells an attacker exactly how loud to make a payload to pass.
    expect(() => service.list(USER)).toThrow(GenerationError);
    expect(() => service.version(USER)).toThrow(GenerationError);
    expect(() => service.change(USER, 'loop_seam_rms_difference_max', 1)).toThrow(GenerationError);
    await expect(
      service.recordCalibration(USER, 'loop_seam_rms_difference_max', []),
    ).rejects.toThrow(GenerationError);
    await expect(service.calibrationFor(USER, 'loop_seam_rms_difference_max')).rejects.toThrow(
      GenerationError,
    );
  });

  it('answers 403 and names the action', () => {
    const { service } = build();
    const error = (() => {
      try {
        service.list(USER);
        return null;
      } catch (thrown) {
        return thrown as GenerationError;
      }
    })();

    expect(error?.statusCode).toBe(403);
    expect(error?.code).toBe('operator_role_required');
    expect(error?.details.action).toBe('quality_threshold_list');
  });

  it('lets an operator through', () => {
    const { service } = build();
    expect(service.list(OPERATOR)).toHaveLength(QUALITY_THRESHOLD_NAMES.length);
    expect(service.version(OPERATOR)).toBe(INITIAL_QUALITY_THRESHOLD_SET.version);
  });

  it('does not gate the source the product judges through', () => {
    // This is the product checking its own output, not an operator reading.
    const { service } = build();
    expect(service.source().current().version).toBe(INITIAL_QUALITY_THRESHOLD_SET.version);
  });
});

describe('changing a threshold (Reqs 34.4, 34.5)', () => {
  it('accepts both ends of every threshold’s adjustable range', () => {
    for (const threshold of listThresholds(INITIAL_QUALITY_THRESHOLD_SET)) {
      const { service } = build();
      expect(
        () => service.change(OPERATOR, threshold.name, threshold.adjustableFrom),
        threshold.name,
      ).not.toThrow();
      const { service: other } = build();
      expect(
        () => other.change(OPERATOR, threshold.name, threshold.adjustableTo),
        threshold.name,
      ).not.toThrow();
    }
  });

  it('refuses just outside either end, for every threshold', () => {
    for (const threshold of listThresholds(INITIAL_QUALITY_THRESHOLD_SET)) {
      const { service } = build();
      const span = threshold.adjustableTo - threshold.adjustableFrom;
      // A step proportional to the range, so a threshold measured in dB and one measured in a
      // 0–1 ratio are both stepped outside rather than one being nudged within float noise.
      const step = Math.max(span * 0.01, 1e-6);

      expect(
        () => service.change(OPERATOR, threshold.name, threshold.adjustableFrom - step),
        threshold.name,
      ).toThrow(GenerationError);
      expect(
        () => service.change(OPERATOR, threshold.name, threshold.adjustableTo + step),
        threshold.name,
      ).toThrow(GenerationError);
    }
  });

  it('returns the permitted range in the refusal and keeps the value (Req 34.5)', () => {
    const { service, drafts } = build();
    const before = service.list(OPERATOR).find((t) => t.name === 'loop_seam_rms_difference_max');

    const error = (() => {
      try {
        service.change(OPERATOR, 'loop_seam_rms_difference_max', 9_999);
        return null;
      } catch (thrown) {
        return thrown as GenerationError;
      }
    })();

    expect(error?.code).toBe('quality_threshold_out_of_range');
    expect(error?.details.adjustableFrom).toBe(before?.adjustableFrom);
    expect(error?.details.adjustableTo).toBe(before?.adjustableTo);
    // Unchanged, and — the part a version bump would break — the version did not move either.
    expect(service.list(OPERATOR).find((t) => t.name === 'loop_seam_rms_difference_max')).toEqual(
      before,
    );
    expect(service.version(OPERATOR)).toBe(INITIAL_QUALITY_THRESHOLD_SET.version);
    expect(drafts).toEqual([]);
  });

  it('bumps the version by exactly one and audits both sides (Req 34.4)', () => {
    const { service, drafts } = build();
    const before = service.list(OPERATOR).find((t) => t.name === 'loop_seam_rms_difference_max');
    const target = (before?.adjustableFrom ?? 0) + 0.5;

    const next = service.change(OPERATOR, 'loop_seam_rms_difference_max', target);

    expect(next.version).toBe(INITIAL_QUALITY_THRESHOLD_SET.version + 1);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      eventType: 'quality_threshold_changed',
      actorId: 'operator-1',
      targetId: 'loop_seam_rms_difference_max',
      beforeValue: { value: before?.value, version: INITIAL_QUALITY_THRESHOLD_SET.version },
      afterValue: { value: target, version: next.version },
    });
    expect(drafts[0]?.eventTime?.getTime()).toBe(1_700_000_000_000);
  });

  it('changes only the named threshold', () => {
    const { service } = build();
    const before = service.list(OPERATOR);
    const target = (before[0]?.adjustableFrom ?? 0) + 0.1;

    service.change(OPERATOR, before[0]?.name ?? 'loop_seam_rms_difference_max', target);
    const after = service.list(OPERATOR);

    for (const [index, threshold] of after.entries()) {
      if (index === 0) continue;
      expect(threshold).toEqual(before[index]);
    }
  });
});

describe('an old version keeps its meaning (Req 34.10)', () => {
  it('answers with the set that version was, not the current one', () => {
    const { service } = build();
    const originalValue = service
      .list(OPERATOR)
      .find((t) => t.name === 'loop_seam_rms_difference_max')?.value;

    const v1 = INITIAL_QUALITY_THRESHOLD_SET.version;
    const next = service.change(OPERATOR, 'loop_seam_rms_difference_max', 2.5);

    // An asset recorded v1 (Requirement 34.6). Explaining it with v2's numbers is exactly
    // what 34.10 forbids.
    expect(service.setAtVersion(v1)?.thresholds.loop_seam_rms_difference_max.value).toBe(
      originalValue,
    );
    expect(service.setAtVersion(next.version)?.thresholds.loop_seam_rms_difference_max.value).toBe(
      2.5,
    );
  });

  it('returns null for a version that never existed', () => {
    const { service } = build();
    expect(service.setAtVersion(999)).toBeNull();
  });
});

describe('calibration evidence (Req 34.7)', () => {
  const samples = Array.from({ length: MIN_CALIBRATION_SAMPLES }, (_unused, index) => ({
    assetId: `asset-${String(index)}`,
    measured: index,
    passed: index % 4 !== 0,
  }));

  it('summarises the distribution and the pass/fail split', async () => {
    const { service } = build();

    const summary = await service.recordCalibration(
      OPERATOR,
      'loop_seam_rms_difference_max',
      samples,
    );

    expect(summary.sampleCount).toBe(MIN_CALIBRATION_SAMPLES);
    expect(summary.min).toBe(0);
    expect(summary.max).toBe(MIN_CALIBRATION_SAMPLES - 1);
    expect(summary.median).toBe(9.5);
    expect(summary.passed + summary.failed).toBe(MIN_CALIBRATION_SAMPLES);
    expect(summary.sufficient).toBe(true);
  });

  it('reports a thin record rather than refusing it', async () => {
    const { service } = build();

    const summary = await service.recordCalibration(OPERATOR, 'loop_seam_rms_difference_max', [
      { assetId: 'a', measured: 1, passed: true },
    ]);

    // 34.7 says the product *holds* twenty or more. Hiding a record of one would hide the fact
    // that the evidence is thin, which is what an operator most needs to know.
    expect(summary.sufficient).toBe(false);
    expect(summary.sampleCount).toBe(1);
  });

  it('reads back what was recorded', async () => {
    const { service } = build();
    await service.recordCalibration(OPERATOR, 'loop_seam_rms_difference_max', samples);
    expect((await service.calibrationFor(OPERATOR, 'loop_seam_rms_difference_max'))?.sampleCount).toBe(
      MIN_CALIBRATION_SAMPLES,
    );
    expect(await service.calibrationFor(OPERATOR, 'one_shot_tail_amplitude_ratio_max')).toBeNull();
  });

  it('takes the median of an odd-sized sample from the middle', () => {
    const summary = summariseCalibration({
      thresholdName: 'loop_seam_rms_difference_max',
      samples: [
        { assetId: 'a', measured: 5, passed: true },
        { assetId: 'b', measured: 1, passed: true },
        { assetId: 'c', measured: 3, passed: false },
      ],
      recordedAtMs: 1,
    });
    // Sorted first — an unsorted median would return whatever the caller happened to pass third.
    expect(summary.median).toBe(3);
  });
});
