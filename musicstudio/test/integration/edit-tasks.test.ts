import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ACE_PATHS, AceEngineAdapter } from '../../adapters/ace/ace-engine-adapter';
import { API_PREFIX } from '../../api/gateway/app';
import { EDIT_KINDS, type EditKind } from '../../domain/edit/edit-kind';
import { SOURCE_AUDIO_FORMATS, SOURCE_AUDIO_MAX_BYTES } from '../../domain/edit/source-audio';
import { TRACK_NAMES } from '../../domain/edit/track-name';
import {
  BASE_DIT_MODEL,
  TURBO_DIT_MODEL,
  VALID_SOURCE_AUDIO,
} from '../support/edit-harness';
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
 * Edit_Tasks end to end (Requirement 7).
 *
 * The path under test is the real one: HTTP request -> `EditGateway` validation ->
 * `JobOrchestrator` (routing, moderation gate, credit debit, submit under backoff) ->
 * the production `AceEngineAdapter` -> HTTP, then poll -> asset publication ->
 * Requirement 7.12 lineage. The only substitutions are the engine, which is a separate
 * deployment (design §1.4.1) and is replaced by a scripted double reproducing its wire
 * contract, and the Library_Service, which is task 5.1 and is replaced by the two
 * narrow ports the gateway declares. Nothing sleeps.
 *
 * The task's acceptance criterion — request, result stored, lineage recorded, for each
 * of the five kinds — is the `describe` block at the bottom.
 */

const EMAIL = 'editor@studio.test';
const PASSWORD = 'correct-horse-battery-staple';

let harness: GatewayHarness;
let transport: ScriptedAceTransport;
let accessToken: string;

beforeEach(async () => {
  transport = createScriptedAceTransport();
  harness = createGatewayHarness({
    generation: {
      withEditGateway: true,
      adapter: new AceEngineAdapter({
        engineId: 'ace-step-test',
        transport,
        clock: { now: () => new Date('2025-05-01T00:00:00.000Z') },
      }),
    },
  });

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
  accessToken = login.json<{ accessToken: string }>().accessToken;
});

afterEach(async () => {
  await harness.close();
});

function post(url: string, payload: Readonly<Record<string, unknown>>) {
  return harness.app.inject({
    method: 'POST',
    url: `${API_PREFIX}${url}`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload,
  });
}

/** The body shape every edit endpoint shares. */
const SOURCE = { sourceAssetId: VALID_SOURCE_AUDIO.assetId };

interface ErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly violations?: readonly { readonly field: string; readonly allowed: unknown }[];
    readonly styleViolations?: readonly { readonly field: string }[];
    readonly supportedBy?: readonly string[];
    readonly selectedModel?: string;
    readonly editKind?: string;
  };
}

describe('Requirement 7.1 / 7.2 — cover', () => {
  it('submits task_type=cover with the source audio and the new style', async () => {
    const response = await post('/edits/cover', {
      ...SOURCE,
      style: { caption: 'acoustic, brushed drums' },
    });

    expect(response.statusCode).toBe(202);
    const body = transport.onlyRequestTo(ACE_PATHS.releaseTask).body;
    expect(body.task_type).toBe('cover');
    expect(body.src_audio_path).toBe(VALID_SOURCE_AUDIO.enginePath);
    expect(body.prompt).toBe('acoustic, brushed drums');
  });

  it('passes a validated strength as audio_cover_strength (Requirement 7.2)', async () => {
    const response = await post('/edits/cover', { ...SOURCE, coverStrength: 0.4 });

    expect(response.statusCode).toBe(202);
    expect(transport.onlyRequestTo(ACE_PATHS.releaseTask).body.audio_cover_strength).toBe(0.4);
  });

  it('refuses a strength outside 0.0..1.0 with the allowed range, submitting nothing', async () => {
    const response = await post('/edits/cover', { ...SOURCE, coverStrength: 1.5 });

    expect(response.statusCode).toBe(400);
    const { error } = response.json<ErrorBody>();
    expect(error.code).toBe('edit_request_invalid');
    expect(error.violations).toEqual([
      {
        field: 'coverStrength',
        received: 1.5,
        allowed: { kind: 'range', min: 0, max: 1, integer: false },
      },
    ]);
    expect(transport.jsonRequests).toEqual([]);
    expect(requireGeneration(harness).charges.requests).toEqual([]);
  });
});

describe('Requirement 7.3 / 7.4 / 7.5 — repaint', () => {
  it('submits the interval as repainting_start and repainting_end', async () => {
    const response = await post('/edits/repaint', {
      ...SOURCE,
      repaintStartSeconds: 40,
      repaintEndSeconds: 75.5,
    });

    expect(response.statusCode).toBe(202);
    const body = transport.onlyRequestTo(ACE_PATHS.releaseTask).body;
    expect(body.task_type).toBe('repaint');
    expect(body.repainting_start).toBe(40);
    expect(body.repainting_end).toBe(75.5);
  });

  it('reports no adjustment for an interval that already fits', async () => {
    const response = await post('/edits/repaint', {
      ...SOURCE,
      repaintStartSeconds: 40,
      repaintEndSeconds: 75.5,
    });

    expect(response.json<{ adjustments: unknown[] }>().adjustments).toEqual([]);
  });

  it('refuses start >= end with the ordering violation (Requirement 7.4)', async () => {
    const response = await post('/edits/repaint', {
      ...SOURCE,
      repaintStartSeconds: 90,
      repaintEndSeconds: 30,
    });

    expect(response.statusCode).toBe(400);
    const { error } = response.json<ErrorBody>();
    expect(error.code).toBe('edit_request_invalid');
    expect(error.violations?.[0]?.allowed).toEqual({
      kind: 'ordering',
      before: 'repaintStartSeconds',
      after: 'repaintEndSeconds',
    });
    expect(transport.jsonRequests).toEqual([]);
  });

  it('clamps an end past the source length and reports the adjustment (Requirement 7.5)', async () => {
    const response = await post('/edits/repaint', {
      ...SOURCE,
      repaintStartSeconds: 100,
      repaintEndSeconds: 900,
    });

    // Not a rejection: the request proceeds with the adjusted end.
    expect(response.statusCode).toBe(202);
    expect(response.json<{ adjustments: unknown[] }>().adjustments).toEqual([
      {
        field: 'repaintEndSeconds',
        requested: 900,
        applied: VALID_SOURCE_AUDIO.durationSeconds,
        reason: 'clamped_to_source_length',
      },
    ]);
    expect(transport.onlyRequestTo(ACE_PATHS.releaseTask).body.repainting_end).toBe(
      VALID_SOURCE_AUDIO.durationSeconds,
    );
  });
});

describe('Requirement 7.6 / 7.7 — extract and lego', () => {
  it('submits task_type=extract with one of the twelve track names', async () => {
    const response = await post('/edits/extract', {
      ...SOURCE,
      model: BASE_DIT_MODEL,
      trackName: 'vocals',
    });

    expect(response.statusCode).toBe(202);
    const body = transport.onlyRequestTo(ACE_PATHS.releaseTask).body;
    expect(body.task_type).toBe('extract');
    expect(body.track_name).toBe('vocals');
  });

  it('accepts every one of the twelve track names for extract', async () => {
    for (const trackName of TRACK_NAMES) {
      const response = await post('/edits/extract', {
        ...SOURCE,
        model: BASE_DIT_MODEL,
        trackName,
      });
      expect(response.statusCode, trackName).toBe(202);
    }
    expect(transport.jsonRequests).toHaveLength(TRACK_NAMES.length);
  });

  it('submits task_type=lego with the track to add', async () => {
    const response = await post('/edits/lego', {
      ...SOURCE,
      model: BASE_DIT_MODEL,
      trackName: 'strings',
    });

    expect(response.statusCode).toBe(202);
    const body = transport.onlyRequestTo(ACE_PATHS.releaseTask).body;
    expect(body.task_type).toBe('lego');
    expect(body.track_name).toBe('strings');
  });

  it('refuses a track name outside the twelve at the schema, before the gateway', async () => {
    const response = await post('/edits/extract', {
      ...SOURCE,
      model: BASE_DIT_MODEL,
      trackName: 'harmonica',
    });

    expect(response.statusCode).toBe(400);
    expect(transport.jsonRequests).toEqual([]);
  });
});

describe('Requirement 7.8 — complete', () => {
  it('submits task_type=complete with the audio', async () => {
    const response = await post('/edits/complete', { ...SOURCE, model: BASE_DIT_MODEL });

    expect(response.statusCode).toBe(202);
    const body = transport.onlyRequestTo(ACE_PATHS.releaseTask).body;
    expect(body.task_type).toBe('complete');
    expect(body.src_audio_path).toBe(VALID_SOURCE_AUDIO.enginePath);
  });
});

describe('Requirement 7.9 — an Edit_Task the selected model does not support', () => {
  it.each([
    { url: '/edits/extract', payload: { trackName: 'drums' }, kind: 'extract' },
    { url: '/edits/lego', payload: { trackName: 'drums' }, kind: 'lego' },
    { url: '/edits/complete', payload: {}, kind: 'complete' },
  ])('refuses $kind on the turbo model and lists the models that do', async ({ url, payload, kind }) => {
    const response = await post(url, { ...SOURCE, model: TURBO_DIT_MODEL, ...payload });

    expect(response.statusCode).toBe(409);
    const { error } = response.json<ErrorBody>();
    expect(error.code).toBe('edit_task_unsupported');
    expect(error.editKind).toBe(kind);
    expect(error.selectedModel).toBe(TURBO_DIT_MODEL);
    expect(error.supportedBy).toEqual(['acestep-v15-base', 'acestep-v15-sft']);
    expect(error.message).toContain('acestep-v15-base');
    // Nothing was submitted and nothing was charged.
    expect(transport.jsonRequests).toEqual([]);
    expect(requireGeneration(harness).charges.requests).toEqual([]);
  });

  it('accepts cover and repaint on the same turbo model', async () => {
    expect((await post('/edits/cover', { ...SOURCE, model: TURBO_DIT_MODEL })).statusCode).toBe(202);
    expect(
      (
        await post('/edits/repaint', {
          ...SOURCE,
          model: TURBO_DIT_MODEL,
          repaintStartSeconds: 1,
          repaintEndSeconds: 2,
        })
      ).statusCode,
    ).toBe(202);
  });
});

describe('Requirements 7.10 / 7.11 — the source audio is validated', () => {
  it.each([...SOURCE_AUDIO_FORMATS])('accepts a %s source', async (format) => {
    harness.generation?.sourceAudio.set({ ...VALID_SOURCE_AUDIO, format });

    expect((await post('/edits/cover', SOURCE)).statusCode).toBe(202);
  });

  it('refuses an unsupported format, returning the three allowed ones', async () => {
    harness.generation?.sourceAudio.set({ ...VALID_SOURCE_AUDIO, format: 'ogg' });

    const response = await post('/edits/cover', SOURCE);

    expect(response.statusCode).toBe(400);
    const { error } = response.json<ErrorBody>();
    expect(error.violations).toEqual([
      {
        field: 'sourceAudio.format',
        received: 'ogg',
        allowed: { kind: 'enum', values: [...SOURCE_AUDIO_FORMATS] },
      },
    ]);
    expect(transport.jsonRequests).toEqual([]);
  });

  it('refuses audio longer than 600 seconds, returning the limit', async () => {
    harness.generation?.sourceAudio.set({ ...VALID_SOURCE_AUDIO, durationSeconds: 601 });

    const response = await post('/edits/cover', SOURCE);

    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorBody>().error.violations?.[0]).toEqual({
      field: 'sourceAudio.durationSeconds',
      received: 601,
      allowed: { kind: 'range', min: 0, max: 600, integer: false },
    });
  });

  it('refuses audio larger than 50 MB, returning the limit in bytes', async () => {
    harness.generation?.sourceAudio.set({
      ...VALID_SOURCE_AUDIO,
      sizeBytes: SOURCE_AUDIO_MAX_BYTES + 1,
    });

    const response = await post('/edits/cover', SOURCE);

    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorBody>().error.violations?.[0]).toEqual({
      field: 'sourceAudio.sizeBytes',
      received: SOURCE_AUDIO_MAX_BYTES + 1,
      allowed: { kind: 'bytes', maxBytes: SOURCE_AUDIO_MAX_BYTES },
    });
  });

  it('reports every violated upload constraint in one response', async () => {
    harness.generation?.sourceAudio.set({
      ...VALID_SOURCE_AUDIO,
      format: 'aac',
      durationSeconds: 900,
      sizeBytes: SOURCE_AUDIO_MAX_BYTES * 3,
    });

    const response = await post('/edits/cover', SOURCE);

    expect(response.json<ErrorBody>().error.violations?.map((v) => v.field)).toEqual([
      'sourceAudio.format',
      'sourceAudio.durationSeconds',
      'sourceAudio.sizeBytes',
    ]);
  });

  it('reports an unknown source asset as a 404 rather than a validation failure', async () => {
    const response = await post('/edits/cover', { sourceAssetId: 'asset-nobody-owns' });

    expect(response.statusCode).toBe(404);
    expect(response.json<ErrorBody>().error.code).toBe('edit_source_asset_not_found');
  });

  it('resolves the source audio for the calling account only', async () => {
    await post('/edits/cover', SOURCE);

    const [query] = harness.generation?.sourceAudio.queries ?? [];
    expect(query?.assetId).toBe(VALID_SOURCE_AUDIO.assetId);
    expect(query?.accountId).toBeTruthy();
  });
});

describe('Requirement 7.12 — an Edit_Task result stores its source and edit kind as lineage', () => {
  it.each([
    { kind: 'cover', url: '/edits/cover', payload: {}, assetKind: 'song' },
    {
      kind: 'repaint',
      url: '/edits/repaint',
      payload: { repaintStartSeconds: 10, repaintEndSeconds: 40 },
      assetKind: 'song',
    },
    {
      kind: 'extract',
      url: '/edits/extract',
      payload: { model: BASE_DIT_MODEL, trackName: 'drums' },
      assetKind: 'stem',
    },
    {
      kind: 'lego',
      url: '/edits/lego',
      payload: { model: BASE_DIT_MODEL, trackName: 'brass' },
      assetKind: 'song',
    },
    { kind: 'complete', url: '/edits/complete', payload: { model: BASE_DIT_MODEL }, assetKind: 'song' },
  ])(
    'request -> result stored -> lineage recorded for $kind',
    async ({ kind, url, payload, assetKind }) => {
      const generation = requireGeneration(harness);

      // Request.
      const accepted = await post(url, { ...SOURCE, ...payload });
      expect(accepted.statusCode).toBe(202);
      const { jobId, engineJobId } = accepted.json<{ jobId: string; engineJobId: string }>();
      expect(transport.onlyRequestTo(ACE_PATHS.releaseTask).body.task_type).toBe(kind);

      // The engine finishes and produces one audio.
      transport.setAudio('/tmp/edited-0.mp3', Buffer.from(`edited-${kind}`));
      transport.setDefaultResult({
        statusCode: 1,
        audios: [{ file: '/tmp/edited-0.mp3', metadata: { durationSeconds: 200 } }],
      });
      const poll = await generation.orchestrator.pollOnce(jobId);
      expect(poll.kind).toBe('applied');

      // Result stored.
      const record = await generation.store.find(jobId);
      expect(record?.lifecycle.state).toBe('succeeded');
      expect(record?.input.assetKind).toBe(assetKind);
      expect(record?.assetIds).toHaveLength(1);
      const [producedAssetId] = record?.assetIds ?? [];
      expect(engineJobId).toBe('ace-task-1');

      // Lineage recorded: the source asset id and the edit kind.
      expect(generation.lineage.edges).toEqual([
        {
          childAssetId: producedAssetId,
          parentAssetId: VALID_SOURCE_AUDIO.assetId,
          derivationType: kind,
        },
      ]);
    },
  );

  it('records one edge per produced asset for a batched edit', async () => {
    const generation = requireGeneration(harness);
    const accepted = await post('/edits/cover', { ...SOURCE, style: { batchSize: 3 } });
    const { jobId } = accepted.json<{ jobId: string }>();

    expect(transport.onlyRequestTo(ACE_PATHS.releaseTask).body.batch_size).toBe(3);

    for (const index of [0, 1, 2]) {
      transport.setAudio(`/tmp/edited-${String(index)}.mp3`, Buffer.from('edited'));
    }
    transport.setDefaultResult({
      statusCode: 1,
      audios: [0, 1, 2].map((index) => ({ file: `/tmp/edited-${String(index)}.mp3` })),
    });
    await generation.orchestrator.pollOnce(jobId);

    const record = await generation.store.find(jobId);
    expect(record?.assetIds).toHaveLength(3);
    expect(generation.lineage.edges).toHaveLength(3);
    expect(new Set(generation.lineage.edges.map((edge) => edge.parentAssetId))).toEqual(
      new Set([VALID_SOURCE_AUDIO.assetId]),
    );
  });

  it('names the source asset as a job input, so a retry keeps the same parent', async () => {
    const generation = requireGeneration(harness);
    const { jobId } = (await post('/edits/cover', SOURCE)).json<{ jobId: string }>();

    const record = await generation.store.find(jobId);
    expect(record?.input.inputAssetIds).toEqual([VALID_SOURCE_AUDIO.assetId]);
    expect(record?.input.edit?.kind).toBe('cover');
    expect(record?.input.edit?.source.assetId).toBe(VALID_SOURCE_AUDIO.assetId);
  });
});

describe('the edit endpoints reuse the lifecycle, credit and auth machinery', () => {
  it('requires authentication', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: `${API_PREFIX}/edits/cover`,
      payload: SOURCE,
    });

    expect(response.statusCode).toBe(401);
  });

  it('charges for the source length rather than a reserved output length', async () => {
    await post('/edits/cover', SOURCE);

    const [charge] = requireGeneration(harness).charges.requests;
    expect(charge?.durationMs).toBe(VALID_SOURCE_AUDIO.durationSeconds * 1_000);
  });

  it('reports an engine that refuses the edit as a 422 and refunds (Requirement 6.1)', async () => {
    const generation = requireGeneration(harness);
    transport.failNext(ACE_PATHS.releaseTask, 400, 'invalid request payload');

    const response = await post('/edits/cover', SOURCE);

    expect(response.statusCode).toBe(422);
    expect(response.json<ErrorBody>().error.code).toBe('generation_job_failed');
    expect(generation.refunds.requests).toHaveLength(1);
  });

  it('exposes exactly one endpoint per edit kind', async () => {
    const minimalBody: Readonly<Record<EditKind, Readonly<Record<string, unknown>>>> = {
      cover: SOURCE,
      repaint: { ...SOURCE, repaintStartSeconds: 1, repaintEndSeconds: 2 },
      extract: { ...SOURCE, trackName: 'drums' },
      lego: { ...SOURCE, trackName: 'drums' },
      complete: SOURCE,
    };

    for (const kind of EDIT_KINDS) {
      const response = await harness.app.inject({
        method: 'POST',
        url: `${API_PREFIX}/edits/${kind}`,
        payload: minimalBody[kind],
      });
      // 401 rather than 404: the route exists, its schema accepted the body, and the
      // authentication hook is what refused.
      expect(response.statusCode, kind).toBe(401);
    }
  });
});
