import { describe, expect, it } from 'vitest';

import {
  WHISPER_TRANSCRIPTION_PATH,
  WHISPER_TRANSCRIPTION_TIERS,
  areWhisperTiersWellFormed,
  createWhisperTranscriptionAdapter,
} from '../../../adapters/transcription';
import { decodeWhisperResponse, languageOf, linesFromSegments, secondsToMs } from '../../../adapters/transcription/wire';
import {
  TIER_SECONDS_PER_AUDIO_SECOND_MAX,
  TIER_SECONDS_PER_AUDIO_SECOND_MIN,
  TRANSCRIPTION_TIER_COUNT_MAX,
  TRANSCRIPTION_TIER_COUNT_MIN,
} from '../../../domain/transcription/bounds';
import { normaliseTranscriptionLines } from '../../../domain/transcription/result';
import { deterministicWhisperTransport } from '../../support/deterministic-whisper-transport';

/**
 * Whisper_Adapter — the ASR seam task 2.7 left unimplemented.
 *
 * **Validates: Requirements 27.1, 27.2, 27.3, 27.4, 27.16**
 *
 * The adapter decides two things and delegates everything else, so the tests are about those two:
 *
 * 1. **Seconds become integer milliseconds**, by rounding rather than truncation — a truncating
 *    adapter biases every boundary the same direction, which is invisible in a single assertion
 *    and systematic across a transcript.
 * 2. **A hinted language reports no confidence.** Requirement 27.3 and 27.4 are different criteria,
 *    and a real server scores the language it was told to use — so passing that number through
 *    would report a detection that never happened, and could flag a caller's own choice as
 *    "undetermined" under 27.4's 0.50 floor.
 *
 * The third block is Requirement 27.16: everything that can go wrong on the wire has to arrive as
 * a `failed` outcome, because that is the arm 27.16 turns into a reason code *while preserving the
 * stored result*. An adapter that threw would escape that path entirely.
 */

const AUDIO = { audioId: 'asset-a', modelId: 'whisper-base', audioDurationMs: 10_000 };

function adapter(objectKeyOf?: (audioId: string) => string) {
  const transport = deterministicWhisperTransport();
  return {
    transport,
    engine: createWhisperTranscriptionAdapter({
      transport,
      ...(objectKeyOf === undefined ? {} : { objectKeyOf }),
    }),
  };
}

describe('the wire form (Requirement 27.1)', () => {
  it('sends the model, the audio reference and the duration', async () => {
    const { engine, transport } = adapter();

    await engine.transcribe(AUDIO);

    expect(transport.requests[0]).toEqual({
      path: WHISPER_TRANSCRIPTION_PATH,
      method: 'POST',
      body: {
        model: 'whisper-base',
        audio: { id: 'asset-a', object_key: 'asset-a', duration_ms: 10_000 },
        response_format: 'verbose_json',
      },
    });
  });

  it('maps the audio id to an object key when the deployment stores them apart', async () => {
    const { engine, transport } = adapter((audioId) => `audio/${audioId}.flac`);

    await engine.transcribe(AUDIO);

    expect(transport.requests[0]?.body?.['audio']).toMatchObject({
      object_key: 'audio/asset-a.flac',
    });
  });

  it('refuses a request with no model rather than choosing one', async () => {
    const { engine } = adapter();
    await expect(engine.transcribe({ ...AUDIO, modelId: '' })).rejects.toThrow(/model identifier/);
  });
});

describe('seconds to milliseconds (Requirement 27.1)', () => {
  it('rounds rather than truncating', () => {
    expect(secondsToMs(1.2345)).toBe(1_235);
    expect(secondsToMs(0.0006)).toBe(1);
    expect(secondsToMs(2)).toBe(2_000);
  });

  it('produces integers for every segment the engine reports', async () => {
    const { engine } = adapter();

    const outcome = await engine.transcribe(AUDIO);

    expect(outcome.kind).toBe('transcribed');
    if (outcome.kind !== 'transcribed') return;
    expect(outcome.output.lines.length).toBeGreaterThan(1);
    for (const line of outcome.output.lines) {
      expect(Number.isInteger(line.startMs)).toBe(true);
      expect(Number.isInteger(line.endMs)).toBe(true);
    }
  });

  it('does not drift: a boundary shared by two segments lands on one millisecond', async () => {
    // A truncating adapter would still agree here; what it would not do is round 1.2345 up.
    const { engine, transport } = adapter();
    transport.setSegments([
      { start: 0, end: 1.2345, text: 'a' },
      { start: 1.2345, end: 2.469, text: 'b' },
    ]);

    const outcome = await engine.transcribe(AUDIO);
    if (outcome.kind !== 'transcribed') throw new Error('expected a transcription');

    expect(outcome.output.lines.map((line) => [line.startMs, line.endMs])).toEqual([
      [0, 1_235],
      [1_235, 2_469],
    ]);
  });

  it('leaves a sub-millisecond segment for the service to drop, rather than widening it', async () => {
    // Requirement 27.7 is the service's; inventing a boundary here would be inventing timing,
    // which Requirement 27.9 makes this pipeline the single source of.
    const { engine, transport } = adapter();
    transport.setSegments([{ start: 1.0, end: 1.0002, text: 'blip' }]);

    const outcome = await engine.transcribe(AUDIO);
    if (outcome.kind !== 'transcribed') throw new Error('expected a transcription');

    expect(outcome.output.lines).toEqual([{ startMs: 1_000, endMs: 1_000, text: 'blip' }]);
    expect(normaliseTranscriptionLines(outcome.output.lines, 10_000)).toEqual([]);
  });

  it('trims the leading space a Whisper server emits', async () => {
    const { engine } = adapter();

    const outcome = await engine.transcribe(AUDIO);
    if (outcome.kind !== 'transcribed') throw new Error('expected a transcription');

    for (const line of outcome.output.lines) {
      expect(line.text).toBe(line.text.trim());
      expect(line.text.length).toBeGreaterThan(0);
    }
  });
});

describe('the language report (Requirements 27.3, 27.4)', () => {
  it('echoes a hinted code and reports no confidence', async () => {
    const { engine, transport } = adapter();
    transport.setLanguage('en', 0.99);

    const outcome = await engine.transcribe({ ...AUDIO, languageCode: 'ko' });
    if (outcome.kind !== 'transcribed') throw new Error('expected a transcription');

    expect(outcome.output.languageCode).toBe('ko');
    // The server *did* return a probability; reporting it would claim a detection that did not
    // happen — and a low one would flag the caller's own choice as undetermined under 27.4.
    expect(outcome.output.confidence).toBeNull();
  });

  it('reports the detected code and its confidence when no hint was given', async () => {
    const { engine, transport } = adapter();
    transport.setLanguage('ja', 0.42);

    const outcome = await engine.transcribe(AUDIO);
    if (outcome.kind !== 'transcribed') throw new Error('expected a transcription');

    expect(outcome.output).toMatchObject({ languageCode: 'ja', confidence: 0.42 });
  });

  it('clamps a probability outside 27.4 s published scale', () => {
    const response = { language: 'en', languageProbability: 1.0000002, segments: [] };
    expect(languageOf(response, undefined).confidence).toBe(1);
    expect(languageOf({ ...response, languageProbability: -3 }, undefined).confidence).toBe(0);
  });

  it('reports a null confidence when the server sent none', async () => {
    const { engine, transport } = adapter();
    transport.setLanguage('en', null);

    const outcome = await engine.transcribe(AUDIO);
    if (outcome.kind !== 'transcribed') throw new Error('expected a transcription');

    expect(outcome.output.confidence).toBeNull();
  });
});

describe('failures are returned, not thrown (Requirement 27.16)', () => {
  it('turns a non-2xx into a failed outcome', async () => {
    const { engine, transport } = adapter();
    transport.failNextWithStatus(503);

    const outcome = await engine.transcribe(AUDIO);

    expect(outcome).toEqual({
      kind: 'failed',
      detail: `${WHISPER_TRANSCRIPTION_PATH} answered HTTP 503`,
    });
  });

  it('turns a transport exception into a failed outcome', async () => {
    // A socket reset is an engine failure, not a crash of the service that asked.
    const { engine, transport } = adapter();
    transport.throwNext('socket hang up');

    const outcome = await engine.transcribe(AUDIO);

    expect(outcome.kind).toBe('failed');
    expect(outcome.kind === 'failed' && outcome.detail).toContain('socket hang up');
  });

  it('reads an error envelope answered with 200', async () => {
    const { engine, transport } = adapter();
    transport.answerNextWith({ error: 'model not loaded' });

    const outcome = await engine.transcribe(AUDIO);

    expect(outcome).toEqual({ kind: 'failed', detail: 'model not loaded' });
  });

  it('refuses an envelope it cannot read rather than reporting an empty transcription', async () => {
    // Reporting silence for audio the probe already found speech in would be the worse failure:
    // Requirement 27.12's empty-line answer means "no speech", and this is not that.
    for (const body of [null, {}, { language: 'en' }, { language: 'en', segments: 'nope' }]) {
      const { engine, transport } = adapter();
      transport.answerNextWith(body);

      const outcome = await engine.transcribe(AUDIO);
      expect(outcome.kind).toBe('failed');
    }
  });

  it('refuses a segment list with a malformed entry', async () => {
    const { engine, transport } = adapter();
    transport.answerNextWith({
      language: 'en',
      segments: [{ start: 0, end: 1, text: 'ok' }, { start: 'later', end: 2, text: 'bad' }],
    });

    expect((await engine.transcribe(AUDIO)).kind).toBe('failed');
  });
});

describe('the decoder', () => {
  it('accepts an envelope carrying fields it does not read', () => {
    const decoded = decodeWhisperResponse({
      language: 'en',
      language_probability: 0.8,
      duration: 3.5,
      task: 'transcribe',
      segments: [{ start: 0, end: 1, text: 'hi', avg_logprob: -0.2, words: [] }],
    });

    expect(decoded).toEqual({
      language: 'en',
      languageProbability: 0.8,
      segments: [{ start: 0, end: 1, text: 'hi' }],
    });
  });

  it('accepts an empty segment list', () => {
    expect(decodeWhisperResponse({ language: 'en', segments: [] })?.segments).toEqual([]);
    expect(linesFromSegments([])).toEqual([]);
  });

  it('refuses an envelope with no language', () => {
    expect(decodeWhisperResponse({ segments: [] })).toBeNull();
    expect(decodeWhisperResponse({ language: '', segments: [] })).toBeNull();
  });
});

describe('the tier list (Requirement 27.2)', () => {
  it('satisfies the count and per-second bounds the criterion states', () => {
    expect(areWhisperTiersWellFormed()).toBe(true);
    expect(WHISPER_TRANSCRIPTION_TIERS.length).toBeGreaterThanOrEqual(TRANSCRIPTION_TIER_COUNT_MIN);
    expect(WHISPER_TRANSCRIPTION_TIERS.length).toBeLessThanOrEqual(TRANSCRIPTION_TIER_COUNT_MAX);

    for (const tier of WHISPER_TRANSCRIPTION_TIERS) {
      expect(tier.secondsPerAudioSecond).toBeGreaterThanOrEqual(TIER_SECONDS_PER_AUDIO_SECOND_MIN);
      expect(tier.secondsPerAudioSecond).toBeLessThanOrEqual(TIER_SECONDS_PER_AUDIO_SECOND_MAX);
      expect(tier.modelId.length).toBeGreaterThan(0);
    }
  });

  it('catches a deployment editing the list past the bounds', () => {
    expect(areWhisperTiersWellFormed([WHISPER_TRANSCRIPTION_TIERS[0] as never])).toBe(false);
    expect(
      areWhisperTiersWellFormed([
        { tierId: 'fast', modelId: 'whisper-base', secondsPerAudioSecond: 9 },
        { tierId: 'accurate', modelId: 'whisper-large-v3', secondsPerAudioSecond: 1.5 },
      ]),
    ).toBe(false);
  });

  it('makes the deadlines of 27.1 visibly different between tiers', () => {
    const [fast, accurate] = WHISPER_TRANSCRIPTION_TIERS;
    expect(fast?.secondsPerAudioSecond).toBeLessThan(accurate?.secondsPerAudioSecond ?? 0);
  });
});
