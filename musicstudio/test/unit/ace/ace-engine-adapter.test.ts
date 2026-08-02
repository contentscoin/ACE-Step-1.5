import { describe, expect, it } from 'vitest';

import { ACE_PATHS, AceEngineAdapter } from '../../../adapters/ace/ace-engine-adapter';
import type { EngineAdapter } from '../../../adapters/engine-adapter';
import { isAceEngineError } from '../../../adapters/ace/errors';
import { hasTrackMetadata } from '../../../adapters/ace/raw-result';
import { ENGINE_JOB_STATE, type EngineJobHandle } from '../../../adapters/engine-job';
import type { NormalizedGenerationRequest } from '../../../adapters/normalized-generation';
import { normalizeEngineResult, SEED_UNSPECIFIED } from '../../../adapters/normalized-generation';
import { ACE_ENGINE_SAMPLE_RATE } from '../../../domain/song/engine-bounds';
import { CANONICAL_SAMPLE_RATE } from '../../../domain/provenance';
import { validateSongRequest } from '../../../domain/song/validation';
import { USER_VISIBLE_STATE_FOR_ENGINE_STATE } from '../../../services/generation/engine-status';
import { createMutableClock } from '../../support/mutable-clock';
import {
  createScriptedAceTransport,
  type ScriptedAceTransport,
} from '../../support/scripted-ace-transport';

/**
 * ACE_Engine_Adapter over a scripted HTTP double (Requirements 3.1, 3.4, 5.3).
 *
 * The engine is a separate deployment and is not running here, so the double
 * reproduces its envelope, its JSON-string `result` field and its nested per-audio
 * item shape exactly. Both directions are therefore covered: the request the
 * adapter builds and the response it decodes.
 */

const ENGINE_ID = 'ace-step-1.5';

function createAdapter(transport: ScriptedAceTransport): AceEngineAdapter {
  return new AceEngineAdapter({
    engineId: ENGINE_ID,
    transport,
    clock: createMutableClock(new Date('2025-05-01T00:00:00.000Z')),
  });
}

function songRequest(overrides: Partial<NormalizedGenerationRequest> = {}): NormalizedGenerationRequest {
  const validation = validateSongRequest({ mode: 'simple', description: 'a calm piano piece' });
  if (validation.kind === 'invalid') throw new Error('fixture request must be valid');

  return {
    requestId: 'req-1',
    accountId: 'user-1',
    assetKind: 'song',
    inputModality: 'text',
    durationMs: 120_000,
    song: validation.parameters,
    ...overrides,
  };
}

function handleFor(engineJobId: string): EngineJobHandle {
  return { engineId: ENGINE_ID, engineJobId, submittedAtMs: 0 };
}

describe('submit', () => {
  it('posts the built payload to /release_task and returns the engine task id', async () => {
    const transport = createScriptedAceTransport();
    transport.setTaskId('task-abc', 3);

    const handle = await createAdapter(transport).submit(songRequest());

    expect(handle).toEqual({
      engineId: ENGINE_ID,
      engineJobId: 'task-abc',
      submittedAtMs: new Date('2025-05-01T00:00:00.000Z').getTime(),
    });
    const posted = transport.onlyRequestTo(ACE_PATHS.releaseTask);
    expect(posted.body.sample_mode).toBe(true);
    expect(posted.body.sample_query).toBe('a calm piano piece');
  });

  it('translates a request that carries no song block into a Simple_Mode submission', async () => {
    const transport = createScriptedAceTransport();
    const generic: NormalizedGenerationRequest = {
      requestId: 'req-2',
      accountId: 'user-1',
      assetKind: 'song',
      inputModality: 'text',
      durationMs: 90_000,
      prompt: 'a marching band fanfare',
      seed: 11,
    };

    await createAdapter(transport).submit(generic);

    const body = transport.onlyRequestTo(ACE_PATHS.releaseTask).body;
    expect(body.sample_mode).toBe(true);
    expect(body.sample_query).toBe('a marching band fanfare');
    expect(body.audio_duration).toBe(90);
    expect(body.use_random_seed).toBe(false);
    expect(body.seed).toBe(11);
  });

  it('preserves the engine HTTP status when the engine refuses, so the backoff can key on it', async () => {
    const transport = createScriptedAceTransport();
    // `release_task_route.py` answers 429 "Server busy: queue is full".
    transport.failNext(ACE_PATHS.releaseTask, 429, 'Server busy: queue is full');

    const error: unknown = await createAdapter(transport)
      .submit(songRequest())
      .catch((thrown: unknown) => thrown);

    expect(isAceEngineError(error)).toBe(true);
    expect(isAceEngineError(error) ? error.statusCode : null).toBe(429);
  });

  it('treats an error reported inside a 200 envelope as a failure', async () => {
    const transport: ScriptedAceTransport = createScriptedAceTransport();
    const failing: ScriptedAceTransport = {
      ...transport,
      postJson: async () => ({
        httpStatus: 200,
        envelope: { data: null, code: 500, error: 'model not initialized' },
      }),
    };

    const error: unknown = await createAdapter(failing)
      .submit(songRequest())
      .catch((thrown: unknown) => thrown);

    expect(isAceEngineError(error) ? error.code : null).toBe('ace_engine_application_error');
  });
});

describe('Requirement 5.3 — poll reports the engine status untranslated', () => {
  it('reports 0 as running with the engine progress as a percentage', async () => {
    const transport = createScriptedAceTransport();
    transport.enqueueResult({ statusCode: 0, progress: 0.4, progressText: 'diffusion step 12' });

    const status = await createAdapter(transport).poll(handleFor('task-abc'));

    expect(status.state).toBe(ENGINE_JOB_STATE.running);
    expect(status.progressPercent).toBe(40);
    expect(USER_VISIBLE_STATE_FOR_ENGINE_STATE[status.state]).toBe('running');
  });

  it('reports 1 as succeeded', async () => {
    const transport = createScriptedAceTransport();
    transport.enqueueResult({ statusCode: 1, audios: [{ file: '/tmp/a.mp3' }] });

    const status = await createAdapter(transport).poll(handleFor('task-abc'));

    expect(status.state).toBe(ENGINE_JOB_STATE.succeeded);
    expect(USER_VISIBLE_STATE_FOR_ENGINE_STATE[status.state]).toBe('succeeded');
  });

  it('reports 2 as failed and carries the engine reason', async () => {
    const transport = createScriptedAceTransport();
    transport.enqueueResult({ statusCode: 2, error: 'CUDA out of memory' });

    const status = await createAdapter(transport).poll(handleFor('task-abc'));

    expect(status.state).toBe(ENGINE_JOB_STATE.failed);
    expect(status.failureReason).toBe('CUDA out of memory');
    expect(USER_VISIBLE_STATE_FOR_ENGINE_STATE[status.state]).toBe('failed');
  });

  it('asks about exactly the polled task', async () => {
    const transport = createScriptedAceTransport();
    await createAdapter(transport).poll(handleFor('task-xyz'));

    expect(transport.onlyRequestTo(ACE_PATHS.queryResult).body).toEqual({
      task_id_list: ['task-xyz'],
    });
  });

  it('fails when the engine does not know the task', async () => {
    const transport: ScriptedAceTransport = createScriptedAceTransport();
    const empty: ScriptedAceTransport = {
      ...transport,
      postJson: async () => ({ httpStatus: 200, envelope: { data: [], code: 200, error: null } }),
    };

    const error: unknown = await createAdapter(empty)
      .poll(handleFor('task-gone'))
      .catch((thrown: unknown) => thrown);

    expect(isAceEngineError(error) ? error.code : null).toBe('ace_engine_task_unknown');
  });
});

describe('Requirement 3.4 — fetchResult carries the metadata the engine finally used', () => {
  it('downloads each audio and attaches caption, lyrics, BPM, key, time signature and length', async () => {
    const transport = createScriptedAceTransport();
    transport.setAudio('/tmp/out-0.mp3', Buffer.from('first-audio'));
    transport.setAudio('/tmp/out-1.mp3', Buffer.from('second-audio'));
    transport.enqueueResult({
      statusCode: 1,
      audios: [
        {
          file: '/tmp/out-0.mp3',
          metadata: {
            caption: 'warm lo-fi piano, vinyl crackle',
            lyrics: '[verse]\nrain on the window',
            bpm: 82,
            keyScale: 'D minor',
            timeSignature: 4,
            durationSeconds: 137.5,
            genres: 'lo-fi, chillhop',
          },
        },
        { file: '/tmp/out-1.mp3', metadata: { caption: 'variation two', bpm: 82 } },
      ],
    });

    const results = await createAdapter(transport).fetchResult(handleFor('task-abc'));

    expect(results).toHaveLength(2);
    const [first, second] = results;
    expect(first?.audioBuffer.toString()).toBe('first-audio');
    expect(first?.durationMs).toBe(137_500);
    expect(first?.sampleRate).toBe(ACE_ENGINE_SAMPLE_RATE);
    expect(first?.trackMetadata).toEqual({
      caption: 'warm lo-fi piano, vinyl crackle',
      lyrics: '[verse]\nrain on the window',
      bpm: 82,
      keyScale: 'D minor',
      timeSignature: 4,
      durationSeconds: 137.5,
      genres: 'lo-fi, chillhop',
    });
    expect(second?.trackMetadata.keyScale).toBeNull();
    expect(transport.binaryRequests.map((request) => request.query.path)).toEqual([
      '/tmp/out-0.mp3',
      '/tmp/out-1.mp3',
    ]);
  });

  it('reports no seed, because /query_result drops the engine seed_value', async () => {
    const transport = createScriptedAceTransport();
    transport.setAudio('/tmp/out.mp3', Buffer.from('audio'));
    transport.enqueueResult({ statusCode: 1, audios: [{ file: '/tmp/out.mp3' }] });

    const [result] = await createAdapter(transport).fetchResult(handleFor('task-abc'));

    expect(result?.seed).toBeNull();
    // Design §3.5: an unreported seed becomes the fixed sentinel once normalised.
    const normalized = normalizeEngineResult({
      assetKind: 'song',
      engineId: ENGINE_ID,
      jobState: ENGINE_JOB_STATE.succeeded,
      raw: result as NonNullable<typeof result>,
    });
    expect(normalized.seed).toBe(SEED_UNSPECIFIED);
    expect(normalized.sampleRate).toBe(CANONICAL_SAMPLE_RATE);
    expect(normalized.originalSampleRate).toBe(ACE_ENGINE_SAMPLE_RATE);
  });

  it('returns nothing while the engine has produced no file yet', async () => {
    const transport = createScriptedAceTransport();
    transport.enqueueResult({ statusCode: 0, progress: 0.1 });

    expect(await createAdapter(transport).fetchResult(handleFor('task-abc'))).toEqual([]);
  });

  it('fails when a produced file cannot be downloaded', async () => {
    const transport = createScriptedAceTransport();
    transport.enqueueResult({ statusCode: 1, audios: [{ file: '/tmp/missing.mp3' }] });

    const error: unknown = await createAdapter(transport)
      .fetchResult(handleFor('task-abc'))
      .catch((thrown: unknown) => thrown);

    expect(isAceEngineError(error) ? error.code : null).toBe('ace_engine_malformed_response');
  });

  it('is still a RawAudioResult, so an interface-typed caller is unaffected', async () => {
    const transport = createScriptedAceTransport();
    transport.setAudio('/tmp/out.mp3', Buffer.from('audio'));
    transport.enqueueResult({ statusCode: 1, audios: [{ file: '/tmp/out.mp3' }] });

    const [result] = await createAdapter(transport).fetchResult(handleFor('task-abc'));

    expect(result !== undefined && hasTrackMetadata(result)).toBe(true);
  });
});

describe('healthCheck', () => {
  it('is healthy when the engine reports status ok', async () => {
    const transport = createScriptedAceTransport();

    const result = await createAdapter(transport).healthCheck();

    expect(result.healthy).toBe(true);
    expect(transport.onlyRequestTo(ACE_PATHS.health)).toBeDefined();
  });

  it('is unhealthy, rather than throwing, when the engine reports anything else', async () => {
    const transport = createScriptedAceTransport();
    transport.setHealthy(false);

    const result = await createAdapter(transport).healthCheck();

    expect(result.healthy).toBe(false);
    expect(result.detail).toContain('degraded');
  });

  it('is unhealthy when the engine cannot be reached at all', async () => {
    const transport: ScriptedAceTransport = createScriptedAceTransport();
    const unreachable: ScriptedAceTransport = {
      ...transport,
      postJson: () => Promise.reject(new Error('ECONNREFUSED')),
    };

    const result = await createAdapter(unreachable).healthCheck();

    expect(result.healthy).toBe(false);
    expect(result.detail).toBe('ECONNREFUSED');
  });
});

describe('cancel', () => {
  it('makes no engine call, because ACE-Step exposes no cancellation route', async () => {
    const transport = createScriptedAceTransport();

    // `EngineAdapter.cancel` takes a handle; the ACE adapter ignores it, and the
    // call is made through the interface type so the contract stays checked.
    const adapter: EngineAdapter = createAdapter(transport);
    await adapter.cancel(handleFor('task-abc'));

    expect(transport.jsonRequests).toEqual([]);
    expect(transport.binaryRequests).toEqual([]);
  });
});
