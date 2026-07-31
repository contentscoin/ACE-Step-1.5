/**
 * `DeepAFx_Adapter` — the parameter-suggestion model behind `SuggestionModelPort`
 * (Requirements 30.19, 30.20, 30.21, 30.23).
 *
 * The adapter's whole job is the *unavailability* half of the requirement. Requirement 30.20
 * gives the service 120 seconds and then declares it unusable; Requirement 30.21 requires a
 * built-in answer instead. This module decides the first and reports it in a form
 * `Mastering_Assistant` can act on; the built-in suggestion itself is
 * `domain/mastering/suggestion.ts`'s, because it is a pure function of the measurement and
 * has nothing to do with HTTP.
 *
 * ### The budget is enforced here, through an injectable runner
 *
 * `TimeoutRunner` is the same port `adapters/registry/remote-call.ts` uses for Requirement
 * 20.14, and for the same reason: **timing behaviour must be assertable without a test ever
 * waiting 120 real seconds.** `test/unit/mastering/deepafx-adapter.test.ts` injects a runner
 * that resolves `timed_out` immediately, so the timeout path is exercised on every run
 * rather than being the one branch nobody checks.
 *
 * A timed-out or failed call rejects with `SuggestionModelUnavailableError`, and
 * `Mastering_Assistant.suggest` catches it and falls back. Rejecting rather than returning a
 * sentinel keeps `SuggestionModelPort` honest: the port's contract is "a suggestion", and a
 * port that could also return "no suggestion" would push the fallback decision into every
 * caller.
 *
 * ### Requirement 30.23 travels on the response
 *
 * `commercialUseAllowed` is read from the licence ruling the `ProviderRegistry` recorded when
 * the engine was registered, *not* from the descriptor's own claim — which is the point of
 * Requirement 33.2. See `license.ts` for the whole route. The adapter cannot widen it: the
 * ruling arrives as a constructor argument and is passed through, and there is no parameter on
 * any method here that could override it.
 *
 * ### What is not validated here
 *
 * The chain comes back unvalidated. Requirement 30.2 makes range conformance something the
 * *assistant* must establish, and a suggestion the adapter had already coerced into range
 * would make that invariant unfalsifiable — so the raw items are handed over and
 * `suggestionDefects` judges them. See `services/mastering/ports.ts`.
 */

import { DEEPAFX_ENGINE_ID, DEEPAFX_SUGGESTION_TIMEOUT_MS } from './license';
import type { DeepAfxTransport } from './transport';

import { realTimeoutRunner, type TimeoutRunner } from '../timeout-runner';
import type {
  SuggestionModelPort,
  SuggestionModelRequest,
  SuggestionModelResponse,
} from '../../services/mastering/ports';

/** Why the suggestion service could not be used (Requirements 30.20, 30.21). */
export type SuggestionUnavailableReason =
  /** Requirement 30.20: no response inside the 120-second budget. */
  | 'timed_out'
  /** The transport failed, or the service answered with a non-2xx status. */
  | 'transport_failed'
  /** A 2xx response whose body did not carry a chain. */
  | 'malformed_response';

export class SuggestionModelUnavailableError extends Error {
  constructor(
    readonly reason: SuggestionUnavailableReason,
    readonly budgetMs: number,
    readonly detail?: string,
  ) {
    super(`the parameter suggestion service is unavailable (${reason})`);
    this.name = 'SuggestionModelUnavailableError';
  }
}

export const DEEPAFX_SUGGEST_PATH = '/v1/mastering/suggest';

export interface DeepAfxAdapterConfig {
  readonly transport: DeepAfxTransport;
  /**
   * Requirement 33.2's ruling for this engine, as the `ProviderRegistry` recorded it.
   *
   * Mandatory and not defaulted to `true`: a caller that forgot to pass it would otherwise
   * get a permissive value, which is the one direction Requirement 33.22 must not fail in.
   */
  readonly commercialUseAllowed: boolean;
  /** Injected so the timeout path is testable. Defaults to the real timer. */
  readonly timeoutRunner?: TimeoutRunner;
  /** Requirement 30.20. Overridable only so a test can shorten it, never lengthen it. */
  readonly timeoutMs?: number;
  readonly engineId?: string;
}

export function createDeepAfxAdapter(config: DeepAfxAdapterConfig): SuggestionModelPort {
  const runner = config.timeoutRunner ?? realTimeoutRunner;
  // `Math.min` rather than `??`: a configuration that asked for 300 s would silently
  // breach Requirement 30.20's ceiling, and the clause is a maximum.
  const budgetMs = Math.min(config.timeoutMs ?? DEEPAFX_SUGGESTION_TIMEOUT_MS,
    DEEPAFX_SUGGESTION_TIMEOUT_MS);
  const engineId = config.engineId ?? DEEPAFX_ENGINE_ID;

  return {
    async suggest(request: SuggestionModelRequest): Promise<SuggestionModelResponse> {
      const outcome = await runner.run(
        () => config.transport.postJson({
          path: DEEPAFX_SUGGEST_PATH,
          body: wireBody(request),
        }),
        budgetMs,
      );

      if (outcome.kind === 'timed_out') {
        throw new SuggestionModelUnavailableError('timed_out', outcome.budgetMs);
      }
      if (outcome.kind === 'failed') {
        throw new SuggestionModelUnavailableError(
          'transport_failed',
          budgetMs,
          outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
        );
      }

      const { httpStatus, envelope } = outcome.value;
      if (httpStatus < 200 || httpStatus >= 300) {
        throw new SuggestionModelUnavailableError(
          'transport_failed',
          budgetMs,
          `HTTP ${String(httpStatus)}`,
        );
      }
      if (envelope.chain === undefined || envelope.chain === null) {
        throw new SuggestionModelUnavailableError('malformed_response', budgetMs, 'no chain');
      }

      return {
        engineId: typeof envelope.model === 'string' ? envelope.model : engineId,
        items: envelope.chain,
        commercialUseAllowed: config.commercialUseAllowed,
      };
    },
  };
}

/**
 * The request body, in one place so the wire form is a single assertable value.
 *
 * The measurements are sent because they are what the model conditions on and because
 * `Mastering_Assistant` has already taken them (Requirement 30.22) — sending the object key
 * and letting the service re-measure would put two BS.1770-4 implementations in the loop and
 * make Requirement 30.24's agreement a three-way problem.
 */
function wireBody(request: SuggestionModelRequest): Readonly<Record<string, unknown>> {
  return {
    audio: {
      object_key: request.source.objectKey,
      sample_rate: request.source.sampleRate,
      channels: request.source.channels,
      frame_count: request.source.frameCount,
    },
    measurement: {
      integrated_loudness_lufs: request.measurement.integratedLoudnessLufs,
      true_peak_dbtp: request.measurement.truePeakDbtp,
      octave_bands: request.measurement.octaveBands.map((band) => ({
        centre_hz: band.centreHz,
        energy_db: band.energyDb,
      })),
    },
  };
}
