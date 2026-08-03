/**
 * Quality_Threshold_Set CRUD (Requirements 34.4, 34.5, 34.7, 34.9, 34.10).
 *
 * `domain/quality/threshold-set.ts` already decides *whether* a change is legal and what the new
 * set looks like. What is here is the four things that are not pure: the operator gate, the audit
 * entry, the calibration evidence, and publishing the new set so the next judgement reads it.
 *
 * ### 34.10 is satisfied by the set being a value, not by a migration
 *
 * > WHEN 운영자가 임계값 변경을 적용하면, THE MusicStudio SHALL 변경 이전에 저장된 Audio_Asset의
 * > 출처 정보와 검증 결과를 변경 없이 유지한다
 *
 * An asset records the *version* it was judged under (34.6). `changeThreshold` returns a new set
 * rather than mutating the old one, so version 3 keeps meaning what version 3 meant. There is
 * nothing to preserve because nothing was overwritten — which is why this service stores a
 * history of sets rather than one mutable record.
 *
 * ### The gate is on reading too
 *
 * 34.9 says 조회 **및** 변경. A console that let anyone read the thresholds and only operators
 * change them would leak the tuning of every quality check, which is the sort of thing that tells
 * an attacker exactly how loud to make a payload to pass. Both entry points take the caller's
 * role and both refuse.
 */

import {
  changeThreshold,
  listThresholds,
  type QualityThreshold,
  type QualityThresholdSet,
} from '../../domain/quality/threshold-set';
import { INITIAL_QUALITY_THRESHOLD_SET } from '../../domain/quality/threshold-set';
import type { QualityThresholdName } from '../../domain/quality/threshold-name';
import type { QualityThresholdSource } from '../../domain/quality/threshold-source';
import type { AuditSinkPort } from '../../adapters/registry/ports';
import type { Clock } from '../clock';
import { operatorRoleRequired, thresholdOutOfRange } from './errors';

/**
 * Requirement 34.7's evidence: the measurements a threshold's value was chosen from.
 *
 * > … 20개 이상의 참조 자산에서 측정한 값의 분포와 합격·불합격 판정 결과를 담은 보정 근거 기록
 */
export const MIN_CALIBRATION_SAMPLES = 20;

export interface CalibrationSample {
  readonly assetId: string;
  readonly measured: number;
  readonly passed: boolean;
}

export interface CalibrationRecord {
  readonly thresholdName: QualityThresholdName;
  readonly samples: readonly CalibrationSample[];
  readonly recordedAtMs: number;
}

/** The distribution 34.7 asks for, derived rather than stored twice. */
export interface CalibrationSummary {
  readonly thresholdName: QualityThresholdName;
  readonly sampleCount: number;
  readonly passed: number;
  readonly failed: number;
  readonly min: number;
  readonly max: number;
  readonly median: number;
  /** Whether the record meets 34.7's floor of twenty reference assets. */
  readonly sufficient: boolean;
}

export interface CalibrationStore {
  find(name: QualityThresholdName): Promise<CalibrationRecord | null>;
  put(record: CalibrationRecord): Promise<void>;
}

/** Who is asking. The only thing 34.9 needs to know. */
export interface AdminCaller {
  readonly accountId: string;
  readonly isOperator: boolean;
}

export interface ThresholdServiceOptions {
  readonly audit: AuditSinkPort;
  readonly clock: Clock;
  readonly calibration?: CalibrationStore;
  readonly initialSet?: QualityThresholdSet;
}

export function summariseCalibration(record: CalibrationRecord): CalibrationSummary {
  const measured = record.samples.map((sample) => sample.measured).sort((a, b) => a - b);
  const middle = Math.floor(measured.length / 2);
  const median =
    measured.length === 0
      ? Number.NaN
      : measured.length % 2 === 1
        ? (measured[middle] as number)
        : ((measured[middle - 1] as number) + (measured[middle] as number)) / 2;

  return {
    thresholdName: record.thresholdName,
    sampleCount: record.samples.length,
    passed: record.samples.filter((sample) => sample.passed).length,
    failed: record.samples.filter((sample) => !sample.passed).length,
    min: measured[0] ?? Number.NaN,
    max: measured.at(-1) ?? Number.NaN,
    median,
    sufficient: record.samples.length >= MIN_CALIBRATION_SAMPLES,
  };
}

export function createThresholdService(options: ThresholdServiceOptions) {
  const { audit, clock } = options;

  /**
   * Every version, oldest first. A history rather than one mutable record, because 34.6 makes an
   * asset's provenance point at a version and 34.10 requires that version to keep its meaning.
   */
  const history: QualityThresholdSet[] = [options.initialSet ?? INITIAL_QUALITY_THRESHOLD_SET];

  function currentSet(): QualityThresholdSet {
    return history[history.length - 1] as QualityThresholdSet;
  }

  function requireOperator(caller: AdminCaller, action: string): void {
    if (!caller.isOperator) throw operatorRoleRequired(action);
  }

  return {
    /**
     * The source every quality check reads through.
     *
     * Not role-gated: this is the product judging its own output, not an operator reading. The
     * gate of 34.9 is on the *console* entry points below.
     */
    source(): QualityThresholdSource {
      return { current: currentSet };
    },

    /** Requirement 34.9 — reading is operator-only too. See the module header. */
    list(caller: AdminCaller): readonly QualityThreshold[] {
      requireOperator(caller, 'quality_threshold_list');
      return listThresholds(currentSet());
    },

    version(caller: AdminCaller): number {
      requireOperator(caller, 'quality_threshold_version');
      return currentSet().version;
    },

    /**
     * Requirements 34.4, 34.5, 34.9.
     *
     * The order is the requirement's: role, then range, then the change. Checking the range
     * first would tell a non-operator which values are permitted, which is the leak 34.9 exists
     * to prevent.
     */
    change(
      caller: AdminCaller,
      name: QualityThresholdName,
      value: number,
    ): QualityThresholdSet {
      requireOperator(caller, 'quality_threshold_change');

      const outcome = changeThreshold(currentSet(), name, value);
      if (outcome.kind === 'rejected') {
        // Requirement 34.5: the existing value is kept — which is automatic here, because
        // nothing has been pushed onto the history.
        throw thresholdOutOfRange({
          name: outcome.name,
          requested: outcome.requested,
          adjustableFrom: outcome.adjustableFrom,
          adjustableTo: outcome.adjustableTo,
        });
      }

      history.push(outcome.set);

      // Requirement 34.4: both sides, the actor, and the time.
      audit.record({
        eventType: 'quality_threshold_changed',
        actorId: caller.accountId,
        targetId: name,
        beforeValue: { value: outcome.previousValue, version: outcome.previousVersion },
        afterValue: { value: outcome.nextValue, version: outcome.set.version },
        eventTime: clock.now(),
      });

      return outcome.set;
    },

    /**
     * Requirement 34.10, as a query rather than a promise.
     *
     * An asset recorded version *n*; this returns the set that version *was*. If it returned the
     * current set, an asset judged under version 3 would be re-explained with version 7's
     * numbers, which is exactly what the clause forbids.
     */
    setAtVersion(version: number): QualityThresholdSet | null {
      return history.find((set) => set.version === version) ?? null;
    },

    /** Requirement 34.7: record the evidence a value was calibrated from. */
    async recordCalibration(
      caller: AdminCaller,
      thresholdName: QualityThresholdName,
      samples: readonly CalibrationSample[],
    ): Promise<CalibrationSummary> {
      requireOperator(caller, 'quality_threshold_calibration');
      const record: CalibrationRecord = {
        thresholdName,
        samples: [...samples],
        recordedAtMs: clock.now().getTime(),
      };
      await options.calibration?.put(record);
      return summariseCalibration(record);
    },

    /**
     * The evidence behind a threshold, summarised.
     *
     * `sufficient` is reported rather than enforced: 34.7 says the product *holds* a record of
     * twenty or more, and refusing to show a record of twelve would hide the fact that the
     * evidence is thin — which is the thing an operator most needs to know.
     */
    async calibrationFor(
      caller: AdminCaller,
      thresholdName: QualityThresholdName,
    ): Promise<CalibrationSummary | null> {
      requireOperator(caller, 'quality_threshold_calibration');
      const record = await options.calibration?.find(thresholdName);
      return record == null ? null : summariseCalibration(record);
    },
  };
}

export type ThresholdService = ReturnType<typeof createThresholdService>;
