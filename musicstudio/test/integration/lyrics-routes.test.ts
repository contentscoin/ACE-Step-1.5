import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ACE_FORMAT_INPUT_PATH } from '../../adapters/ace/format-input';
import { parseLrc } from '../../domain/lyrics/lrc-parser';
import {
  createGatewayHarness,
  requireLyrics,
  type GatewayHarness,
} from '../support/gateway-harness';

/**
 * Lyric enrichment, drafting and LRC download through the real gateway
 * (Requirements 8.1–8.6, 10.8).
 *
 * `app.inject()` drives the production Fastify instance, the production schemas and
 * the production `/format_input` adapter; only the engine transport and the timing
 * source are scripted. So a schema that rejected a legitimate body, or a route that
 * dropped a field, fails here rather than in staging.
 */

const CREDENTIALS = {
  email: 'writer@example.com',
  password: 'correct-horse-battery-staple',
} as const;

const TRACK_ID = 'track-abc';

let harness: GatewayHarness;
let accessToken: string;

async function signIn(): Promise<string> {
  await harness.app.inject({ method: 'POST', url: '/v1/auth/register', payload: CREDENTIALS });
  const login = await harness.app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: CREDENTIALS,
  });
  return login.json<{ accessToken: string }>().accessToken;
}

function authorized(): Record<string, string> {
  return { authorization: `Bearer ${accessToken}` };
}

beforeEach(async () => {
  harness = createGatewayHarness({ lyrics: {} });
  accessToken = await signIn();
});

afterEach(async () => {
  await harness.close();
});

describe('POST /v1/lyrics/enrichments (Requirements 8.1, 8.2)', () => {
  it('returns both sides and names the choices without making one', async () => {
    requireLyrics(harness).transport.setFormattedSample({
      caption: 'warm lo-fi study beat',
      lyrics: '[Verse 1]\nquiet light\n\n[Chorus]\nhold on',
      bpm: 82,
      key_scale: 'F major',
      time_signature: '4',
      duration: 165,
      vocal_language: 'en',
    });

    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/lyrics/enrichments',
      headers: authorized(),
      payload: { caption: 'lo-fi beat', lyrics: '[Verse]\nrain', bpm: 70 },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      original: Record<string, unknown>;
      enriched: Record<string, unknown>;
      enrichedStructure: readonly { kind: string; label: string | null }[];
      choices: readonly string[];
    }>();

    expect(body.original).toEqual({
      caption: 'lo-fi beat',
      lyrics: '[Verse]\nrain',
      bpm: 70,
      keyScale: null,
      timeSignature: null,
      durationSeconds: null,
      vocalLanguage: null,
    });
    expect(body.enriched).toEqual({
      caption: 'warm lo-fi study beat',
      lyrics: '[Verse 1]\nquiet light\n\n[Chorus]\nhold on',
      bpm: 82,
      keyScale: 'F major',
      timeSignature: 4,
      durationSeconds: 165,
      vocalLanguage: 'en',
    });
    expect(body.enrichedStructure.map((section) => section.label)).toEqual(['Verse 1', 'Chorus']);
    expect(body.choices).toEqual(['original', 'enriched']);
    // Requirement 8.2: the response contains no decision.
    expect(Object.keys(body)).not.toContain('selected');
  });

  it('reports an unrecognised tag in the enriched lyrics as a warning', async () => {
    requireLyrics(harness).transport.setFormattedSample({
      caption: 'c',
      lyrics: '[Hook]\nsing it',
    });

    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/lyrics/enrichments',
      headers: authorized(),
      payload: { caption: 'c', lyrics: 'l' },
    });

    expect(response.json<{ warnings: readonly { code: string; line: number }[] }>().warnings).toEqual([
      { code: 'unrecognised_section_tag', line: 1, message: expect.any(String), actual: '[Hook]' },
    ]);
  });

  it('answers 502 with the failure reason and the original input (Requirement 8.5)', async () => {
    requireLyrics(harness).transport.failNext(
      ACE_FORMAT_INPUT_PATH,
      500,
      'format_sample failed: LLM init failed',
    );

    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/lyrics/enrichments',
      headers: authorized(),
      payload: { caption: 'my caption', lyrics: 'my lyrics', bpm: 100 },
    });

    expect(response.statusCode).toBe(502);
    const error = response.json<{ error: { code: string; original: Record<string, unknown> } }>()
      .error;
    expect(error.code).toBe('lyrics_enrichment_engine_failed');
    expect(error.original).toMatchObject({
      caption: 'my caption',
      lyrics: 'my lyrics',
      bpm: 100,
    });
  });

  it('requires authentication', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/lyrics/enrichments',
      payload: { caption: 'c', lyrics: 'l' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('strips an unknown field instead of forwarding it to the engine', async () => {
    // Fastify's Ajv is configured with `removeAdditional`, so `additionalProperties:
    // false` strips rather than rejects. What matters for the wire contract is that the
    // stray field cannot reach `/format_input` and be interpreted there.
    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/lyrics/enrichments',
      headers: authorized(),
      payload: { caption: 'c', lyrics: 'l', tempo: 120 },
    });

    expect(response.statusCode).toBe(200);
    const posted = requireLyrics(harness).transport.onlyRequestTo(ACE_FORMAT_INPUT_PATH).body;
    expect(posted).not.toHaveProperty('tempo');
    expect(posted.param_obj).toEqual({});
  });

  it('rejects a body with no lyrics field', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/lyrics/enrichments',
      headers: authorized(),
      payload: { caption: 'c' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('never charges the caller (Requirement 8.6)', async () => {
    // The gateway is built with no credit service on this path at all, so the assertion
    // is that the route works without one — a charge would need a dependency that is
    // not there.
    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/lyrics/enrichments',
      headers: authorized(),
      payload: { caption: 'c', lyrics: 'l' },
    });
    expect(response.statusCode).toBe(200);
  });
});

describe('POST /v1/lyrics/drafts (Requirements 8.3, 8.4)', () => {
  it('returns a tagged draft containing a Verse and a Chorus', async () => {
    requireLyrics(harness).transport.setFormattedSample({
      caption: 'winter ballad',
      lyrics: '[verse]\nfirst snow\n[CHORUS]\nI miss you',
    });

    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/lyrics/drafts',
      headers: authorized(),
      payload: { topic: 'first snow, missing someone' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      caption: string;
      lyrics: string;
      structure: readonly { label: string | null }[];
    }>();

    expect(body.caption).toBe('winter ballad');
    // Canonical tags, ready to paste into a Custom_Mode request.
    expect(body.lyrics).toBe('[Verse]\nfirst snow\n\n[Chorus]\nI miss you');
    expect(body.structure.map((section) => section.label)).toEqual(['Verse', 'Chorus']);

    const posted = requireLyrics(harness).transport.onlyRequestTo(ACE_FORMAT_INPUT_PATH).body;
    expect(posted.prompt).toBe('first snow, missing someone');
    expect(posted.lyrics).toBe('');
  });

  it('answers 422 when the draft has no Chorus (Requirement 8.4)', async () => {
    requireLyrics(harness).transport.setFormattedSample({
      caption: 'c',
      lyrics: '[Verse]\nonly a verse',
    });

    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/lyrics/drafts',
      headers: authorized(),
      payload: { topic: 'a topic' },
    });

    // 422, not 502: the engine answered, so retrying unchanged is not the fix.
    expect(response.statusCode).toBe(422);
    expect(response.json<{ error: { code: string } }>().error.code).toBe(
      'lyrics_draft_structure_incomplete',
    );
  });

  it('rejects an empty topic', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: '/v1/lyrics/drafts',
      headers: authorized(),
      payload: { topic: '' },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('GET /v1/tracks/:trackId/timed-lyrics.lrc (Requirement 10.8)', () => {
  it('returns an LRC file as a download', async () => {
    requireLyrics(harness).timings.set(TRACK_ID, [
      { startMs: 9_000, text: 'third' },
      { startMs: 1_000, text: 'first' },
      { startMs: 5_500, text: 'second' },
    ]);

    const response = await harness.app.inject({
      method: 'GET',
      url: `/v1/tracks/${TRACK_ID}/timed-lyrics.lrc?trackDurationMs=180000`,
      headers: authorized(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(response.headers['content-disposition']).toBe(
      `attachment; filename="${TRACK_ID}.lrc"`,
    );
    // Ordered (Requirement 10.5) and in `[mm:ss.xx]` form (Requirement 10.2).
    expect(response.body).toBe('[00:01.00]first\n[00:05.50]second\n[00:09.00]third\n');
  });

  it('returns a body that parses back into Timed_Lyrics', async () => {
    requireLyrics(harness).timings.set(TRACK_ID, [{ startMs: 2_340, text: 'a line' }]);

    const response = await harness.app.inject({
      method: 'GET',
      url: `/v1/tracks/${TRACK_ID}/timed-lyrics.lrc?trackDurationMs=180000`,
      headers: authorized(),
    });

    const reparsed = parseLrc(response.body);
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) throw new Error('unreachable');
    expect(reparsed.value.lines).toEqual([{ startMs: 2_340, text: 'a line' }]);
  });

  it('answers 404 for a track with no Timed_Lyrics', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: '/v1/tracks/instrumental-track/timed-lyrics.lrc?trackDurationMs=60000',
      headers: authorized(),
    });

    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('timed_lyrics_not_found');
  });

  it('answers 409 when the stored timings fall outside the track (Requirement 10.7)', async () => {
    requireLyrics(harness).timings.set(TRACK_ID, [
      { startMs: 1_000, text: 'fine' },
      { startMs: 61_000, text: 'past the end' },
    ]);

    const response = await harness.app.inject({
      method: 'GET',
      url: `/v1/tracks/${TRACK_ID}/timed-lyrics.lrc?trackDurationMs=60000`,
      headers: authorized(),
    });

    expect(response.statusCode).toBe(409);
    const error = response.json<{ error: { code: string; violations: readonly string[] } }>().error;
    expect(error.code).toBe('timed_lyrics_out_of_track_bounds');
    // Requirement 10.6's shape reused: the caller is told which line is at fault.
    expect(error.violations).toEqual(['line 2, field startMs: timestamp_outside_track (expected 0..60000 ms)']);
  });

  it('requires authentication', async () => {
    const response = await harness.app.inject({
      method: 'GET',
      url: `/v1/tracks/${TRACK_ID}/timed-lyrics.lrc?trackDurationMs=1000`,
    });
    expect(response.statusCode).toBe(401);
  });

  it('rejects a request that does not state the track length', async () => {
    // Requirement 10.7's bound cannot be checked without it, and silently skipping the
    // check would let an out-of-bounds file be served.
    const response = await harness.app.inject({
      method: 'GET',
      url: `/v1/tracks/${TRACK_ID}/timed-lyrics.lrc`,
      headers: authorized(),
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('the lyric routes are absent unless wired', () => {
  it('answers 404 when the gateway was built without them', async () => {
    const bare = createGatewayHarness();
    try {
      const response = await bare.app.inject({
        method: 'POST',
        url: '/v1/lyrics/enrichments',
        payload: { caption: 'c', lyrics: 'l' },
      });
      expect(response.statusCode).toBe(404);
    } finally {
      await bare.close();
    }
  });
});
