import { describe, expect, it } from 'vitest';

import { AceEngineAdapter } from '../../../adapters/ace/ace-engine-adapter';
import {
  EngineSmokeFailure,
  runEngineSmoke,
  smokeSongRequest,
  type EngineSmokeOptions,
} from '../../../adapters/ace/engine-smoke';
import { createMutableClock } from '../../support/mutable-clock';
import {
  createScriptedAceTransport,
  type ScriptedAceTransport,
} from '../../support/scripted-ace-transport';

/**
 * `runEngineSmoke` over the scripted engine: the real adapter, scripted answers, and a
 * `sleep` that moves a fake clock instead of waiting.
 */

const REQUEST = smokeSongRequest({ caption: 'calm piano', durationSeconds: 10, thinking: false });

function optionsFor(
  transport: ScriptedAceTransport,
  overrides: Partial<EngineSmokeOptions> = {},
): EngineSmokeOptions {
  const clock = createMutableClock(new Date('2026-01-01T00:00:00.000Z'));
  return {
    adapter: new AceEngineAdapter({ engineId: 'ace-step-smoke', transport, clock }),
    request: REQUEST,
    clock,
    sleep: async (ms) => {
      clock.advanceSeconds(ms / 1000);
    },
    pollIntervalMs: 2_000,
    timeoutMs: 60_000,
    ...overrides,
  };
}

async function failureOf(options: EngineSmokeOptions): Promise<EngineSmokeFailure> {
  const error: unknown = await runEngineSmoke(options).catch((thrown: unknown) => thrown);
  if (!(error instanceof EngineSmokeFailure)) throw new Error(`expected a failure, got ${String(error)}`);
  return error;
}

describe('runEngineSmoke', () => {
  it('polls until the engine succeeds and returns the downloaded audio', async () => {
    const transport = createScriptedAceTransport();
    transport.setTaskId('task-smoke');
    transport.setAudio('/tmp/api_audio/smoke.flac', Buffer.from('flac-bytes'));
    transport.enqueueResult(
      { statusCode: 0, progress: 0.3 },
      { statusCode: 0, progress: 0.8 },
      { statusCode: 1, audios: [{ file: '/tmp/api_audio/smoke.flac', metadata: { bpm: 90 } }] },
      // `fetchResult` queries once more after the poll loop sees success.
      { statusCode: 1, audios: [{ file: '/tmp/api_audio/smoke.flac', metadata: { bpm: 90 } }] },
    );
    const seen: (number | undefined)[] = [];

    const outcome = await runEngineSmoke(
      optionsFor(transport, { onProgress: (status) => seen.push(status.progressPercent) }),
    );

    expect(outcome.engineJobId).toBe('task-smoke');
    expect(outcome.results.map((result) => result.audioBuffer.toString())).toEqual(['flac-bytes']);
    expect(outcome.results[0]?.trackMetadata.bpm).toBe(90);
    expect(seen).toEqual([30, 80, undefined]);
    // Two sleeps between three polls.
    expect(outcome.elapsedMs).toBe(4_000);
    // The run asks for what the product stores: lossless, instrumental, the given length.
    const body = transport.onlyRequestTo('/release_task').body;
    expect(body.audio_format).toBe('flac');
    expect(body.audio_duration).toBe(10);
    expect(body.thinking).toBe(false);
  });

  it('stops at health when the engine is not healthy, before submitting anything', async () => {
    const transport = createScriptedAceTransport();
    transport.setHealthy(false);

    const failure = await failureOf(optionsFor(transport));

    expect(failure.stage).toBe('health');
    expect(transport.lastRequestTo('/release_task')).toBeUndefined();
  });

  it('names submit when the engine refuses the task', async () => {
    const transport = createScriptedAceTransport();
    transport.failNext('/release_task', 429, 'Server busy: queue is full');

    expect((await failureOf(optionsFor(transport))).stage).toBe('submit');
  });

  it('carries the engine reason when the task fails', async () => {
    const transport = createScriptedAceTransport();
    transport.enqueueResult({ statusCode: 2, error: 'CUDA out of memory' });

    const failure = await failureOf(optionsFor(transport));

    expect(failure.stage).toBe('poll');
    expect(failure.message).toContain('CUDA out of memory');
  });

  it('gives up with timeout once the budget is spent', async () => {
    const transport = createScriptedAceTransport();
    transport.setDefaultResult({ statusCode: 0, progress: 0.1 });

    const failure = await failureOf(optionsFor(transport, { timeoutMs: 10_000 }));

    expect(failure.stage).toBe('timeout');
  });

  it('refuses a success that names no audio', async () => {
    const transport = createScriptedAceTransport();
    transport.setDefaultResult({ statusCode: 1 });

    expect((await failureOf(optionsFor(transport))).stage).toBe('fetch');
  });
});

describe('smokeSongRequest', () => {
  it('builds a validated instrumental Custom_Mode song', () => {
    expect(REQUEST.song).toMatchObject({
      mode: 'custom',
      instrumental: true,
      durationSeconds: 10,
      thinking: false,
    });
    expect(REQUEST.durationMs).toBe(10_000);
  });

  it('refuses a length the product would refuse', () => {
    expect(() =>
      smokeSongRequest({ caption: 'too short', durationSeconds: 3, thinking: false }),
    ).toThrow('smoke request is invalid');
  });
});
