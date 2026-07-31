import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ACE_PATHS, AceEngineAdapter } from '../../adapters/ace/ace-engine-adapter';
import { hasTrackMetadata } from '../../adapters/ace/raw-result';
import { ENGINE_JOB_STATE } from '../../adapters/engine-job';
import { INSTRUMENTAL_LYRICS } from '../../domain/song/request';
import { ACCEPTED_VOCAL_LANGUAGES } from '../../domain/song/vocal-language';
import { VALID_KEY_SCALES } from '../../domain/song/key-scale';
import { API_PREFIX } from '../../api/gateway/app';
import {
  createGatewayHarness,
  requireGeneration,
  type GatewayHarness,
} from '../support/gateway-harness';
import {
  createScriptedAceTransport,
  type ScriptedAceTransport,
} from '../support/scripted-ace-transport';

/**
 * Simple_Mode and Custom_Mode end to end (Requirements 3, 4).
 *
 * The path under test is the real one: HTTP request -> `SongGateway` validation ->
 * `JobOrchestrator` (routing, moderation gate, credit debit, submit under backoff)
 * -> the production `AceEngineAdapter` -> HTTP. The only substitution is the engine
 * itself, which is a separate deployment (design §1.4.1) and is replaced by a
 * scripted double reproducing its exact wire contract. Nothing here sleeps: time
 * moves only when the harness clock is advanced.
 */

const EMAIL = 'composer@studio.test';
const PASSWORD = 'correct-horse-battery-staple';

let harness: GatewayHarness;
let transport: ScriptedAceTransport;
let accessToken: string;

async function signIn(): Promise<string> {
  await harness.app.inject({
    method: 'POST',
    url: `${API_PREFIX}/auth/register`,
    payload: { email: EMAIL, password: PASSWORD },
  });
  const login = await harness.app.inject({
    method: 'POST',
    url: `${API_PREFIX}/auth/login`,
    payload: { email: EMAIL, password: PASSWORD },
  });
  return login.json<{ accessToken: string }>().accessToken;
}

beforeEach(async () => {
  transport = createScriptedAceTransport();
  harness = createGatewayHarness({
    generation: {
      withSongGateway: true,
      adapter: new AceEngineAdapter({
        // The harness registers its engine under this id, and an adapter's
        // `engineId` must equal the descriptor's.
        engineId: 'ace-step-test',
        transport,
        // The adapter reads the clock only for `submittedAtMs` and health latency,
        // neither of which this test asserts, so a fixed instant keeps it
        // deterministic without needing the harness's own clock.
        clock: { now: () => new Date('2025-05-01T00:00:00.000Z') },
      }),
    },
  });
  accessToken = await signIn();
});

afterEach(async () => {
  await harness.close();
});

function authorised(payload: Readonly<Record<string, unknown>>, url: string) {
  return {
    method: 'POST' as const,
    url: `${API_PREFIX}${url}`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload,
  };
}

describe('Requirement 3 — Simple_Mode end to end', () => {
  it('accepts a one-line description, submits it as sample_mode and completes the song', async () => {
    const response = await harness.app.inject(
      authorised({ description: 'a warm lo-fi piano beat for studying' }, '/songs/simple'),
    );

    // Accepted, with the engine's own task id stored (Requirement 5.1).
    expect(response.statusCode).toBe(202);
    const acceptance = response.json<{ jobId: string; engineJobId: string; queuePosition: number }>();
    expect(acceptance.engineJobId).toBe('ace-task-1');
    expect(acceptance.queuePosition).toBe(1);

    // Requirements 3.1, 3.2, 3.3 on the wire.
    const submitted = transport.onlyRequestTo(ACE_PATHS.releaseTask);
    expect(submitted.body.sample_mode).toBe(true);
    expect(submitted.body.sample_query).toBe('a warm lo-fi piano beat for studying');
    expect(submitted.body.thinking).toBe(true);
    expect(Object.keys(submitted.body)).not.toContain('audio_duration');

    // The engine finishes and reports the metadata it settled on (Requirement 3.4).
    transport.setAudio('/tmp/song-0.mp3', Buffer.from('rendered-song'));
    transport.setDefaultResult({
      statusCode: 1,
      audios: [
        {
          file: '/tmp/song-0.mp3',
          metadata: {
            caption: 'warm lo-fi piano, tape saturation',
            lyrics: '[verse]\nlate night pages',
            bpm: 78,
            keyScale: 'F major',
            timeSignature: 4,
            durationSeconds: 142,
            genres: 'lo-fi',
          },
        },
      ],
    });

    const generation = requireGeneration(harness);
    const poll = await generation.orchestrator.pollOnce(acceptance.jobId);
    expect(poll.kind).toBe('applied');

    const record = await generation.store.find(acceptance.jobId);
    expect(record?.lifecycle.state).toBe('succeeded');
    // Requirement 5.6: one Audio_Asset per produced audio.
    expect(record?.assetIds).toHaveLength(1);

    // Requirement 3.4: the six values are available to whoever stores the Track.
    const results = await generation.registeredAdapter.fetchResult({
      engineId: 'ace-step-test',
      engineJobId: acceptance.engineJobId,
      submittedAtMs: 0,
    });
    const [first] = results;
    expect(first !== undefined && hasTrackMetadata(first)).toBe(true);
    expect(first !== undefined && hasTrackMetadata(first) ? first.trackMetadata : null).toEqual({
      caption: 'warm lo-fi piano, tape saturation',
      lyrics: '[verse]\nlate night pages',
      bpm: 78,
      keyScale: 'F major',
      timeSignature: 4,
      durationSeconds: 142,
      genres: 'lo-fi',
    });
  });

  it('generates a random song from an empty request (Requirement 3.6)', async () => {
    const response = await harness.app.inject(authorised({}, '/songs/simple'));

    expect(response.statusCode).toBe(202);
    const body = transport.onlyRequestTo(ACE_PATHS.releaseTask).body;
    expect(body.sample_mode).toBe(true);
    expect(Object.keys(body)).not.toContain('sample_query');
  });

  it('passes a requested vocal language through as vocal_language (Requirement 3.7)', async () => {
    const response = await harness.app.inject(
      authorised({ description: 'a k-pop chorus', vocalLanguage: 'ko' }, '/songs/simple'),
    );

    expect(response.statusCode).toBe(202);
    expect(transport.onlyRequestTo(ACE_PATHS.releaseTask).body.vocal_language).toBe('ko');
  });

  it('refuses a description outside 1 to 2000 characters with the allowed range (Requirement 3.5)', async () => {
    const response = await harness.app.inject(
      authorised({ description: 'x'.repeat(2_001) }, '/songs/simple'),
    );

    expect(response.statusCode).toBe(400);
    const error = response.json<{
      error: { code: string; violations: { field: string; allowed: unknown }[] };
    }>().error;
    expect(error.code).toBe('song_request_invalid');
    expect(error.violations).toEqual([
      { field: 'description', received: 2_001, allowed: { kind: 'length', minLength: 1, maxLength: 2_000 } },
    ]);
    // Nothing reached the engine.
    expect(transport.jsonRequests).toEqual([]);
  });

  it('refuses an unsupported vocal language and returns the supported list (Requirement 3.8)', async () => {
    const response = await harness.app.inject(
      authorised({ description: 'a ballad', vocalLanguage: 'kr' }, '/songs/simple'),
    );

    expect(response.statusCode).toBe(400);
    const [violation] = response.json<{
      error: { violations: { field: string; allowed: { values: string[] } }[] };
    }>().error.violations;
    expect(violation?.field).toBe('vocalLanguage');
    expect(violation?.allowed.values).toEqual(ACCEPTED_VOCAL_LANGUAGES);
    expect(transport.jsonRequests).toEqual([]);
  });
});

describe('Requirement 4 — Custom_Mode end to end', () => {
  it('submits the caption, full lyrics and every specified metadata field', async () => {
    const lyrics = ['[verse]', 'first line', 'second line', '', '[chorus]', 'hook'].join('\n');
    const response = await harness.app.inject(
      authorised(
        {
          caption: 'driving synthwave, analog bass',
          lyrics,
          bpm: 128,
          keyScale: 'F# minor',
          timeSignature: 4,
          durationSeconds: 180,
          batchSize: 4,
          seed: 20_250_501,
        },
        '/songs/custom',
      ),
    );

    expect(response.statusCode).toBe(202);
    const body = transport.onlyRequestTo(ACE_PATHS.releaseTask).body;
    expect(body).toEqual({
      task_type: 'text2music',
      sample_mode: false,
      thinking: true,
      prompt: 'driving synthwave, analog bass',
      lyrics,
      bpm: 128,
      key_scale: 'F# minor',
      time_signature: '4',
      audio_duration: 180,
      batch_size: 4,
      use_random_seed: false,
      seed: 20_250_501,
    });
  });

  it('leaves only the empty fields to the engine (Requirement 4.7)', async () => {
    const response = await harness.app.inject(
      authorised({ caption: 'bossa nova, brushed drums', bpm: 96 }, '/songs/custom'),
    );

    expect(response.statusCode).toBe(202);
    const body = transport.onlyRequestTo(ACE_PATHS.releaseTask).body;
    expect(body.bpm).toBe(96);
    expect(Object.keys(body)).not.toContain('key_scale');
    expect(Object.keys(body)).not.toContain('time_signature');
    expect(Object.keys(body)).not.toContain('audio_duration');
  });

  it('sends the instrumental indicator in the lyrics field (Requirement 4.9)', async () => {
    const response = await harness.app.inject(
      authorised({ caption: 'post-rock crescendo', instrumental: true }, '/songs/custom'),
    );

    expect(response.statusCode).toBe(202);
    expect(transport.onlyRequestTo(ACE_PATHS.releaseTask).body.lyrics).toBe(INSTRUMENTAL_LYRICS);
  });

  it('charges for the requested batch count (Requirements 2.2, 4.8)', async () => {
    const response = await harness.app.inject(
      authorised({ caption: 'techno', batchSize: 8 }, '/songs/custom'),
    );

    expect(response.statusCode).toBe(202);
    const [charge] = requireGeneration(harness).charges.requests;
    expect(charge?.resultCount).toBe(8);
    expect(transport.onlyRequestTo(ACE_PATHS.releaseTask).body.batch_size).toBe(8);
  });

  it.each([
    { field: 'durationSeconds', payload: { durationSeconds: 601 } },
    { field: 'bpm', payload: { bpm: 301 } },
    { field: 'timeSignature', payload: { timeSignature: 5 } },
    { field: 'keyScale', payload: { keyScale: 'H major' } },
    { field: 'batchSize', payload: { batchSize: 9 } },
  ])(
    'refuses an out-of-range $field, naming the field and its allowed range (Requirement 4.6)',
    async ({ field, payload }) => {
      const response = await harness.app.inject(
        authorised({ caption: 'a song', ...payload }, '/songs/custom'),
      );

      expect(response.statusCode).toBe(400);
      const error = response.json<{
        error: { code: string; violations: { field: string; allowed: unknown }[] };
      }>().error;
      expect(error.code).toBe('song_request_invalid');
      expect(error.violations.map((violation) => violation.field)).toEqual([field]);
      expect(error.violations[0]?.allowed).toBeDefined();
      // Requirements 3.5/3.8/4.6 reject before anything can be charged or submitted.
      expect(transport.jsonRequests).toEqual([]);
      expect(requireGeneration(harness).charges.requests).toEqual([]);
    },
  );

  it('reports every out-of-range field in one response', async () => {
    const response = await harness.app.inject(
      authorised({ caption: 'a song', bpm: 10, timeSignature: 7, durationSeconds: 5 }, '/songs/custom'),
    );

    const fields = response
      .json<{ error: { violations: { field: string }[] } }>()
      .error.violations.map((violation) => violation.field)
      .sort();
    expect(fields).toEqual(['bpm', 'durationSeconds', 'timeSignature']);
  });

  it('accepts every one of the 70 key/scale combinations', async () => {
    for (const keyScale of VALID_KEY_SCALES) {
      const response = await harness.app.inject(
        authorised({ caption: 'a song', keyScale }, '/songs/custom'),
      );
      expect(response.statusCode, keyScale).toBe(202);
    }
    expect(transport.jsonRequests).toHaveLength(VALID_KEY_SCALES.length);
  });

  it('reports an engine that refuses the request as a 422, not a 500 (Requirement 6.1)', async () => {
    const generation = requireGeneration(harness);
    // A 400 is an input error, which Requirement 6.2 does not retry, so the single
    // attempt is the whole story and no scheduler drain is needed.
    transport.failNext(ACE_PATHS.releaseTask, 400, 'invalid request payload');

    const response = await harness.app.inject(authorised({ caption: 'a song' }, '/songs/custom'));

    expect(response.statusCode).toBe(422);
    const error = response.json<{
      error: { code: string; classification: string; retryable: boolean };
    }>().error;
    expect(error.code).toBe('generation_job_failed');
    expect(error.classification).toBe('input_error');
    expect(error.retryable).toBe(false);
    // Requirement 2.4 / 6.3: the debited credits come back.
    expect(generation.refunds.requests).toHaveLength(1);
  });

  it('requires authentication', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: `${API_PREFIX}/songs/custom`,
      payload: { caption: 'a song' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('drops an unknown property at the schema, so it never reaches the engine', async () => {
    // `additionalProperties: false` plus Fastify's default `removeAdditional`
    // strips the field rather than refusing the request. What matters for the
    // engine contract is that nothing unrecognised is forwarded.
    const response = await harness.app.inject(
      authorised({ caption: 'a song', tempo: 120 }, '/songs/custom'),
    );

    expect(response.statusCode).toBe(202);
    expect(Object.keys(transport.onlyRequestTo(ACE_PATHS.releaseTask).body)).not.toContain('tempo');
  });
});

describe('the engine status codes reach the user through the existing mapping', () => {
  it('reports a failed engine status as a failed job with the engine reason', async () => {
    const generation = requireGeneration(harness);
    const accepted = await harness.app.inject(
      authorised({ description: 'a song that will fail' }, '/songs/simple'),
    );
    const { jobId } = accepted.json<{ jobId: string }>();

    transport.setDefaultResult({ statusCode: ENGINE_JOB_STATE.failed, error: 'CUDA out of memory' });
    await generation.orchestrator.pollOnce(jobId);

    const record = await generation.store.find(jobId);
    expect(record?.lifecycle.state).toBe('failed');
    expect(record?.lifecycle.failure?.detail).toContain('CUDA out of memory');
  });

  it('keeps a running engine status running, with its progress', async () => {
    const generation = requireGeneration(harness);
    const accepted = await harness.app.inject(authorised({ description: 'a long song' }, '/songs/simple'));
    const { jobId } = accepted.json<{ jobId: string }>();

    transport.setDefaultResult({ statusCode: ENGINE_JOB_STATE.running, progress: 0.6 });
    await generation.orchestrator.pollOnce(jobId);

    const record = await generation.store.find(jobId);
    expect(record?.lifecycle.state).toBe('running');
    expect(record?.progressPercent).toBe(60);
  });
});
