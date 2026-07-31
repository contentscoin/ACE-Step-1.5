/**
 * Track volume automation for auto-ducking (Requirements 30.12, 30.16, 30.17).
 *
 * Requirement 30.17 makes the **automation curve the stored artefact**: "자동 감쇠 결과를
 * 트랙 음량 자동화 값으로 저장하여 사용자가 조회하고 수정할 수 있도록 한다". So the
 * curve is a value object in the domain, editable, validated, and independently checkable
 * against the two behavioural clauses — rather than an internal detail of whatever applied
 * the gain.
 *
 * ### Division of labour with the DSP worker
 *
 * Speech detection (Requirement 30.12's 100 ms / −45 dB / 200 ms rule) and envelope
 * generation both happen once, in `dsp/src/musicstudio_dsp/mastering.py`, because both
 * need the samples. The worker returns the regions it found *and* the breakpoints it
 * applied. This module then **verifies** those breakpoints against 30.12 and 30.16 rather
 * than regenerating them.
 *
 * That is deliberate, and it is the same arrangement `services/effects/effects-service.ts`
 * uses for Requirement 29.30's length invariant: the check is an independent statement of
 * what the clause requires, written from the clause, so a generator that drifted is caught
 * by something that does not share its code. Regenerating the curve here and comparing
 * would only prove the two implementations agree, which is a weaker claim and costs a
 * second implementation of the envelope.
 *
 * ### The envelope shape, and the one place the spec conflicts with itself
 *
 * For each speech region `[s, e)` the curve is: a ramp from 0 dB to `depthDb` over
 * `attackMs` **ending at `s`**, a hold at `depthDb` across `[s, e)`, and a ramp back to
 * 0 dB over `releaseMs` starting at `e`. Overlapping envelopes take the lower (more
 * attenuated) gain.
 *
 * The attack ramp *ends* at `s` rather than starting there — a look-ahead — because
 * Requirement 30.12 requires the music to be attenuated to within ±1.0 dB of the depth
 * across the whole speech region, and an attack that began at `s` would leave the first
 * `attackMs` of every line under-ducked. Look-ahead is available because this is offline
 * processing of a stored track, not a live mixer.
 *
 * **Spec conflict, stated rather than papered over.** Requirement 30.16 says that *while*
 * a section is not speech, the music must stay within ±0.5 dB of its pre-duck level.
 * Requirements 30.14 and 30.15 simultaneously mandate an attack of 10–500 ms and a release
 * of 50–2000 ms, and a ramp is by definition attenuated and by definition outside the
 * speech region. Read literally the three clauses cannot all hold for any non-zero attack
 * or release. The reading taken here is that 30.16 constrains the non-speech time
 * *excluding* the transition ramps — the steady state — which is the only reading under
 * which 30.14 and 30.15 are satisfiable. `duckingDefects` therefore exempts the ramp
 * intervals, and reports every other non-speech excursion. **This should be confirmed with
 * the spec owner**; if 30.16 is meant literally, the attack and release ranges cannot
 * include their current minima and the requirement needs restating.
 */

import { DUCKING_DEPTH_DB, isWithin } from './bounds';

import type { DuckingThresholds } from '../quality/mastering-thresholds';

/** A region judged to hold speech (Requirement 30.12). Half-open `[startMs, endMs)`. */
export interface SpeechRegion {
  readonly startMs: number;
  readonly endMs: number;
}

/**
 * One breakpoint on a track's volume automation curve (Requirement 30.17).
 *
 * `gainDb` is an offset from the track's own volume, not an absolute level, so an edit to
 * the track fader and an edit to the ducking curve compose instead of one overwriting the
 * other. 0 dB is therefore "as it was before ducking", which is the reference Requirement
 * 30.16 measures against.
 */
export interface VolumeAutomationPoint {
  readonly timeMs: number;
  readonly gainDb: number;
}

export interface TrackVolumeAutomation {
  /** Ascending in `timeMs`. Values between points are linear in dB. */
  readonly points: readonly VolumeAutomationPoint[];
  /** The regions the worker judged to hold speech, for the user to see why. */
  readonly speechRegions: readonly SpeechRegion[];
  /** The parameters in force, echoed so an edited curve keeps its provenance. */
  readonly depthDb: number;
  readonly attackMs: number;
  readonly releaseMs: number;
  readonly durationMs: number;
}

/** Gain at `timeMs`, linear in dB between breakpoints, flat outside them. */
export function gainAtMs(automation: TrackVolumeAutomation, timeMs: number): number {
  const { points } = automation;
  if (points.length === 0) return 0;

  const first = points[0];
  const last = points[points.length - 1];
  if (first === undefined || last === undefined) return 0;
  if (timeMs <= first.timeMs) return first.gainDb;
  if (timeMs >= last.timeMs) return last.gainDb;

  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (previous === undefined || current === undefined) continue;
    if (timeMs > current.timeMs) continue;
    const span = current.timeMs - previous.timeMs;
    if (span <= 0) return current.gainDb;
    const position = (timeMs - previous.timeMs) / span;
    return previous.gainDb + position * (current.gainDb - previous.gainDb);
  }
  return last.gainDb;
}

export type AutomationDefect =
  /** Requirement 30.17: a curve the user could not meaningfully edit. */
  | { readonly kind: 'no_points' }
  | { readonly kind: 'time_not_ascending'; readonly index: number }
  | { readonly kind: 'non_finite'; readonly index: number }
  | { readonly kind: 'time_out_of_bounds'; readonly index: number }
  /** Gain outside `[depthDb, 0]`: a duck that boosted, or one deeper than requested. */
  | { readonly kind: 'gain_out_of_range'; readonly index: number }
  /** Requirement 30.13: the depth itself is outside the permitted range. */
  | { readonly kind: 'depth_out_of_range' }
  /** Requirement 30.12: a speech region not attenuated to the requested depth. */
  | { readonly kind: 'speech_region_under_ducked'; readonly regionIndex: number; readonly worstGainDb: number }
  /** Requirement 30.16: the bed moved outside a ramp while no speech was present. */
  | { readonly kind: 'non_speech_level_moved'; readonly timeMs: number; readonly gainDb: number }
  /** A region with `endMs <= startMs`, or one overlapping its predecessor. */
  | { readonly kind: 'speech_region_malformed'; readonly regionIndex: number };

/**
 * Structural validity of a curve (Requirement 30.17), independent of the audio.
 *
 * Run on a user edit as well as on what the worker returned, which is the point of having
 * it: 30.17 lets the user modify the values, and a modification that put two points at the
 * same instant or asked for +6 dB is not a ducking curve any more.
 */
export function automationStructureDefects(
  automation: TrackVolumeAutomation,
): readonly AutomationDefect[] {
  const defects: AutomationDefect[] = [];

  if (!isWithin(DUCKING_DEPTH_DB, automation.depthDb)) {
    defects.push({ kind: 'depth_out_of_range' });
  }
  if (automation.points.length === 0) {
    defects.push({ kind: 'no_points' });
    return defects;
  }

  automation.points.forEach((point, index) => {
    if (!Number.isFinite(point.timeMs) || !Number.isFinite(point.gainDb)) {
      defects.push({ kind: 'non_finite', index });
      return;
    }
    if (point.timeMs < 0 || point.timeMs > automation.durationMs) {
      defects.push({ kind: 'time_out_of_bounds', index });
    }
    // A duck attenuates: above 0 dB it is a boost, below the depth it is deeper than the
    // user asked for. Both are outside what 30.12/30.13 describe.
    if (point.gainDb > 0 || point.gainDb < automation.depthDb) {
      defects.push({ kind: 'gain_out_of_range', index });
    }
    const previous = automation.points[index - 1];
    if (previous !== undefined && point.timeMs <= previous.timeMs) {
      defects.push({ kind: 'time_not_ascending', index });
    }
  });

  automation.speechRegions.forEach((region, regionIndex) => {
    const previous = automation.speechRegions[regionIndex - 1];
    if (
      !Number.isFinite(region.startMs) ||
      !Number.isFinite(region.endMs) ||
      region.endMs <= region.startMs ||
      (previous !== undefined && region.startMs < previous.endMs)
    ) {
      defects.push({ kind: 'speech_region_malformed', regionIndex });
    }
  });

  return defects;
}

/**
 * Requirements 30.12 and 30.16 as verdicts on the curve.
 *
 * Sampled rather than solved analytically. The curve is piecewise linear, so its extremes
 * lie at breakpoints — but a *user-edited* curve (30.17) can put a breakpoint anywhere,
 * including in the middle of a speech region, and sampling at the breakpoints plus the
 * region boundaries covers every extreme of a piecewise-linear function. `sampleStepMs`
 * adds interior samples so that a defect is reported at a recognisable instant rather than
 * only at the breakpoint that caused it.
 *
 * 30.12: every instant inside a speech region must be attenuated to within
 * `depthAccuracyDb` of `depthDb`. Reported once per region, with the worst gain found.
 *
 * 30.16: every instant outside a speech region *and outside a transition ramp* must be
 * within `nonSpeechHoldDb` of 0 dB. See the module comment on why the ramps are exempt.
 */
export function duckingDefects(
  automation: TrackVolumeAutomation,
  thresholds: DuckingThresholds,
  sampleStepMs = 10,
): readonly AutomationDefect[] {
  const defects: AutomationDefect[] = [...automationStructureDefects(automation)];
  if (defects.length > 0) return defects;

  automation.speechRegions.forEach((region, regionIndex) => {
    let worstGainDb = automation.depthDb;
    let worstError = 0;
    for (const timeMs of sampleTimes(region.startMs, region.endMs, sampleStepMs, automation)) {
      const gainDb = gainAtMs(automation, timeMs);
      const error = Math.abs(gainDb - automation.depthDb);
      if (error > worstError) {
        worstError = error;
        worstGainDb = gainDb;
      }
    }
    if (worstError > thresholds.depthAccuracyDb) {
      defects.push({ kind: 'speech_region_under_ducked', regionIndex, worstGainDb });
    }
  });

  for (const timeMs of steadyStateNonSpeechTimes(automation, sampleStepMs)) {
    const gainDb = gainAtMs(automation, timeMs);
    if (Math.abs(gainDb) > thresholds.nonSpeechHoldDb) {
      defects.push({ kind: 'non_speech_level_moved', timeMs, gainDb });
      // One report is enough: a curve that drifts at one steady-state instant drifts
      // across an interval, and a defect per sample would bury every other finding.
      break;
    }
  }

  return defects;
}

/** Breakpoints and grid samples inside `[fromMs, toMs]`, inclusive of both ends. */
function sampleTimes(
  fromMs: number,
  toMs: number,
  stepMs: number,
  automation: TrackVolumeAutomation,
): readonly number[] {
  const times = new Set<number>([fromMs, toMs]);
  for (const point of automation.points) {
    if (point.timeMs > fromMs && point.timeMs < toMs) times.add(point.timeMs);
  }
  const step = Math.max(1, stepMs);
  for (let timeMs = fromMs + step; timeMs < toMs; timeMs += step) times.add(timeMs);
  return [...times].sort((left, right) => left - right);
}

/**
 * Non-speech instants that are neither in an attack look-ahead nor in a release tail.
 *
 * The exempt window around a region `[s, e)` is `[s − attackMs, e + releaseMs]`. Everything
 * outside every such window, and outside every region, is steady state.
 */
function steadyStateNonSpeechTimes(
  automation: TrackVolumeAutomation,
  stepMs: number,
): readonly number[] {
  const exempt = automation.speechRegions.map((region) => ({
    fromMs: region.startMs - automation.attackMs,
    toMs: region.endMs + automation.releaseMs,
  }));
  const isExempt = (timeMs: number): boolean =>
    exempt.some((window) => timeMs >= window.fromMs && timeMs <= window.toMs);

  const candidates = new Set<number>([0, automation.durationMs]);
  for (const point of automation.points) candidates.add(point.timeMs);
  const step = Math.max(1, stepMs);
  for (let timeMs = 0; timeMs < automation.durationMs; timeMs += step) candidates.add(timeMs);

  return [...candidates]
    .filter((timeMs) => timeMs >= 0 && timeMs <= automation.durationMs && !isExempt(timeMs))
    .sort((left, right) => left - right);
}

export function isValidDuckingAutomation(
  automation: TrackVolumeAutomation,
  thresholds: DuckingThresholds,
): boolean {
  return duckingDefects(automation, thresholds).length === 0;
}

/** Total speech time in a region list, in ms. For the response and for audit. */
export function speechDurationMs(regions: readonly SpeechRegion[]): number {
  return regions.reduce((total, region) => total + Math.max(0, region.endMs - region.startMs), 0);
}
