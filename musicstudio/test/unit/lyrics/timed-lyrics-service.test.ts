import { describe, expect, it } from 'vitest';

import { parseLrc } from '../../../domain/lyrics/lrc-parser';
import { isNonDecreasingByTime } from '../../../domain/lyrics/timed-lyrics';
import {
  LYRIC_VIDEO_DISABLED,
  requestLyricVideo,
} from '../../../services/lyrics/lyric-video-port';
import { createTimedLyricsService } from '../../../services/lyrics/timed-lyrics-service';
import {
  createConfigurableTimedLyricsSource,
  createRecordingLyricVideoPort,
} from '../../support/lyrics-harness';

/**
 * `TimedLyricsService` (Requirements 10.5, 10.7, 10.8) and the Requirement 10.9 gate.
 *
 * The timing source stands in for Transcription_Service, which Requirement 27.9 makes
 * the only source of line timings and which task 2.7 owns. Requirement 10.1's trigger
 * — producing Timed_Lyrics when a vocal Track finishes — belongs there too; what is
 * under test here is the read side that turns stored timings into an LRC file.
 */

const TRACK = { trackId: 'track-1', trackDurationMs: 180_000 } as const;

function serviceWith(lines: readonly { startMs: number; text: string }[]) {
  const timings = createConfigurableTimedLyricsSource();
  timings.set(TRACK.trackId, lines);
  return { timings, service: createTimedLyricsService({ source: timings }) };
}

describe('Requirement 10.8 — a download returns an LRC file', () => {
  it('returns the printed LRC and a filename', async () => {
    const { service } = serviceWith([
      { startMs: 1_000, text: 'first line' },
      { startMs: 4_250, text: 'second line' },
    ]);

    const outcome = await service.lrcFor(TRACK);
    if (outcome.kind !== 'available') throw new Error(`expected LRC, got ${outcome.kind}`);

    expect(outcome.lrc).toBe('[00:01.00]first line\n[00:04.25]second line\n');
    expect(outcome.fileName).toBe('track-1.lrc');
  });

  it('returns a body that parses back to the same Timed_Lyrics', async () => {
    // The download and the upload path are the same serialisation, which is what
    // Requirements 10.2/10.3 being a single pair buys.
    const { service } = serviceWith([
      { startMs: 0, text: 'a' },
      { startMs: 30_500, text: 'b' },
    ]);

    const outcome = await service.lrcFor(TRACK);
    if (outcome.kind !== 'available') throw new Error('expected LRC');

    const reparsed = parseLrc(outcome.lrc);
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) throw new Error('unreachable');
    expect(reparsed.value).toEqual(outcome.timedLyrics);
  });

  it('reports the track as having no Timed_Lyrics when the source has none', async () => {
    const service = createTimedLyricsService({ source: createConfigurableTimedLyricsSource() });
    expect(await service.lrcFor(TRACK)).toEqual({ kind: 'unavailable' });
  });

  it('reports an empty timing list as unavailable rather than as an empty file', async () => {
    // An empty LRC file would look like a successful download of nothing.
    const { service } = serviceWith([]);
    expect(await service.lrcFor(TRACK)).toEqual({ kind: 'unavailable' });
  });
});

describe('Requirement 10.5 — the served Timed_Lyrics is ordered', () => {
  it('sorts timings the source returned out of order', async () => {
    const { service } = serviceWith([
      { startMs: 9_000, text: 'third' },
      { startMs: 1_000, text: 'first' },
      { startMs: 5_000, text: 'second' },
    ]);

    const outcome = await service.lrcFor(TRACK);
    if (outcome.kind !== 'available') throw new Error('expected LRC');

    expect(isNonDecreasingByTime(outcome.timedLyrics)).toBe(true);
    expect(outcome.timedLyrics.lines.map((line) => line.text)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });
});

describe('Requirement 10.7 — timestamps stay within 0..track length', () => {
  it('accepts a timestamp exactly at the track length', async () => {
    // "이하" is inclusive: a final line landing on the last sample is in range.
    const { service } = serviceWith([{ startMs: TRACK.trackDurationMs, text: 'last' }]);
    expect((await service.lrcFor(TRACK)).kind).toBe('available');
  });

  it('refuses timings past the end of the track, naming the offending lines', async () => {
    const { service } = serviceWith([
      { startMs: 1_000, text: 'fine' },
      { startMs: TRACK.trackDurationMs + 1, text: 'too late' },
      { startMs: TRACK.trackDurationMs + 5_000, text: 'far too late' },
    ]);

    const outcome = await service.lrcFor(TRACK);
    expect(outcome.kind).toBe('out_of_bounds');
    if (outcome.kind !== 'out_of_bounds') throw new Error('unreachable');

    // Line numbers are 1-based and refer to the *ordered* result, which is the order
    // the file would have been written in.
    expect(outcome.errors.map((error) => error.line)).toEqual([2, 3]);
    expect(outcome.errors[0]?.violation).toBe('timestamp_outside_track');
    expect(outcome.errors[0]?.expected).toBe('0..180000 ms');
  });

  it('refuses a negative timestamp', async () => {
    const { service } = serviceWith([{ startMs: -1, text: 'before the start' }]);
    expect((await service.lrcFor(TRACK)).kind).toBe('out_of_bounds');
  });

  it('does not clamp or drop the offending line', async () => {
    // Clamping would satisfy the letter of 10.7 while silently moving a line; dropping
    // would silently lose lyric text. Both would hide a broken timing source.
    const { service } = serviceWith([{ startMs: TRACK.trackDurationMs + 10, text: 'late' }]);
    const outcome = await service.lrcFor(TRACK);
    expect(outcome).not.toHaveProperty('lrc');
  });
});

describe('Requirement 10.9 — lyric video generation is gated on the feature flag', () => {
  const request = {
    trackId: 'track-1',
    audioAssetId: 'asset-1',
    timedLyrics: { lines: [{ startMs: 0, text: 'a' }] },
  } as const;

  it('does nothing when the feature is off', async () => {
    expect(await requestLyricVideo(LYRIC_VIDEO_DISABLED, request)).toEqual({ kind: 'disabled' });
  });

  it('does nothing when the feature is on but no renderer is wired', async () => {
    // A misconfigured flag must not fail a Requirement 10.8 download, which is promised
    // independently of 10.9.
    expect(await requestLyricVideo({ enabled: true }, request)).toEqual({ kind: 'disabled' });
  });

  it('does nothing when a renderer is wired but the feature is off', async () => {
    const port = createRecordingLyricVideoPort();
    expect(await requestLyricVideo({ enabled: false, port }, request)).toEqual({ kind: 'disabled' });
    expect(port.requests).toEqual([]);
  });

  it('delegates to the renderer with the audio and the ordered Timed_Lyrics', async () => {
    const port = createRecordingLyricVideoPort();
    const outcome = await requestLyricVideo({ enabled: true, port }, request);

    expect(outcome).toEqual({ kind: 'rendered', rendition: { videoAssetId: 'video-for-track-1' } });
    expect(port.requests).toEqual([request]);
  });

  it('hands the renderer the same Timed_Lyrics the LRC was printed from', async () => {
    // Requirement 10.9 says "Track 오디오와 Timed_Lyrics를 사용하여", so the video and the
    // downloadable file must not be able to disagree about the timings.
    const { service } = serviceWith([
      { startMs: 5_000, text: 'b' },
      { startMs: 1_000, text: 'a' },
    ]);
    const outcome = await service.lrcFor(TRACK);
    if (outcome.kind !== 'available') throw new Error('expected LRC');

    const port = createRecordingLyricVideoPort();
    await requestLyricVideo(
      { enabled: true, port },
      { trackId: TRACK.trackId, audioAssetId: 'asset-1', timedLyrics: outcome.timedLyrics },
    );

    expect(port.requests[0]?.timedLyrics).toBe(outcome.timedLyrics);
  });
});
