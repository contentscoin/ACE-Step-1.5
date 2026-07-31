import { describe, expect, it } from 'vitest';

import { parseLrc } from '../../../domain/lyrics/lrc-parser';
import {
  DEFAULT_TRANSCRIPTION_TIERS,
  isWellFormedTierSet,
  responseBudgetMs,
} from '../../../domain/transcription/model-tier';
import {
  normaliseTranscriptionLines,
  transcriptionDefects,
  isValidTranscription,
  type TranscriptionResult,
} from '../../../domain/transcription/result';
import { createSpeechHarness } from '../../support/speech-harness';

/**
 * Transcription_Service.
 *
 * **Validates: Requirements 27.1, 27.2, 27.3, 27.4, 27.5, 27.6, 27.7, 27.8, 27.9, 27.10, 27.11,
 * 27.12, 27.13, 27.15, 27.16, 27.17**
 *
 * The three invariants of 27.6–27.8 are established on the way in rather than checked on the way
 * out, so most of the assertions here are about *what the service does with a badly behaved engine*
 * — which is the only honest way to test an invariant over a model this environment cannot run.
 */

function result(overrides: Partial<TranscriptionResult> = {}): TranscriptionResult {
  return {
    lines: [{ startMs: 0, endMs: 500, text: 'one' }],
    language: { languageCode: 'en', confidence: 0.9, undetermined: false },
    audioDurationMs: 10_000,
    tierId: 'fast',
    modelId: 'asr-fast-v1',
    reasonCode: null,
    ...overrides,
  };
}

describe('the model tiers (Requirements 27.1, 27.2)', () => {
  it('declares 2\u20135 tiers, each inside 0.01\u20135.00 s per audio second', () => {
    expect(isWellFormedTierSet(DEFAULT_TRANSCRIPTION_TIERS)).toBe(true);
    expect(DEFAULT_TRANSCRIPTION_TIERS.length).toBeGreaterThanOrEqual(2);
    for (const tier of DEFAULT_TRANSCRIPTION_TIERS) {
      expect(tier.secondsPerAudioSecond).toBeGreaterThanOrEqual(0.01);
      expect(tier.secondsPerAudioSecond).toBeLessThanOrEqual(5.0);
      expect(tier.modelId.length).toBeGreaterThan(0);
    }
  });

  it('refuses a tier set outside 27.2\u2019s bounds', () => {
    expect(isWellFormedTierSet([DEFAULT_TRANSCRIPTION_TIERS[0]!])).toBe(false);
    expect(
      isWellFormedTierSet([
        { tierId: 'a', modelId: 'm', secondsPerAudioSecond: 0.001 },
        { tierId: 'b', modelId: 'm', secondsPerAudioSecond: 1 },
      ]),
    ).toBe(false);
    // A duplicated tier identifier makes selection ambiguous.
    expect(
      isWellFormedTierSet([
        { tierId: 'a', modelId: 'm', secondsPerAudioSecond: 1 },
        { tierId: 'a', modelId: 'n', secondsPerAudioSecond: 2 },
      ]),
    ).toBe(false);
  });

  it('computes 27.1\u2019s deadline as duration \u00d7 cost + 60 s', () => {
    const tier = { tierId: 't', modelId: 'm', secondsPerAudioSecond: 0.5 };

    // 100 s of audio at 0.5 s/s is 50 s, plus 60 s.
    expect(responseBudgetMs(tier, 100_000)).toBe(110_000);
    expect(responseBudgetMs(tier, 0)).toBe(60_000);
  });

  it('exposes the tiers a caller selects from', () => {
    const harness = createSpeechHarness();

    expect(harness.transcription.availableTiers()).toEqual(DEFAULT_TRANSCRIPTION_TIERS);
  });

  it('refuses an unknown tier, listing the ones that exist', async () => {
    const harness = createSpeechHarness();

    await expect(
      harness.transcription.transcribe({ audioId: 'audio-1', tierId: 'magic' }),
    ).rejects.toMatchObject({
      code: 'transcription_request_invalid',
      details: { constraints: ['tierId'] },
    });
  });
});

describe('audio validation (Requirements 27.5, 27.15)', () => {
  it('accepts the bounds of 27.5', async () => {
    const harness = createSpeechHarness();
    for (const audio of [
      { durationMs: 500, sampleRate: 8_000 },
      { durationMs: 3_600_000, sampleRate: 48_000 },
    ]) {
      harness.transcriptionProbe.setAudio('audio-ok', { ...audio, speechDurationMs: 500 });
      await expect(harness.transcription.transcribe({ audioId: 'audio-ok' })).resolves.toBeDefined();
    }
  });

  it('refuses every violated bound at once, leaving the audio untouched', async () => {
    const harness = createSpeechHarness();
    harness.transcriptionProbe.setAudio('audio-bad', {
      durationMs: 100,
      sampleRate: 4_000,
      fileSizeBytes: 900_000_000,
      speechDurationMs: 100,
    });

    await expect(
      harness.transcription.transcribe({ audioId: 'audio-bad' }),
    ).rejects.toMatchObject({
      code: 'transcription_request_invalid',
      details: {
        constraints: ['duration', 'fileSize', 'sampleRate'],
        requirements: ['27.5', '27.5', '27.5'],
        audioUnchanged: true,
      },
    });

    // The model was never run for audio it could not accept.
    expect(harness.transcriptionEngine.requests).toEqual([]);
  });

  it('refuses an unreadable file', async () => {
    const harness = createSpeechHarness();
    harness.transcriptionProbe.setUnreadable('audio-x', 'not audio');

    await expect(harness.transcription.transcribe({ audioId: 'audio-x' })).rejects.toMatchObject({
      code: 'transcription_request_invalid',
    });
  });
});

describe('the language report (Requirements 27.3, 27.4)', () => {
  it('echoes a hinted code with no confidence, because nothing detected it', async () => {
    const harness = createSpeechHarness();
    const transcription = await harness.transcription.transcribe({
      audioId: 'audio-1',
      languageCode: 'KO',
    });

    expect(transcription.language).toEqual({
      languageCode: 'ko',
      confidence: null,
      undetermined: false,
    });
    // The hint reached the engine (27.3).
    expect(harness.transcriptionEngine.requests[0]?.languageCode).toBe('ko');
  });

  it('reports the detected code and confidence when no hint was given (27.4)', async () => {
    const harness = createSpeechHarness();
    harness.transcriptionEngine.setOutput({
      lines: [{ startMs: 0, endMs: 800, text: 'bonjour' }],
      languageCode: 'fr',
      confidence: 0.88,
    });

    const transcription = await harness.transcription.transcribe({ audioId: 'audio-1' });

    expect(transcription.language).toEqual({
      languageCode: 'fr',
      confidence: 0.88,
      undetermined: false,
    });
  });

  it('marks the language undetermined below 0.50 (27.4)', async () => {
    const harness = createSpeechHarness();
    harness.transcriptionEngine.setOutput({
      lines: [{ startMs: 0, endMs: 800, text: 'unclear' }],
      confidence: 0.49,
    });

    const transcription = await harness.transcription.transcribe({ audioId: 'audio-1' });

    expect(transcription.language.undetermined).toBe(true);
  });

  it('is determined at exactly 0.50, which 27.4 excludes from the flag', async () => {
    const harness = createSpeechHarness();
    harness.transcriptionEngine.setOutput({
      lines: [{ startMs: 0, endMs: 800, text: 'edge' }],
      confidence: 0.5,
    });

    expect((await harness.transcription.transcribe({ audioId: 'audio-1' })).language.undetermined).toBe(
      false,
    );
  });

  it('refuses a malformed hint rather than ignoring it', async () => {
    const harness = createSpeechHarness();

    await expect(
      harness.transcription.transcribe({ audioId: 'audio-1', languageCode: 'korean' }),
    ).rejects.toMatchObject({ details: { constraints: ['languageCode'] } });
  });
});

describe('the three invariants (Requirements 27.6, 27.7, 27.8)', () => {
  it('normalises an engine that returns lines out of order, unbounded and fractional', async () => {
    const harness = createSpeechHarness();
    harness.transcriptionProbe.setAudio('audio-1', { durationMs: 5_000, speechDurationMs: 4_000 });
    harness.transcriptionEngine.setOutput({
      lines: [
        { startMs: 3_000.4, endMs: 3_800.6, text: '  third  ' },
        { startMs: -100, endMs: 900, text: 'first' },
        // Past the audio: clamped.
        { startMs: 4_800, endMs: 9_000, text: 'fourth' },
        { startMs: 1_000, endMs: 1_900, text: 'second' },
      ],
    });

    const transcription = await harness.transcription.transcribe({ audioId: 'audio-1' });

    expect(isValidTranscription(transcription)).toBe(true);
    expect(transcription.lines.map((line) => line.text)).toEqual([
      'first',
      'second',
      'third',
      'fourth',
    ]);
    expect(transcription.lines[0]?.startMs).toBe(0);
    expect(transcription.lines.at(-1)?.endMs).toBe(5_000);
    for (const line of transcription.lines) {
      expect(Number.isInteger(line.startMs)).toBe(true);
      expect(line.startMs).toBeLessThan(line.endMs);
    }
  });

  it('drops a line whose span collapses rather than inventing a boundary', () => {
    const normalised = normaliseTranscriptionLines(
      [
        { startMs: 100, endMs: 100, text: 'zero length' },
        { startMs: 200, endMs: 300, text: 'kept' },
        { startMs: 400, endMs: 500, text: '   ' },
      ],
      1_000,
    );

    expect(normalised.map((line) => line.text)).toEqual(['kept']);
  });

  it('is a stable sort, so two lines at one instant keep their order', () => {
    const normalised = normaliseTranscriptionLines(
      [
        { startMs: 500, endMs: 900, text: 'left' },
        { startMs: 500, endMs: 900, text: 'right' },
      ],
      2_000,
    );

    expect(normalised.map((line) => line.text)).toEqual(['left', 'right']);
  });

  it('names each broken invariant with the vocabulary 27.17 reports', () => {
    const kinds = transcriptionDefects(
      result({
        lines: [
          { startMs: 500, endMs: 400, text: 'backwards' },
          { startMs: 100, endMs: 200, text: 'earlier' },
          { startMs: 9_000, endMs: 99_000, text: 'past the end' },
        ],
      }),
    ).map((defect) => defect.kind);

    expect(kinds).toContain('non_positive_span');
    expect(kinds).toContain('out_of_order');
    expect(kinds).toContain('time_out_of_audio');
  });
});

describe('no speech detected (Requirement 27.12)', () => {
  it('returns an empty line list and a reason code, leaving the audio alone', async () => {
    const harness = createSpeechHarness();
    harness.transcriptionProbe.setAudio('audio-quiet', { speechDurationMs: 150 });

    const transcription = await harness.transcription.transcribe({ audioId: 'audio-quiet' });

    expect(transcription.lines).toEqual([]);
    expect(transcription.reasonCode).toBe('no_speech_detected');
    // No model run was spent discovering there was nothing to transcribe.
    expect(harness.transcriptionEngine.requests).toEqual([]);
  });

  it('uses Requirement 30.12\u2019s 200 ms floor from the Quality_Threshold_Set', async () => {
    const harness = createSpeechHarness();
    harness.transcriptionProbe.setAudio('audio-1', { speechDurationMs: 200 });

    const transcription = await harness.transcription.transcribe({ audioId: 'audio-1' });

    expect(transcription.reasonCode).toBeNull();
    expect(harness.transcriptionProbe.requests[0]?.speechMinDurationMs).toBe(200);
  });

  it('does not overwrite a previously stored result with an empty one', async () => {
    const harness = createSpeechHarness();
    const first = await harness.transcription.transcribe({ audioId: 'audio-1' });
    harness.transcriptionProbe.setAudio('audio-1', { speechDurationMs: 10 });
    await harness.transcription.transcribe({ audioId: 'audio-1' });

    // The stored result — which the user may have edited under 27.11 — survives.
    expect(harness.transcription.download('audio-1').text).toBe(
      first.lines.map((line) => line.text).join('\n'),
    );
  });
});

describe('failure (Requirement 27.16)', () => {
  it('reports an engine failure with a reason code, preserving a stored result', async () => {
    const harness = createSpeechHarness();
    await harness.transcription.transcribe({ audioId: 'audio-1' });
    harness.transcriptionEngine.failNext('model crashed');

    await expect(harness.transcription.transcribe({ audioId: 'audio-1' })).rejects.toMatchObject({
      code: 'transcription_failed',
      details: { reasonCode: 'engine_failure', previousResultPreserved: true },
    });

    // The earlier result is still there.
    expect(harness.transcription.download('audio-1').text.length).toBeGreaterThan(0);
  });

  it('fails when 27.1\u2019s response budget elapses', async () => {
    const harness = createSpeechHarness();
    harness.transcriptionProbe.setAudio('audio-slow', {
      durationMs: 60_000,
      speechDurationMs: 50_000,
    });
    // The engine "takes" longer than the budget by moving the clock while it answers.
    const engine = harness.transcriptionEngine;
    const original = engine.transcribe.bind(engine);
    Object.assign(engine, {
      transcribe: async (request: Parameters<typeof original>[0]) => {
        // 60 s of audio on the fast tier is 3 s + 60 s of budget; 200 s is well past it.
        harness.generation.clock.advanceSeconds(200);
        return original(request);
      },
    });

    await expect(harness.transcription.transcribe({ audioId: 'audio-slow' })).rejects.toMatchObject({
      code: 'transcription_failed',
      details: { reasonCode: 'response_budget_exceeded' },
    });
  });
});

describe('editing (Requirements 27.11, 27.17)', () => {
  it('replaces a line\u2019s text and keeps its times (27.11)', async () => {
    const harness = createSpeechHarness();
    const before = await harness.transcription.transcribe({ audioId: 'audio-1' });

    const after = harness.transcription.editText('audio-1', 0, '  corrected text  ');

    expect(after.lines[0]?.text).toBe('corrected text');
    expect(after.lines[0]?.startMs).toBe(before.lines[0]?.startMs);
    expect(after.lines[0]?.endMs).toBe(before.lines[0]?.endMs);
    // Every other line is untouched.
    expect(after.lines.slice(1)).toEqual(before.lines.slice(1));
  });

  it('refuses text outside 1\u2013500 characters, keeping the timings (27.11)', async () => {
    const harness = createSpeechHarness();
    await harness.transcription.transcribe({ audioId: 'audio-1' });

    for (const text of ['', '   ', 'x'.repeat(501)]) {
      expect(() => harness.transcription.editText('audio-1', 0, text)).toThrowError();
    }
    expect(() => harness.transcription.editText('audio-1', 0, 'x'.repeat(500))).not.toThrowError();
  });

  it('moves a line\u2019s times when the result still satisfies 27.6\u201327.8', async () => {
    const harness = createSpeechHarness();
    await harness.transcription.transcribe({ audioId: 'audio-1' });

    const after = harness.transcription.editTiming('audio-1', 0, 50, 900);

    expect(after.lines[0]).toMatchObject({ startMs: 50, endMs: 900 });
    expect(isValidTranscription(after)).toBe(true);
  });

  it('refuses a time edit breaking an invariant, naming it and keeping the old times (27.17)', async () => {
    const harness = createSpeechHarness();
    const before = await harness.transcription.transcribe({ audioId: 'audio-1' });

    // End before start (27.7).
    expect(() => harness.transcription.editTiming('audio-1', 0, 900, 100)).toThrowError();
    // Past the audio (27.6).
    expect(() => harness.transcription.editTiming('audio-1', 0, 0, 99_000)).toThrowError();
    // Out of order relative to its successor (27.8).
    expect(() => harness.transcription.editTiming('audio-1', 1, 0, 200)).not.toThrowError();

    const error = (() => {
      try {
        harness.transcription.editTiming('audio-1', 0, 900, 100);
        return null;
      } catch (caught: unknown) {
        return caught as { readonly details: Record<string, unknown> };
      }
    })();
    expect(error?.details.violatedInvariants).toContain('non_positive_span');
    expect(error?.details.timingsUnchanged).toBe(true);
    expect(error?.details.permittedToMs).toBe(before.audioDurationMs);
  });
});

describe('download and Timed_Lyrics (Requirements 27.9, 27.10, 27.13)', () => {
  it('serialises through Requirement 10\u2019s LRC_Printer, so the round trip holds', async () => {
    const harness = createSpeechHarness();
    const transcription = await harness.transcription.transcribe({ audioId: 'audio-1' });
    const download = harness.transcription.download('audio-1');

    // 27.10 applies Requirement 10.4's ±10 ms round-trip bound to a transcription result too.
    const reparsed = parseLrc(download.lrc);
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    expect(reparsed.value.lines).toHaveLength(transcription.lines.length);
    reparsed.value.lines.forEach((line, index) => {
      expect(Math.abs(line.startMs - (transcription.lines[index]?.startMs ?? 0))).toBeLessThanOrEqual(
        10,
      );
      expect(line.text).toBe(transcription.lines[index]?.text);
    });
  });

  it('provides a plain-text file in the same line order (27.13)', async () => {
    const harness = createSpeechHarness();
    const transcription = await harness.transcription.transcribe({ audioId: 'audio-1' });
    const download = harness.transcription.download('audio-1');

    expect(download.text.split('\n')).toEqual(transcription.lines.map((line) => line.text));
    expect(download.lrcFileName).toBe('audio-1.lrc');
    expect(download.textFileName).toBe('audio-1.txt');
  });

  it('uses this service\u2019s line starts as the only timing source (27.9)', async () => {
    const harness = createSpeechHarness();
    const transcription = await harness.transcription.transcribe({ audioId: 'audio-1' });

    const timed = harness.transcription.timedLyricsOf(transcription);

    expect(timed.lines.map((line) => line.startMs)).toEqual(
      transcription.lines.map((line) => line.startMs),
    );
  });

  it('takes line text from a Lyrics_Document when one exists (27.9)', async () => {
    const harness = createSpeechHarness();
    const transcription = await harness.transcription.transcribe({ audioId: 'audio-1' });

    const timed = harness.transcription.timedLyricsOf(transcription, ['원문 첫 행']);

    // The document's text for the line it covers; the transcript's for the rest.
    expect(timed.lines[0]?.text).toBe('원문 첫 행');
    expect(timed.lines[1]?.text).toBe(transcription.lines[1]?.text);
    // The timings are still the transcription's.
    expect(timed.lines[0]?.startMs).toBe(transcription.lines[0]?.startMs);
  });

  it('answers 404 for audio with no stored result', () => {
    const harness = createSpeechHarness();

    expect(() => harness.transcription.download('nothing')).toThrowError();
  });
});

describe('the reference-text port (Requirement 26.6)', () => {
  it('joins the transcript lines into one text for a voice sample', async () => {
    const harness = createSpeechHarness();
    harness.transcriptionEngine.setOutput({
      lines: [
        { startMs: 0, endMs: 500, text: 'hello there' },
        { startMs: 600, endMs: 1_200, text: 'general' },
      ],
    });

    const outcome = await harness.transcription.transcribeReference({ uploadId: 'upload-1' });

    expect(outcome).toEqual({
      kind: 'transcribed',
      text: 'hello there general',
      languageCode: 'en',
    });
  });

  it('reports unavailable rather than throwing when the engine fails', async () => {
    const harness = createSpeechHarness();
    harness.transcriptionEngine.failNext();

    expect(await harness.transcription.transcribeReference({ uploadId: 'upload-1' })).toEqual({
      kind: 'unavailable',
      reasonCode: 'engine_failure',
    });
  });

  it('reports unavailable for a sample with no detected speech', async () => {
    const harness = createSpeechHarness();
    harness.transcriptionProbe.setAudio('upload-1', { speechDurationMs: 10 });

    expect(await harness.transcription.transcribeReference({ uploadId: 'upload-1' })).toEqual({
      kind: 'unavailable',
      reasonCode: 'no_speech_detected',
    });
  });
});
