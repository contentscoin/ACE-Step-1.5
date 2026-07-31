import type { EngineAdapter } from '../../adapters/engine-adapter';
import {
  ENGINE_JOB_STATE,
  type EngineJobHandle,
  type EngineJobStatus,
  type HealthCheckResult,
  type RawAudioResult,
} from '../../adapters/engine-job';
import type { NormalizedGenerationRequest } from '../../adapters/normalized-generation';

/**
 * Test double implementing `EngineAdapter`.
 *
 * Task 1.3 defines the interface; the concrete ACE/Woosh/TTS/DeepAFx adapters
 * are task 2.1+. This double is the whole engine side of every 1.3 test, and it
 * is scripted rather than random: health outcomes come from a queue the test
 * controls, so the 20.8 and 20.21 transitions are driven by an exact sequence.
 */
export interface FakeEngineAdapter extends EngineAdapter {
  /** Queue one outcome for the next `healthCheck()` call. */
  enqueueHealth(...outcomes: readonly ('healthy' | 'unhealthy' | 'throw' | 'hang')[]): void;
  /** Outcome used once the queue is empty. */
  setDefaultHealth(outcome: 'healthy' | 'unhealthy' | 'throw' | 'hang'): void;
  readonly healthCheckCount: number;
  readonly submittedRequests: readonly NormalizedGenerationRequest[];
  readonly cancelledHandles: readonly EngineJobHandle[];
}

export interface FakeEngineAdapterOptions {
  readonly engineId: string;
  readonly sampleRate?: number;
  readonly durationMs?: number;
  readonly seed?: number | null;
  readonly jobState?: EngineJobStatus['state'];
}

export function createFakeEngineAdapter(options: FakeEngineAdapterOptions): FakeEngineAdapter {
  const queued: ('healthy' | 'unhealthy' | 'throw' | 'hang')[] = [];
  const submitted: NormalizedGenerationRequest[] = [];
  const cancelled: EngineJobHandle[] = [];
  let fallback: 'healthy' | 'unhealthy' | 'throw' | 'hang' = 'healthy';
  let healthCheckCount = 0;
  let jobCounter = 0;

  return {
    engineId: options.engineId,

    get healthCheckCount() {
      return healthCheckCount;
    },
    get submittedRequests() {
      return submitted;
    },
    get cancelledHandles() {
      return cancelled;
    },

    enqueueHealth(...outcomes) {
      queued.push(...outcomes);
    },
    setDefaultHealth(outcome) {
      fallback = outcome;
    },

    async submit(request) {
      submitted.push(request);
      jobCounter += 1;
      return {
        engineId: options.engineId,
        engineJobId: `${options.engineId}-job-${String(jobCounter)}`,
        submittedAtMs: 0,
      };
    },

    async poll() {
      return { state: options.jobState ?? ENGINE_JOB_STATE.succeeded };
    },

    async fetchResult(): Promise<RawAudioResult[]> {
      return [
        {
          audioBuffer: Buffer.from(`${options.engineId}-audio`),
          sampleRate: options.sampleRate ?? 44_100,
          durationMs: options.durationMs ?? 30_000,
          seed: options.seed ?? null,
        },
      ];
    },

    async healthCheck(): Promise<HealthCheckResult> {
      healthCheckCount += 1;
      const outcome = queued.shift() ?? fallback;

      if (outcome === 'throw') throw new Error(`${options.engineId} probe failed`);
      // Never settles: the timeout runner is what ends the call, exactly as the
      // Requirement 20.7 budget does in production.
      if (outcome === 'hang') return new Promise<HealthCheckResult>(() => undefined);

      return { healthy: outcome === 'healthy', latencyMs: 12 };
    },

    async cancel(handle) {
      cancelled.push(handle);
    },
  };
}
