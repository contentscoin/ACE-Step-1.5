import { describe, expect, it } from 'vitest';

import {
  WHISPER_TRANSCRIPTION_TIERS,
  createWhisperTranscriptionAdapter,
} from '../../../adapters/transcription';
import { parseLrc } from '../../../domain/lyrics/lrc-parser';
import { responseBudgetMs } from '../../../domain/transcription/model-tier';
import { isValidTranscription } from '../../../domain/transcription/result';
import { TranscriptionService } from '../../../services/transcription/transcription-service';
import { deterministicWhisperTransport } from '../../support/deterministic-whisper-transport';
import {
  createInMemoryTranscriptionStore,
  createScriptedTranscriptionProbe,
} from '../../support/speech-harness';
import { createMutableClock } from '../../support/mutable-clock';

/**
 * `Transcription_Service` composed with the **real** Whisper_Adapter.
 *
 * **Validates: Requirements 27.1, 27.3, 27.4, 27.6, 27.7, 27.8, 27.10, 27.12, 27.13, 27.16**
 *
 * Every other transcription test runs against `createScriptedTranscriptionEngine`, which is a
 * double written to return well-formed lines. That is the right shape for testing the service's
 * rules, and it is also why task 2.7 could be "done" with `adapters/transcription/` empty: nothing
 * asserted that a real adapter's output survives the service.
 *
 * This file closes that. The engine here is the production adapter over a transport that speaks
 * the envelope a Whisper server speaks — floating-point seconds, a leading space on every segment,
 * a language probability even for a hinted run — and the assertions are about the *seam*: that
 * what the adapter produces is what the service can normalise, store, print and fail on.
 */

const NOW = 1_700_000_000_000;
const AUDIO_ID = 'asset-a';

function harness(tierId = 'fast') {
  const transport = deterministicWhisperTransport();
  const probe = createScriptedTranscriptionProbe();
  const store = createInMemoryTranscriptionStore();
  const clock = createMutableClock(new Date(NOW));

  const service = new TranscriptionService({
    probe,
    engine: createWhisperTranscriptionAdapter({
      transport,
      objectKeyOf: (audioId) => `audio/${audioId}.flac`,
    }),
    store,
    clock,
    tiers: WHISPER_TRANSCRIPTION_TIERS,
  });

  return { service, transport, probe, store, clock, tierId };
}

describe('a transcription end to end (Requirements 27.1, 27.6-27.8)', () => {
  it('returns lines the invariants accept, from an engine answering in seconds', async () => {
    const { service, transport } = harness();
    transport.setSegments([
      { start: 0.4004, end: 1.9996, text: ' first line' },
      { start: 2.0, end: 3.5, text: ' second line' },
    ]);

    const result = await service.transcribe({ audioId: AUDIO_ID });

    expect(result.lines).toEqual([
      { startMs: 400, endMs: 2_000, text: 'first line' },
      { startMs: 2_000, endMs: 3_500, text: 'second line' },
    ]);
    expect(isValidTranscription(result)).toBe(true);
    expect(result.modelId).toBe('whisper-base');
  });

  it('reports the tier the caller selected, and its model', async () => {
    const { service } = harness();

    const result = await service.transcribe({ audioId: AUDIO_ID, tierId: 'accurate' });

    expect(result.tierId).toBe('accurate');
    expect(result.modelId).toBe('whisper-large-v3');
  });

  it('sends the selected tier s model to the engine', async () => {
    const { service, transport } = harness();

    await service.transcribe({ audioId: AUDIO_ID, tierId: 'accurate' });

    expect(transport.requests[0]?.body?.['model']).toBe('whisper-large-v3');
    expect(transport.requests[0]?.body?.['audio']).toMatchObject({
      object_key: 'audio/asset-a.flac',
    });
  });

  it('normalises a line the engine put past the end of the audio', async () => {
    // A model reporting a segment beyond the file is a model behaving normally at its edge, and
    // Requirement 27.6 is maintained by the service rather than by refusing the transcription.
    const { service, transport } = harness();
    transport.setSegments([{ start: 9.0, end: 99.0, text: ' overruns' }]);

    const result = await service.transcribe({ audioId: AUDIO_ID });

    expect(result.lines).toEqual([{ startMs: 9_000, endMs: 10_000, text: 'overruns' }]);
    expect(isValidTranscription(result)).toBe(true);
  });

  it('drops a segment that rounds to zero length', async () => {
    const { service, transport } = harness();
    transport.setSegments([
      { start: 1.0, end: 1.0002, text: ' blip' },
      { start: 2.0, end: 3.0, text: ' kept' },
    ]);

    const result = await service.transcribe({ audioId: AUDIO_ID });

    expect(result.lines.map((line) => line.text)).toEqual(['kept']);
  });

  it('sorts lines the engine returned out of order', async () => {
    const { service, transport } = harness();
    transport.setSegments([
      { start: 5.0, end: 6.0, text: ' later' },
      { start: 1.0, end: 2.0, text: ' earlier' },
    ]);

    const result = await service.transcribe({ audioId: AUDIO_ID });

    expect(result.lines.map((line) => line.text)).toEqual(['earlier', 'later']);
  });
});

describe('the language, through the whole stack (Requirements 27.3, 27.4)', () => {
  it('reports a hinted code with no confidence and no undetermined flag', async () => {
    // The simulator returns a probability for the hinted run, exactly as a real server does.
    const { service, transport } = harness();
    transport.setLanguage('en', 0.31);

    const result = await service.transcribe({ audioId: AUDIO_ID, languageCode: 'ko' });

    expect(result.language).toEqual({ languageCode: 'ko', confidence: null, undetermined: false });
  });

  it('flags a low-confidence detection as undetermined', async () => {
    const { service, transport } = harness();
    transport.setLanguage('ja', 0.31);

    const result = await service.transcribe({ audioId: AUDIO_ID });

    expect(result.language).toEqual({ languageCode: 'ja', confidence: 0.31, undetermined: true });
  });

  it('does not flag a confident detection', async () => {
    const { service, transport } = harness();
    transport.setLanguage('ja', 0.93);

    const result = await service.transcribe({ audioId: AUDIO_ID });

    expect(result.language.undetermined).toBe(false);
  });
});

describe('failure and preservation (Requirement 27.16)', () => {
  it('reports an engine HTTP failure as a reason code, keeping the stored result', async () => {
    const { service, transport, store } = harness();
    const first = await service.transcribe({ audioId: AUDIO_ID });
    expect(first.lines.length).toBeGreaterThan(0);

    transport.failNextWithStatus(503);
    const failure = await service
      .transcribe({ audioId: AUDIO_ID })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ statusCode: 422, code: 'transcription_failed' });
    expect((failure as { details: Record<string, unknown> }).details).toMatchObject({
      reasonCode: 'engine_failure',
      previousResultPreserved: true,
    });
    // The stored result — which a user may have edited under 27.11 — survives the failed attempt.
    expect(store.find(AUDIO_ID)?.lines).toEqual(first.lines);
  });

  it('carries the engine s own words in the detail, for an operator', async () => {
    const { service, transport } = harness();
    transport.answerNextWith({ error: 'model not loaded' });

    const failure = await service
      .transcribe({ audioId: AUDIO_ID })
      .catch((error: unknown) => error);

    expect((failure as { details: Record<string, unknown> }).details).toMatchObject({
      reasonCode: 'engine_failure',
      detail: 'model not loaded',
    });
  });

  it('reports a malformed envelope the same way', async () => {
    const { service, transport } = harness();
    transport.answerNextWith({ nonsense: true });

    const failure = await service
      .transcribe({ audioId: AUDIO_ID })
      .catch((error: unknown) => error);

    expect((failure as { details: Record<string, unknown> }).details).toMatchObject({
      reasonCode: 'engine_failure',
    });
  });

  it('answers inside the deadline 27.1 advertises for the selected tier', async () => {
    // The budget is measured from acceptance, and the adapter is a single round trip — so what
    // this pins is that composing the two does not blow the contract the tier list published.
    const { service, clock } = harness();
    const budget = responseBudgetMs(WHISPER_TRANSCRIPTION_TIERS[0]!, 10_000);
    const startedAt = clock.now().getTime();

    const result = await service.transcribe({ audioId: AUDIO_ID });

    expect(result.lines.length).toBeGreaterThan(0);
    expect(clock.now().getTime() - startedAt).toBeLessThanOrEqual(budget);
  });
});

describe('the no-speech path is decided before the engine (Requirement 27.12)', () => {
  it('never calls the adapter for audio with too little speech', async () => {
    const { service, transport, probe } = harness();
    probe.setAudio(AUDIO_ID, { speechDurationMs: 100 });

    const result = await service.transcribe({ audioId: AUDIO_ID });

    expect(result.reasonCode).toBe('no_speech_detected');
    expect(result.lines).toEqual([]);
    // The model run 27.12 exists to avoid was avoided.
    expect(transport.requests).toEqual([]);
  });
});

describe('the download path (Requirements 27.10, 27.13)', () => {
  it('prints LRC that task 2.3 s parser reads back within its tolerance', async () => {
    const { service, transport } = harness();
    transport.setSegments([
      { start: 0.4004, end: 1.9996, text: ' first line' },
      { start: 2.0, end: 3.5, text: ' second line' },
    ]);
    const result = await service.transcribe({ audioId: AUDIO_ID });

    const download = service.download(AUDIO_ID);
    const parsed = parseLrc(download.lrc);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.lines).toHaveLength(result.lines.length);
    parsed.value.lines.forEach((line, index) => {
      expect(Math.abs(line.startMs - (result.lines[index]?.startMs ?? 0))).toBeLessThanOrEqual(10);
      expect(line.text).toBe(result.lines[index]?.text);
    });
    expect(download.text.split('\n')).toEqual(result.lines.map((line) => line.text));
  });
});
