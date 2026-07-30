/**
 * Daily engine quotas (Requirements 20.12, 20.13).
 *
 * Two counters per engine — requests and GPU seconds — both reset to 0 at
 * 00:00 UTC. The reset is *lazy*: usage records the UTC day it belongs to and a
 * read from a later day starts from zero. No timer is involved, so the reset is
 * exactly as testable as the injected clock, and a process that was asleep
 * across midnight cannot miss it.
 */

import type { Clock } from '../../services/clock';

export const MS_PER_DAY = 24 * 60 * 60 * 1_000;

export interface QuotaRequirement {
  readonly requests: number;
  readonly gpuSeconds: number;
}

export interface QuotaUsage {
  readonly requests: number;
  readonly gpuSeconds: number;
  /** 00:00 UTC of the day these counters belong to. */
  readonly dayStartMs: number;
}

export interface QuotaLimits {
  readonly maxRequests: number;
  readonly maxGpuSeconds: number;
}

export type QuotaDimension = 'requests' | 'gpuSeconds';

export type QuotaCheck =
  | { readonly sufficient: true; readonly remaining: QuotaRequirement }
  | {
      readonly sufficient: false;
      /** Which counters cannot cover the request (Requirement 20.13). */
      readonly exhausted: readonly QuotaDimension[];
      readonly remaining: QuotaRequirement;
      readonly nextResetAtMs: number;
    };

/** 00:00 UTC of the day containing `instantMs`. */
export function utcDayStartMs(instantMs: number): number {
  return Math.floor(instantMs / MS_PER_DAY) * MS_PER_DAY;
}

/** The next 00:00 UTC strictly after `instantMs` (Requirement 20.13). */
export function nextQuotaResetAtMs(instantMs: number): number {
  return utcDayStartMs(instantMs) + MS_PER_DAY;
}

export interface QuotaLedger {
  usage(engineId: string): QuotaUsage;
  check(engineId: string, limits: QuotaLimits, need: QuotaRequirement): QuotaCheck;
  /** Records consumption. Callers check first; this does not re-check. */
  consume(engineId: string, need: QuotaRequirement): QuotaUsage;
}

export function createQuotaLedger(clock: Clock): QuotaLedger {
  const usageByEngine = new Map<string, QuotaUsage>();

  const currentUsage = (engineId: string): QuotaUsage => {
    const dayStartMs = utcDayStartMs(clock.now().getTime());
    const stored = usageByEngine.get(engineId);
    if (stored === undefined || stored.dayStartMs !== dayStartMs) {
      return { requests: 0, gpuSeconds: 0, dayStartMs };
    }
    return stored;
  };

  return {
    usage: currentUsage,

    check(engineId, limits, need) {
      const usage = currentUsage(engineId);
      const remaining: QuotaRequirement = {
        requests: limits.maxRequests - usage.requests,
        gpuSeconds: limits.maxGpuSeconds - usage.gpuSeconds,
      };

      const exhausted: QuotaDimension[] = [];
      if (remaining.requests < need.requests) exhausted.push('requests');
      if (remaining.gpuSeconds < need.gpuSeconds) exhausted.push('gpuSeconds');

      if (exhausted.length === 0) return { sufficient: true, remaining };

      return {
        sufficient: false,
        exhausted,
        remaining,
        nextResetAtMs: nextQuotaResetAtMs(clock.now().getTime()),
      };
    },

    consume(engineId, need) {
      const usage = currentUsage(engineId);
      const updated: QuotaUsage = {
        requests: usage.requests + need.requests,
        gpuSeconds: usage.gpuSeconds + need.gpuSeconds,
        dayStartMs: usage.dayStartMs,
      };
      usageByEngine.set(engineId, updated);
      return updated;
    },
  };
}
