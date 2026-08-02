import { createAceLyricsFormatPort } from '../../adapters/ace/format-input';
import type { TimedLyricLine } from '../../domain/lyrics/timed-lyrics';
import {
  createLyricsAssistant,
  type LyricsAssistant,
} from '../../services/lyrics/lyrics-assistant';
import type { LyricVideoPort, LyricVideoRequest } from '../../services/lyrics/lyric-video-port';
import {
  createTimedLyricsService,
  type TimedLyricsService,
} from '../../services/lyrics/timed-lyrics-service';
import type { TimedLyricsSourcePort } from '../../services/lyrics/timing-port';

import {
  createScriptedAceTransport,
  type ScriptedAceTransport,
} from './scripted-ace-transport';

/**
 * Lyrics_Assistant wired the way production wires it, with only the engine faked.
 *
 * The real `createAceLyricsFormatPort` adapter is under test here — the substitution
 * happens one level lower, at the shared `AceTransport` seam — so a bug in the
 * `/format_input` wire body or in the response decoding surfaces in these suites
 * rather than against a running engine (which design §1.4.1 puts in another
 * deployment and CI does not have).
 *
 * Notably absent: anything to do with credits. Requirement 8.6 says enrichment leaves
 * the balance untouched, and the harness has no way to charge, which is the same
 * guarantee the production service has.
 */
export interface LyricsHarness {
  readonly transport: ScriptedAceTransport;
  readonly assistant: LyricsAssistant;
  readonly timings: ConfigurableTimedLyricsSource;
  readonly timedLyrics: TimedLyricsService;
}

export interface LyricsHarnessOptions {
  readonly temperature?: number;
}

export function createLyricsHarness(options: LyricsHarnessOptions = {}): LyricsHarness {
  const transport = createScriptedAceTransport();
  const timings = createConfigurableTimedLyricsSource();

  return {
    transport,
    timings,
    assistant: createLyricsAssistant({
      formatPort: createAceLyricsFormatPort(transport),
      ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    }),
    timedLyrics: createTimedLyricsService({ source: timings }),
  };
}

/**
 * Stand-in for Transcription_Service's timing store (Requirement 27.9, task 2.7).
 *
 * Returns exactly what the test put in, in the order the test put it in — including
 * out-of-order lines, so Requirement 10.5's ordering can be shown to come from this
 * package rather than from a conveniently sorted source.
 */
export interface ConfigurableTimedLyricsSource extends TimedLyricsSourcePort {
  set(trackId: string, lines: readonly TimedLyricLine[]): void;
  readonly requestedTrackIds: readonly string[];
}

export function createConfigurableTimedLyricsSource(): ConfigurableTimedLyricsSource {
  const byTrack = new Map<string, readonly TimedLyricLine[]>();
  const requestedTrackIds: string[] = [];

  return {
    requestedTrackIds,
    set(trackId, lines) {
      byTrack.set(trackId, lines);
    },
    async timingsFor(trackId) {
      requestedTrackIds.push(trackId);
      return byTrack.get(trackId) ?? null;
    },
  };
}

/** Records what a lyric-video renderer was asked for, without rendering anything. */
export interface RecordingLyricVideoPort extends LyricVideoPort {
  readonly requests: readonly LyricVideoRequest[];
}

export function createRecordingLyricVideoPort(): RecordingLyricVideoPort {
  const requests: LyricVideoRequest[] = [];
  return {
    requests,
    async render(request) {
      requests.push(request);
      return { videoAssetId: `video-for-${request.trackId}` };
    },
  };
}
