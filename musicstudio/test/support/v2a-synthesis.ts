/**
 * Synthesised foley audio and video metadata, for testing Requirement 23.
 *
 * The same discipline as `pcm-synthesis.ts`, which this module builds on rather than replaces:
 * every buffer is generated from a closed-form expression so its properties are *known*. That
 * is what lets the onset detector be checked against an independent prediction — a buffer with
 * impacts placed at 300 ms and 1200 ms must yield onsets at 300 ms and 1200 ms — instead of
 * against itself.
 *
 * Nothing here reads a file, decodes a container or reaches a network. **No video decoder and
 * no V2A engine exist in this environment**, so a "video" is its probed metadata record and
 * nothing more, which is exactly the shape `domain/v2a/validation.ts` is written over.
 */

import type { PcmAudio } from '../../domain/audio/pcm';
import type { ProbedVideoMetadata } from '../../domain/v2a/video-metadata';
import type { VisualEvent } from '../../domain/v2a/visual-event-timeline';

import { TEST_SAMPLE_RATE, frames, monoAudio } from './pcm-synthesis';

/** A probed record that passes every check of Requirements 23.2 and 23.3. */
export function validVideoMetadata(
  overrides: Partial<ProbedVideoMetadata> = {},
): ProbedVideoMetadata {
  return {
    uploadId: 'upload-1',
    container: 'mp4',
    videoStreamCount: 1,
    frameRate: 30,
    widthPx: 1920,
    heightPx: 1080,
    durationMs: 4_000,
    fileSizeBytes: 12_000_000,
    ...overrides,
  };
}

/**
 * How far an impact's energy decays, as a time constant in milliseconds.
 *
 * Short enough that two impacts 200 ms apart are separate events rather than one sustained
 * rise — which is what makes a synthesised buffer's onset count predictable — and long enough
 * that an impact spans several 5 ms analysis frames, so a detector reading one frame late
 * still sees it.
 */
const IMPACT_DECAY_MS = 40;

/** Level between impacts, as a fraction of the impact peak. */
const AMBIENCE_LEVEL = 0.004;

export interface FoleyAudioOptions {
  readonly durationMs: number;
  /** Impact start times, milliseconds. Any order; duplicates are harmless. */
  readonly impactTimesMs: readonly number[];
  readonly sampleRate?: number;
  readonly amplitude?: number;
  /** Low-level bed between impacts, so the buffer is not digital silence. */
  readonly ambience?: boolean;
}

/**
 * A bed with sharp impacts at the requested times — Requirement 23.8's subject.
 *
 * Each impact is an exponentially decaying burst of a fixed pseudo-random sequence, so the
 * buffer is deterministic and its short-term RMS jumps by far more than any plausible rise
 * threshold at exactly the requested instants. The bed is quiet but non-zero when `ambience`
 * is set, which matters: against digital silence *every* rise is infinite, and a detector that
 * only worked from silence would pass a test it should not.
 *
 * The rise at an impact is roughly `20·log10(1 / 0.004) ≈ 48 dB` above the bed, so it clears
 * Requirement 23.8's 6.0 dB initial threshold with two orders of magnitude to spare. A fixture
 * that only just cleared the threshold would turn every unrelated arithmetic change into a
 * mystery failure — the same reasoning `ONE_SHOT_TAIL_TARGET` documents.
 */
export function foleyAudio(options: FoleyAudioOptions): PcmAudio {
  const sampleRate = options.sampleRate ?? TEST_SAMPLE_RATE;
  const frameCount = Math.max(1, frames(options.durationMs, sampleRate));
  const amplitude = options.amplitude ?? 0.7;
  const samples = new Float32Array(frameCount);
  const bed = options.ambience === false ? 0 : AMBIENCE_LEVEL * amplitude;

  // A fixed low-frequency wobble for the bed: deterministic, and unlike a constant it has a
  // non-degenerate RMS in every window.
  for (let index = 0; index < frameCount; index += 1) {
    samples[index] = bed * Math.sin((2 * Math.PI * 40 * index) / sampleRate);
  }

  const decaySamples = Math.max(1, frames(IMPACT_DECAY_MS, sampleRate));
  for (const timeMs of options.impactTimesMs) {
    const start = frames(timeMs, sampleRate);
    if (start < 0 || start >= frameCount) continue;
    for (let offset = 0; start + offset < frameCount; offset += 1) {
      const envelope = Math.exp(-offset / decaySamples);
      if (envelope < 1e-4) break;
      // A deterministic pseudo-noise burst: a high-frequency tone with an irrational ratio to
      // the sample rate, so consecutive samples are effectively uncorrelated.
      const excitation = Math.sin(offset * 1.7320508075688772);
      samples[start + offset] = (samples[start + offset] ?? 0) + amplitude * envelope * excitation;
    }
  }

  return monoAudio(samples, sampleRate);
}

/**
 * Requirement 23.16's ambience: the bed alone, with no impacts.
 *
 * Not digital silence, for the reason above and one more: 23.16 requires ambience audio of the
 * clip's length, and a silent buffer would satisfy the length invariant while being useless as
 * ambience, which would make a test that accepted it evidence about nothing.
 */
export function ambienceAudio(durationMs: number, sampleRate = TEST_SAMPLE_RATE): PcmAudio {
  return foleyAudio({ durationMs, impactTimesMs: [], sampleRate });
}

/** A visual event at `timeMs`, confident by default. */
export function visualEvent(
  timeMs: number,
  overrides: Partial<VisualEvent> = {},
): VisualEvent {
  return { timeMs, confidence: 0.8, category: 'impact', ...overrides };
}
