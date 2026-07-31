/**
 * Engine-side job vocabulary (design §3.1).
 *
 * These types are the only shape an `EngineAdapter` may expose to callers, so
 * no engine-specific field name ever reaches the service layer. That is the
 * mechanical form of the engine-transparency principle (design §1.2, §1.4.4).
 */

/** Opaque reference to work accepted by an engine. */
export interface EngineJobHandle {
  readonly engineId: string;
  /** Engine-assigned identifier; treated as opaque text by the product layer. */
  readonly engineJobId: string;
  readonly submittedAtMs: number;
}

/**
 * Design §3.1 fixes the wire values: 0 = running, 1 = succeeded, 2 = failed.
 * The named constants exist so nothing in the product layer writes a bare
 * numeral.
 */
export const ENGINE_JOB_STATE = {
  running: 0,
  succeeded: 1,
  failed: 2,
} as const;

export type EngineJobState = (typeof ENGINE_JOB_STATE)[keyof typeof ENGINE_JOB_STATE];

export interface EngineJobStatus {
  readonly state: EngineJobState;
  /** 0–100 when the engine reports it; omitted otherwise. */
  readonly progressPercent?: number;
  /** Present only when `state` is `failed`. */
  readonly failureReason?: string;
}

/** One audio artefact as the engine returned it, before normalisation (§3.5). */
export interface RawAudioResult {
  readonly audioBuffer: Buffer;
  /** Engine-native rate; normalisation resamples to 48 kHz (§3.5). */
  readonly sampleRate: number;
  readonly durationMs: number;
  /** `null` when the engine does not report a seed (§3.5). */
  readonly seed: number | null;
}

/** Outcome of one `healthCheck()` call (Requirement 20.7). */
export interface HealthCheckResult {
  readonly healthy: boolean;
  readonly latencyMs: number;
  readonly detail?: string;
}

export function isTerminalJobState(state: EngineJobState): boolean {
  return state === ENGINE_JOB_STATE.succeeded || state === ENGINE_JOB_STATE.failed;
}
