/**
 * One real song through `AceEngineAdapter`, with nothing else running.
 *
 * The gateway puts a database, Redis, a DSP sidecar and a queue between a request and
 * the engine, so a failed song there can be any of them. This runs the adapter alone —
 * health, submit, poll, fetch — against whatever engine the transport points at, and
 * names the stage that failed. It is what `npm run engine:smoke` drives on a GPU host
 * before the rest of the stack is brought up.
 *
 * Waiting is injected (`sleep`, `clock`) so the loop is testable without real time.
 */

import type { EngineJobStatus } from '../engine-job';
import type { NormalizedGenerationRequest } from '../normalized-generation';
import { validateSongRequest } from '../../domain/song/validation';
import type { Clock } from '../../services/clock';

import type { AceEngineAdapter } from './ace-engine-adapter';
import type { AceRawAudioResult } from './raw-result';

/** Where a smoke run stopped. `timeout` is the poll loop running out of budget. */
export type EngineSmokeStage = 'health' | 'submit' | 'poll' | 'fetch' | 'timeout';

export class EngineSmokeFailure extends Error {
  constructor(
    readonly stage: EngineSmokeStage,
    message: string,
  ) {
    super(`${stage}: ${message}`);
    this.name = 'EngineSmokeFailure';
  }
}

export interface EngineSmokeOptions {
  readonly adapter: Pick<AceEngineAdapter, 'healthCheck' | 'submit' | 'poll' | 'fetchResult'>;
  readonly request: NormalizedGenerationRequest;
  readonly clock: Clock;
  readonly sleep: (ms: number) => Promise<void>;
  readonly pollIntervalMs: number;
  /** Budget for the whole run, from submit to the last poll. */
  readonly timeoutMs: number;
  readonly onProgress?: (status: EngineJobStatus) => void;
}

export interface EngineSmokeOutcome {
  readonly engineJobId: string;
  readonly elapsedMs: number;
  readonly results: readonly AceRawAudioResult[];
}

/**
 * Runs health → submit → poll → fetch once.
 *
 * Returns the downloaded audio. Throws `EngineSmokeFailure` naming the stage that
 * failed; an error thrown by the adapter is wrapped with the stage it was thrown in.
 */
export async function runEngineSmoke(options: EngineSmokeOptions): Promise<EngineSmokeOutcome> {
  const { adapter, clock } = options;

  const health = await adapter.healthCheck();
  if (!health.healthy) {
    throw new EngineSmokeFailure('health', health.detail ?? 'engine reported unhealthy');
  }

  const startedAtMs = clock.now().getTime();
  const handle = await atStage('submit', () => adapter.submit(options.request));

  for (;;) {
    const status = await atStage('poll', () => adapter.poll(handle));
    options.onProgress?.(status);
    if (status.state === 1) break;
    if (status.state === 2) {
      throw new EngineSmokeFailure('poll', status.failureReason ?? 'engine reported failure');
    }
    if (clock.now().getTime() - startedAtMs >= options.timeoutMs) {
      throw new EngineSmokeFailure('timeout', `no result after ${String(options.timeoutMs)} ms`);
    }
    await options.sleep(options.pollIntervalMs);
  }

  const results = await atStage('fetch', () => adapter.fetchResult(handle));
  if (results.length === 0) {
    throw new EngineSmokeFailure('fetch', 'engine reported success but named no audio file');
  }
  return {
    engineJobId: handle.engineJobId,
    elapsedMs: clock.now().getTime() - startedAtMs,
    results,
  };
}

export interface SmokeSongInput {
  readonly caption: string;
  readonly durationSeconds: number;
  /** LM "thinking"; off by default here because it is the slow, VRAM-hungry path. */
  readonly thinking: boolean;
}

/**
 * A short instrumental Custom_Mode request, validated by the same rules the gateway uses.
 *
 * Throws when the input breaks a song rule (e.g. a length under the engine minimum),
 * so a smoke run never sends what the product would have refused.
 */
export function smokeSongRequest(input: SmokeSongInput): NormalizedGenerationRequest {
  const validation = validateSongRequest({
    mode: 'custom',
    caption: input.caption,
    instrumental: true,
    durationSeconds: input.durationSeconds,
    thinking: input.thinking,
  });
  if (validation.kind === 'invalid') {
    throw new Error(`smoke request is invalid: ${JSON.stringify(validation)}`);
  }
  return {
    requestId: 'engine-smoke',
    accountId: 'engine-smoke',
    assetKind: 'song',
    inputModality: 'text',
    durationMs: input.durationSeconds * 1000,
    song: validation.parameters,
  };
}

async function atStage<T>(stage: EngineSmokeStage, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error: unknown) {
    if (error instanceof EngineSmokeFailure) throw error;
    throw new EngineSmokeFailure(stage, error instanceof Error ? error.message : String(error));
  }
}
