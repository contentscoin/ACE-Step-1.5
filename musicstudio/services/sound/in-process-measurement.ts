/**
 * The in-process `AudioMeasurementPort`, over PCM the product layer already holds.
 *
 * Deterministic and dependency-free: same samples in, bit-identical numbers out, no
 * worker, no temporary file, no clock. That is what lets the whole of Requirements
 * 21.7, 21.8, 21.16 and 21.17 be exercised against buffers a test synthesises — a
 * sine, a click, a fade — instead of against recordings whose properties would have to
 * be taken on trust.
 *
 * It is not a stand-in for task 3.1: the quantities are genuinely computed here, from
 * `domain/audio/`, and the same code path runs in production whenever the samples are
 * already in memory. The worker implementation exists for the case where they are not.
 */

import { integratedLoudnessLufs } from '../../domain/audio/loudness';
import { peakAbs, rms } from '../../domain/audio/level';
import {
  channelCount,
  durationMs,
  frameCount,
  windowSampleCount,
  type PcmAudio,
} from '../../domain/audio/pcm';
import { BGM_EDGE_WINDOW_MS, BGM_SEAM_WINDOW_MS } from '../../domain/bgm/bounds';
import type { ChannelLoopMeasurement, LoopMeasurement } from '../../domain/bgm/loop-seam';

import {
  MeasurementUnsupportedError,
  type AudioMeasurementPort,
  type AudioShape,
  type LoopMeasurementQuery,
  type MeasurementSubject,
} from './measurement';

export function createInProcessAudioMeasurement(): AudioMeasurementPort {
  return {
    measureLoop: async (query) => measureLoopSync(query),
    measureLoudnessLufs: async (subject) => integratedLoudnessLufs(pcmOf(subject)),
    measureShape: async (subject) => shapeOf(pcmOf(subject)),
  };
}

/** The synchronous core, exported so a property test can call it without a promise. */
export function measureLoopSync(query: LoopMeasurementQuery): LoopMeasurement {
  const audio = pcmOf(query.subject);
  const seamSamples = windowSampleCount(
    audio.sampleRate,
    query.seamWindowMs ?? BGM_SEAM_WINDOW_MS,
  );
  const edgeSamples = windowSampleCount(
    audio.sampleRate,
    query.edgeWindowMs ?? BGM_EDGE_WINDOW_MS,
  );

  return {
    sampleRate: audio.sampleRate,
    durationMs: durationMs(audio),
    bpm: query.bpm,
    timeSignature: query.timeSignature,
    integratedLoudnessLufs: integratedLoudnessLufs(audio),
    channels: audio.channels.map((channel) =>
      measureChannel(channel, seamSamples, edgeSamples),
    ),
  };
}

/**
 * One channel's eight numbers.
 *
 * The tail windows are taken from the *end* of the buffer, so a window longer than the
 * buffer collapses to the buffer rather than reading before its start — which is what
 * makes a 5-second minimum-length asset (Requirement 21.2) measurable with a 100 ms
 * edge window and a 1-sample asset measurable at all.
 */
function measureChannel(
  channel: Float32Array,
  seamSamples: number,
  edgeSamples: number,
): ChannelLoopMeasurement {
  const frames = channel.length;
  const seam = Math.min(seamSamples, frames);
  const edge = Math.min(edgeSamples, frames);

  return {
    headSeamRms: rms(channel, 0, seam),
    tailSeamRms: rms(channel, frames - seam, seam),
    headEdgeRms: rms(channel, 0, edge),
    tailEdgeRms: rms(channel, frames - edge, edge),
    overallRms: rms(channel, 0, frames),
    firstSample: channel[0] ?? 0,
    lastSample: channel[frames - 1] ?? 0,
    peakAbs: peakAbs(channel),
  };
}

function shapeOf(audio: PcmAudio): AudioShape {
  return {
    durationMs: durationMs(audio),
    sampleRate: audio.sampleRate,
    channels: channelCount(audio),
  };
}

function pcmOf(subject: MeasurementSubject): PcmAudio {
  if (subject.kind !== 'pcm') throw new MeasurementUnsupportedError(subject.kind);
  return subject.audio;
}

/** Frames in a subject, for a caller that only needs the length. */
export function subjectFrameCount(subject: MeasurementSubject): number {
  return frameCount(pcmOf(subject));
}
