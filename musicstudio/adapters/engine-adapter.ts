/**
 * Engine_Adapter interface (design §3.1).
 *
 * The single seam between the product layer and any generation engine. Concrete
 * adapters (ACE-Step, Woosh, TTS, DeepAFx) implement this and nothing else is
 * allowed to talk to an engine — which is what makes the coupling invariant of
 * design §1.4.4 enforceable: `musicstudio/` never imports `acestep/`, it calls
 * an engine over HTTP from behind this interface.
 */

import type {
  EngineJobHandle,
  EngineJobStatus,
  HealthCheckResult,
  RawAudioResult,
} from './engine-job';
import type { NormalizedGenerationRequest } from './normalized-generation';

export interface EngineAdapter {
  /** Engine identifier; must equal the Engine_Descriptor's `engineId`. */
  readonly engineId: string;

  /** Translate the normalised request into the engine's own form and send it. */
  submit(request: NormalizedGenerationRequest): Promise<EngineJobHandle>;

  /** Query job state (0 = running, 1 = succeeded, 2 = failed). */
  poll(handle: EngineJobHandle): Promise<EngineJobStatus>;

  /** Download the produced audio. */
  fetchResult(handle: EngineJobHandle): Promise<RawAudioResult[]>;

  /**
   * Liveness probe. Requirement 20.7 caps each probe at 10 seconds; the cap is
   * applied by the caller (`health-monitor.ts`) so an adapter cannot opt out of
   * it by forgetting to implement a timeout.
   */
  healthCheck(): Promise<HealthCheckResult>;

  /** Cancel queued work. Only meaningful before the engine starts the job. */
  cancel(handle: EngineJobHandle): Promise<void>;
}
