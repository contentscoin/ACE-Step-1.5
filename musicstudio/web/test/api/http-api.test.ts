/**
 * The gateway client (slice S7).
 *
 * Driven against a scripted `fetch` rather than a running gateway: what is under test is the
 * mapping — which route a product call becomes, what it sends, and what it makes of the answer —
 * and a live server would test the gateway's routes a second time instead. The routes themselves
 * are covered by `test/integration/composition-root.test.ts` on the other side of the wire, and
 * the two meet at the shapes asserted here, which are copied from that file's real responses.
 */

import { describe, expect, it } from 'vitest';

import { createHttpApi, GatewayError, NotServedByGateway } from '../../src/lib/api/http-api';
import { createSession, type SessionTokens } from '../../src/lib/api/session';

const BASE_URL = 'http://gateway.test';

const TOKENS: SessionTokens = {
  accountId: 'account-1',
  email: 'composer@studio.test',
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
};

interface Call {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | null;
  readonly body: string | null;
}

interface Scripted {
  readonly status?: number;
  readonly json?: unknown;
  readonly body?: BodyInit;
  readonly headers?: Record<string, string>;
}

/** A `fetch` that answers from a table and records what it was asked. */
function scriptedFetch(routes: Record<string, Scripted | ((call: Call) => Scripted)>) {
  const calls: Call[] = [];

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    const call: Call = {
      url,
      method: init?.method ?? 'GET',
      authorization: headers.get('authorization'),
      body: typeof init?.body === 'string' ? init.body : null,
    };
    calls.push(call);

    // Longest match, so `/v1/library/assets/a-1/download` wins over `/v1/library/assets`.
    const key = Object.keys(routes)
      .filter((candidate) => url.startsWith(`${BASE_URL}${candidate}`))
      .sort((a, b) => b.length - a.length)[0];
    if (key === undefined) return new Response('{}', { status: 404 });

    const entry = routes[key];
    const scripted = typeof entry === 'function' ? entry(call) : (entry as Scripted);
    const status = scripted.status ?? 200;
    const body = scripted.body ?? JSON.stringify(scripted.json ?? {});
    return new Response(status === 204 ? null : body, {
      status,
      headers: { 'content-type': 'application/json', ...scripted.headers },
    });
  }) as unknown as typeof globalThis.fetch;

  return { fetchImpl, calls };
}

function apiWith(
  routes: Record<string, Scripted | ((call: Call) => Scripted)>,
  initial: SessionTokens | null = TOKENS,
) {
  const { fetchImpl, calls } = scriptedFetch(routes);
  const session = createSession({ baseUrl: BASE_URL, fetchImpl, initial });
  return { api: createHttpApi({ baseUrl: BASE_URL, session, fetchImpl }), calls, session };
}

const ASSET_BODY = {
  id: 'asset-1',
  ownerId: 'account-1',
  name: 'Rain, Later',
  assetKind: 'song',
  caption: 'calm piano over rain',
  lyrics: '',
  tags: ['ambient'],
  playCount: 3,
  createdAtMs: 1_800_000_000_000,
  isDeleted: false,
  durationMs: 30_000,
  sampleRate: 48_000,
  channels: 2,
  isLoop: false,
};

describe('the gateway client', () => {
  it('identifies itself as a gateway, which is what removes the demo banner', () => {
    const { api } = apiWith({});
    expect(api.backend.kind).toBe('gateway');
  });

  it('sends the credential, and the mode chooses the route', async () => {
    const { api, calls } = apiWith({
      '/v1/songs/simple': { status: 202, json: { jobId: 'job-1', queuePosition: 1, state: 'pending', estimatedCompletionAtMs: null } },
    });

    const outcome = await api.submitSong({ mode: 'simple', description: 'a calm piano piece' });

    expect(outcome.kind).toBe('accepted');
    expect(outcome.job?.jobId).toBe('job-1');
    // Requirement 5.1's queue position, and the gateway's `pending` as the screens' `queued`.
    expect(outcome.job?.state).toBe('queued');
    expect(outcome.job?.queuePosition).toBe(1);
    expect(calls[0]?.url).toBe(`${BASE_URL}/v1/songs/simple`);
    expect(calls[0]?.authorization).toBe('Bearer access-1');
    // `mode` is the client's routing decision and not a field the gateway takes.
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ description: 'a calm piano piece' });
  });

  it('turns Requirement 3.5 field violations into a rejection, not an error', async () => {
    const { api } = apiWith({
      '/v1/songs/custom': {
        status: 400,
        json: {
          error: {
            code: 'song_request_invalid',
            message: 'bpm out of range',
            violations: [{ field: 'bpm', violation: 'bpm_range', allowed: '60..200' }],
          },
        },
      },
    });

    const outcome = await api.submitSong({ mode: 'custom', bpm: 5_000 });

    expect(outcome.kind).toBe('rejected');
    expect(outcome.violations?.[0]).toMatchObject({ field: 'bpm' });
  });

  it('reports a 400 that carries no violations as an error, so a client bug is not shown as a user one', async () => {
    const { api } = apiWith({
      '/v1/songs/simple': { status: 400, json: { error: { code: 'validation_failed', message: 'body must have required property' } } },
    });

    await expect(api.submitSong({ mode: 'simple', description: 'x' })).rejects.toBeInstanceOf(
      GatewayError,
    );
  });

  it('maps a job status, and reads a forgotten job as null rather than a failure', async () => {
    const { api } = apiWith({
      '/v1/generation-jobs/job-1': {
        json: {
          jobId: 'job-1',
          state: 'running',
          queuePosition: null,
          progressPercent: 40,
          estimatedCompletionAtMs: 1_800_000_030_000,
          failure: null,
          assetIds: [],
          retryOfJobId: null,
        },
      },
      '/v1/generation-jobs/gone': { status: 404, json: { error: { code: 'job_not_found' } } },
    });

    const job = await api.jobStatus('job-1');
    expect(job).toMatchObject({ state: 'running', percent: 40, assetIds: [] });
    // The job store is in-memory, so a restart forgets jobs in flight; that is an absence.
    expect(await api.jobStatus('gone')).toBeNull();
  });

  it('carries the listing query, and the cursor makes a round trip as one opaque string', async () => {
    const { api, calls } = apiWith({
      '/v1/library/assets': {
        json: {
          assets: [ASSET_BODY],
          nextCursor: Buffer.from(
            JSON.stringify({ k: 'created_at', v: 1_800_000_000_000, i: 'asset-1' }),
          ).toString('base64url'),
        },
      },
    });

    const page = await api.listAssets({
      ownerId: 'account-1',
      pageSize: 10,
      sortKey: 'created_at',
      search: 'rain',
    });

    const url = new URL(calls[0]?.url ?? '');
    expect(url.searchParams.get('pageSize')).toBe('10');
    expect(url.searchParams.get('sortKey')).toBe('created_at');
    expect(url.searchParams.get('search')).toBe('rain');
    // The caller gets the triple back, and hands it straight to the next call.
    expect(page.nextCursor).toEqual({ sortKey: 'created_at', value: 1_800_000_000_000, id: 'asset-1' });
    expect(page.assets[0]).toMatchObject({ id: 'asset-1', playCount: 3 });

    await api.listAssets({ ownerId: 'account-1', cursor: page.nextCursor });
    expect(new URL(calls[1]?.url ?? '').searchParams.get('cursor')).not.toBeNull();
  });

  it("fills the three fields the gateway has no answer for with what is true of it", async () => {
    const { api } = apiWith({ '/v1/library/assets/asset-1': { json: ASSET_BODY } });

    const asset = await api.findAsset('asset-1');

    // No transcription store, no genre writer, and everything here came from an engine.
    expect(asset?.timedLyrics).toBeNull();
    expect(asset?.genres).toEqual([]);
    expect(asset?.aiGenerated).toBe(true);
    expect(asset?.durationMs).toBe(30_000);
  });

  it('reads 404 and 403 on one asset as "no asset for you", not as an error', async () => {
    const { api } = apiWith({
      '/v1/library/assets/missing': { status: 404, json: { error: { code: 'library_asset_not_found' } } },
      '/v1/library/assets/theirs': { status: 403, json: { error: { code: 'library_asset_forbidden' } } },
    });

    expect(await api.findAsset('missing')).toBeNull();
    // Requirement 11.9 fixes 403 for a foreign asset; a screen that asked for one by identifier
    // shows the same "없습니다" either way, and the status is the gateway's to state.
    expect(await api.findAsset('theirs')).toBeNull();
  });

  it('takes the download file name from the header the gateway sets, preferring the UTF-8 form', async () => {
    const name = 'Rain, Later (asset-1).wav';
    const { api } = apiWith({
      '/v1/library/assets/asset-1/download': {
        body: new Uint8Array([0x52, 0x49, 0x46, 0x46]),
        headers: {
          'content-type': 'audio/wav',
          'content-disposition': `attachment; filename="Rain_ Later (asset-1).wav"; filename*=UTF-8''${encodeURIComponent(name)}`,
        },
      },
    });

    const file = await api.fetchDownload('asset-1', 'wav');

    expect(file.fileName).toBe(name);
    expect(file.deliveredFormat).toBe('wav');
    expect(new Uint8Array(await file.blob.arrayBuffer())).toEqual(
      new Uint8Array([0x52, 0x49, 0x46, 0x46]),
    );
  });

  it('rules on a download before moving any bytes (Requirement 13.4)', async () => {
    const { api, calls } = apiWith({ '/v1/library/assets/asset-1': { json: ASSET_BODY } });

    const refused = await api.planDownload('asset-1', 'wav', false);
    expect(refused.ruling.allowed).toBe(false);
    expect(refused.ruling.requiredPlanIds).toEqual(['creator', 'studio']);

    const allowed = await api.planDownload('asset-1', 'wav', true);
    expect(allowed.ruling.allowed).toBe(true);
    // Neither call fetched a file: the ruling is the domain's, and asking the gateway would
    // have encoded one to find out whether it was permitted.
    expect(calls.every((call) => !call.url.includes('/download'))).toBe(true);
  });

  it('fetches the audio with the credential and hands back a releasable source', async () => {
    const { api, calls } = apiWith({
      '/v1/playback/assets/asset-1/stream': {
        body: new Uint8Array([1, 2, 3, 4]),
        headers: { 'content-type': 'audio/flac' },
      },
    });

    const source = await api.audioSource('asset-1');

    // An `<audio>` element cannot send this header, which is the whole reason the bytes are
    // fetched here rather than handed to the element as a URL.
    expect(calls[0]?.authorization).toBe('Bearer access-1');
    expect(source.url.startsWith('blob:')).toBe(true);
    source.release();
    // Idempotent: the player releases on unmount, and a late source releases itself.
    expect(() => {
      source.release();
    }).not.toThrow();
  });

  it('refreshes once on a 401 and retries, so a lapsed access token is invisible', async () => {
    let accepted = false;
    const { api, calls, session } = apiWith({
      '/v1/auth/refresh': () => {
        accepted = true;
        return { json: { ...TOKENS, accessToken: 'access-2', refreshToken: 'refresh-2' } };
      },
      '/v1/library/assets/asset-1': (call) =>
        accepted && call.authorization === 'Bearer access-2'
          ? { json: ASSET_BODY }
          : { status: 401, json: { error: { code: 'token_expired' } } },
    });

    const asset = await api.findAsset('asset-1');

    expect(asset?.id).toBe('asset-1');
    expect(calls.map((call) => call.url)).toEqual([
      `${BASE_URL}/v1/library/assets/asset-1`,
      `${BASE_URL}/v1/auth/refresh`,
      `${BASE_URL}/v1/library/assets/asset-1`,
    ]);
    expect(session.current()?.accessToken).toBe('access-2');
  });

  it('clears the session when the refresh token is spent, and says so rather than saying "no asset"', async () => {
    const { api, session } = apiWith({
      '/v1/auth/refresh': { status: 401, json: { error: { code: 'token_invalid' } } },
      '/v1/library/assets/asset-1': { status: 401, json: { error: { code: 'token_expired' } } },
    });

    // 404 and 403 read as "no asset for you"; 401 must not. The user was signed out, and a
    // screen that showed "없습니다" for it would send them looking for a deleted asset.
    await expect(api.findAsset('asset-1')).rejects.toMatchObject({ status: 401 });
    expect(session.current()).toBeNull();
  });

  it('names what this gateway does not serve instead of answering it with something plausible', async () => {
    const { api } = apiWith({});

    // Each of these has a service and no route: falling back to the demo backend would put
    // synthesised material on the same screens as real material with nothing saying which.
    await expect(api.feed({})).rejects.toBeInstanceOf(NotServedByGateway);
    await expect(api.shareState('asset-1')).rejects.toBeInstanceOf(NotServedByGateway);
    await expect(api.project()).rejects.toBeInstanceOf(NotServedByGateway);
    await expect(api.effectChain('asset-1')).rejects.toBeInstanceOf(NotServedByGateway);
    await expect(api.masteringSuggestion('asset-1')).rejects.toBeInstanceOf(NotServedByGateway);
  });

  it('answers the two playback questions the gateway cannot, without a request', async () => {
    const { api, calls } = apiWith({});

    // Requirement 12.5's timings have no store, so every asset genuinely has none.
    expect(await api.lyricLineAt('asset-1', 1_000)).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
