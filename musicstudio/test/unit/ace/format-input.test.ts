import { describe, expect, it } from 'vitest';

import {
  ACE_FORMAT_INPUT_DEFAULT_TEMPERATURE,
  ACE_FORMAT_INPUT_PATH,
  buildFormatInputBody,
  requestAceFormatInput,
} from '../../../adapters/ace/format-input';
import { isAceEngineError } from '../../../adapters/ace/errors';
import { createScriptedAceTransport } from '../../support/scripted-ace-transport';

/**
 * The `/format_input` wire contract (Requirement 8.1).
 *
 * Two things are asserted here and nowhere else: the exact body posted to the engine,
 * and the decoding of the engine's reply. Both are statements about a wire format, so
 * they are pinned against the scripted transport that reproduces
 * `acestep/api/http/sample_format_routes.py` — the engine itself is a separate
 * deployment (design §1.4.1) and is not available in CI.
 */

describe('Requirement 8.1 — the request body the engine receives', () => {
  it('sends the caption as `prompt` and the lyrics as `lyrics`', () => {
    expect(buildFormatInputBody({ caption: 'dreamy synth pop', lyrics: '[Verse]\nna na' })).toEqual({
      prompt: 'dreamy synth pop',
      lyrics: '[Verse]\nna na',
      temperature: ACE_FORMAT_INPUT_DEFAULT_TEMPERATURE,
      param_obj: {},
    });
  });

  it('nests supplied musical hints under `param_obj`, using the engine\'s field names', () => {
    const body = buildFormatInputBody({
      caption: 'c',
      lyrics: 'l',
      bpm: 128,
      keyScale: 'A minor',
      timeSignature: 4,
      durationSeconds: 210,
      vocalLanguage: 'ko',
    });

    // `key` on the way in, `key_scale` on the way back: the asymmetry is the engine's.
    expect(body.param_obj).toEqual({
      bpm: 128,
      key: 'A minor',
      time_signature: '4',
      duration: 210,
      language: 'ko',
    });
  });

  it('omits a hint the caller did not supply', () => {
    // The engine builds `user_metadata_for_format` from truthy values only, so an
    // omitted field is how it is told to invent one — the same rule as Requirements
    // 3.3 and 4.7. Sending `null` would not be equivalent.
    const body = buildFormatInputBody({ caption: 'c', lyrics: 'l', bpm: 90 });
    expect(body.param_obj).toEqual({ bpm: 90 });
  });

  it('passes an explicit temperature through', () => {
    expect(buildFormatInputBody({ caption: 'c', lyrics: 'l', temperature: 0.2 }).temperature).toBe(
      0.2,
    );
  });

  it('posts to /format_input exactly once', async () => {
    const transport = createScriptedAceTransport();
    await requestAceFormatInput(transport, { caption: 'c', lyrics: 'l' });
    expect(transport.onlyRequestTo(ACE_FORMAT_INPUT_PATH).body.prompt).toBe('c');
  });
});

describe('Requirement 8.1 — decoding the engine\'s reply', () => {
  it('returns all seven values in the domain vocabulary', async () => {
    const transport = createScriptedAceTransport();
    transport.setFormattedSample({
      caption: 'enriched caption',
      lyrics: '[Verse]\nenriched',
      bpm: 128,
      key_scale: 'A minor',
      time_signature: '4/4',
      duration: 212.5,
      vocal_language: 'ko',
    });

    expect(await requestAceFormatInput(transport, { caption: 'c', lyrics: 'l' })).toEqual({
      caption: 'enriched caption',
      lyrics: '[Verse]\nenriched',
      bpm: 128,
      keyScale: 'A minor',
      // `4/4` reduces to the numerator, which is how `domain/song/` models it.
      timeSignature: 4,
      durationSeconds: 212.5,
      vocalLanguage: 'ko',
    });
  });

  it('reads a numeric string for bpm and duration', async () => {
    const transport = createScriptedAceTransport();
    transport.setFormattedSample({ caption: 'c', lyrics: 'l', bpm: '96', duration: '180' });

    const sample = await requestAceFormatInput(transport, { caption: 'c', lyrics: 'l' });
    expect(sample.bpm).toBe(96);
    expect(sample.durationSeconds).toBe(180);
  });

  it('reports nothing rather than a value for the engine\'s empty markers', async () => {
    const transport = createScriptedAceTransport();
    transport.setFormattedSample({
      caption: '  ',
      lyrics: 'N/A',
      bpm: null,
      key_scale: '',
      time_signature: '',
      duration: null,
      // `unknown` is the engine's "not determined" sentinel, not a language.
      vocal_language: 'unknown',
    });

    expect(await requestAceFormatInput(transport, { caption: 'c', lyrics: 'l' })).toEqual({
      caption: null,
      lyrics: null,
      bpm: null,
      keyScale: null,
      timeSignature: null,
      durationSeconds: null,
      vocalLanguage: null,
    });
  });

  it('drops a time signature outside the four the engine accepts', async () => {
    // Passing `7` forward would only get it rejected by `validateSongRequest`, which
    // is the single place Requirement 4.4's bound lives.
    const transport = createScriptedAceTransport();
    transport.setFormattedSample({ caption: 'c', lyrics: 'l', time_signature: '7/8' });
    expect((await requestAceFormatInput(transport, { caption: 'c', lyrics: 'l' })).timeSignature).toBeNull();
  });

  it('throws when the engine reports a failure inside a 200 response', async () => {
    // `wrap_response(None, code=500, error=…)` is how the route reports
    // `format_sample failed`; `unwrapEnvelope` is what notices.
    const transport = createScriptedAceTransport();
    transport.failNext(ACE_FORMAT_INPUT_PATH, 500, 'format_sample failed: LLM init failed');

    await expect(
      requestAceFormatInput(transport, { caption: 'c', lyrics: 'l' }),
    ).rejects.toSatisfy(isAceEngineError);
  });

  it('throws when the reply carries no object', async () => {
    const transport = createScriptedAceTransport();
    transport.setFormattedSample(null as unknown as Record<string, never>);

    await expect(
      requestAceFormatInput(transport, { caption: 'c', lyrics: 'l' }),
    ).rejects.toThrow(/no object/u);
  });
});
