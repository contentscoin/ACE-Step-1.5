/**
 * Admin_Console (Requirements 18.1, 18.2, 18.9, 18.10, 18.13).
 *
 * A read model: five queries an operator asks, each returning what its clause enumerates and
 * nothing more.
 *
 * ### Why the counts come from one port call per query rather than from a shared cache
 *
 * The dashboard of 18.1 and the engine view of 18.10 overlap — both want a per-engine pending
 * count. Caching that between them would mean the two views could disagree by a poll interval,
 * and an operator comparing "12 waiting" on one screen with "9 waiting" on the other has no way
 * to tell which is stale. Each query reads once, and what it returns is one moment.
 *
 * ### An average over nothing is `null`, not zero
 *
 * 18.1 asks for 평균 작업 소요 시간 and 18.13 for a per-kind average. With no jobs in the window
 * there is no average. Reporting 0 ms would put "0 ms average" on a dashboard beside "0 jobs",
 * and the first reading of that is that something is very fast rather than that nothing ran.
 */

import type { AssetKind } from '../../domain/asset-kind';
import {
  failureRate,
  queueUtilisation,
  type FailureWindow,
} from '../../domain/observability/alerts';
import { operatorRoleRequired, adminJobNotFound } from './errors';
import type { AdminCaller } from './threshold-service';

/* ------------------------------------------------------------------ shapes */

/** Requirement 18.1. */
export interface OperationsSummary {
  readonly queued: number;
  readonly running: number;
  readonly succeeded: number;
  readonly failed: number;
  /** `null` when nothing has finished — see the module header. */
  readonly averageDurationMs: number | null;
  /** Requirement 18.2: the utilisation *and* the maximum it is measured against. */
  readonly queueUtilisation: number;
  readonly queueCapacity: number;
}

/** Requirement 18.10, one row per registered Engine_Descriptor. */
export interface EngineStatusRow {
  readonly engineId: string;
  readonly pendingJobs: number;
  /** `null` when the 15-minute window has too few samples to have a rate. */
  readonly failureRate15m: number | null;
  readonly quotaRemaining: number;
  readonly lastHealthCheckAtMs: number | null;
  readonly lastHealthCheckHealthy: boolean | null;
}

/** Requirement 18.13. */
export interface AssetKindStatsRow {
  readonly assetKind: AssetKind;
  readonly createdLast24h: number;
  readonly averageDurationMs: number | null;
}

/** Requirement 18.9. */
export interface JobDiagnostics {
  readonly jobId: string;
  readonly transitions: readonly {
    readonly from: string | null;
    readonly to: string;
    readonly atMs: number;
  }[];
  readonly failureReason: string | null;
}

/* ------------------------------------------------------------------- ports */

export interface OperationsCounts {
  readonly queued: number;
  readonly running: number;
  readonly succeeded: number;
  readonly failed: number;
  /** Total finished-job duration and how many finished, so the average is derived not stored. */
  readonly completedDurationTotalMs: number;
  readonly completedCount: number;
  readonly queueDepth: number;
  readonly queueCapacity: number;
}

export interface EngineOperationsRow {
  readonly engineId: string;
  readonly pendingJobs: number;
  readonly window: FailureWindow;
  readonly quotaRemaining: number;
  readonly lastHealthCheckAtMs: number | null;
  readonly lastHealthCheckHealthy: boolean | null;
}

export interface AssetKindCounts {
  readonly assetKind: AssetKind;
  readonly createdLast24h: number;
  readonly durationTotalMs: number;
  readonly completedCount: number;
}

export interface AdminMetricsPort {
  operations(): Promise<OperationsCounts>;
  engines(): Promise<readonly EngineOperationsRow[]>;
  assetKinds(): Promise<readonly AssetKindCounts[]>;
  jobDiagnostics(jobId: string): Promise<JobDiagnostics | null>;
}

export interface AdminConsoleOptions {
  readonly metrics: AdminMetricsPort;
}

/** The average, or `null` when nothing finished. One place, so the four call sites agree. */
export function meanDurationMs(totalMs: number, count: number): number | null {
  if (count <= 0) return null;
  return Math.round(totalMs / count);
}

export function createAdminConsole(options: AdminConsoleOptions) {
  const { metrics } = options;

  function requireOperator(caller: AdminCaller, action: string): void {
    if (!caller.isOperator) throw operatorRoleRequired(action);
  }

  return {
    /** Requirements 18.1, 18.2. */
    async operations(caller: AdminCaller): Promise<OperationsSummary> {
      requireOperator(caller, 'admin_operations');
      const counts = await metrics.operations();

      return {
        queued: counts.queued,
        running: counts.running,
        succeeded: counts.succeeded,
        failed: counts.failed,
        averageDurationMs: meanDurationMs(
          counts.completedDurationTotalMs,
          counts.completedCount,
        ),
        // Requirement 18.2 asks for both, and the pair is the point: 40 of 50 and 40 of 500
        // are the same depth and different situations.
        queueUtilisation: queueUtilisation({
          queueDepth: counts.queueDepth,
          queueCapacity: counts.queueCapacity,
        }),
        queueCapacity: counts.queueCapacity,
      };
    },

    /** Requirement 18.10. */
    async engines(caller: AdminCaller): Promise<readonly EngineStatusRow[]> {
      requireOperator(caller, 'admin_engines');
      const rows = await metrics.engines();

      return [...rows]
        .sort((a, b) => a.engineId.localeCompare(b.engineId))
        .map((row) => ({
          engineId: row.engineId,
          pendingJobs: row.pendingJobs,
          // The same `failureRate` the alerts use, so the dashboard and the page an operator
          // was woken by cannot disagree about whether an engine is failing.
          failureRate15m: failureRate(row.window),
          quotaRemaining: row.quotaRemaining,
          lastHealthCheckAtMs: row.lastHealthCheckAtMs,
          lastHealthCheckHealthy: row.lastHealthCheckHealthy,
        }));
    },

    /** Requirement 18.13. */
    async assetKinds(caller: AdminCaller): Promise<readonly AssetKindStatsRow[]> {
      requireOperator(caller, 'admin_asset_kinds');
      const rows = await metrics.assetKinds();

      return [...rows]
        .sort((a, b) => a.assetKind.localeCompare(b.assetKind))
        .map((row) => ({
          assetKind: row.assetKind,
          createdLast24h: row.createdLast24h,
          averageDurationMs: meanDurationMs(row.durationTotalMs, row.completedCount),
        }));
    },

    /** Requirement 18.9. */
    async job(caller: AdminCaller, jobId: string): Promise<JobDiagnostics> {
      requireOperator(caller, 'admin_job_diagnostics');
      const diagnostics = await metrics.jobDiagnostics(jobId);
      if (diagnostics === null) throw adminJobNotFound(jobId);
      return diagnostics;
    },
  };
}

export type AdminConsole = ReturnType<typeof createAdminConsole>;
