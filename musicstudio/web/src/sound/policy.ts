/**
 * What happens when a cue is played — decided without touching audio.
 *
 * **Validates: Requirements 32.4, 32.5, 32.6, 32.8, 32.14, 32.21, 32.22**
 *
 * ### Why the decision is a pure function over a value
 *
 * Every rule Requirement 32 states about *playing* is a rule about the set of sounding voices:
 * there are at most eight (32.5), a repeat of a sounding loop adds none (32.6), a ninth request
 * evicts the oldest one-shot and never a loop (32.21), a cue played twice inside 50 ms is
 * suppressed (32.8), and a disabled or locked layer plays nothing (32.14, 32.4). None of those is
 * a statement about the Web Audio API.
 *
 * Writing them against an `AudioContext` would make them true only where an `AudioContext` exists,
 * and Requirement 32.5 is an **invariant** — the kind of claim that wants to be checked over
 * thousands of generated sequences, which is what `test/sound/voice-invariants.test.ts` does. A
 * policy that needed a browser could be checked over a handful of hand-written ones.
 *
 * `decidePlay` therefore takes the current voice list and returns what should happen; `layer.ts`
 * is the part that carries it out, and it is small enough to read in one screen.
 *
 * ### The eviction rule is "oldest one-shot", and the ordering has to be total
 *
 * Requirement 32.21 evicts the instance whose **start time is earliest**. Two voices can start in
 * the same millisecond — a click that fires two cues does exactly that — so `startedAtMs` alone is
 * not a total order and the tie would be broken by whatever `Array.prototype.sort` happened to do.
 * Voices therefore carry a monotonic `sequence`, and the comparison falls back to it. Without that,
 * the invariant test passes and which sound survives is unpredictable.
 */

import { cueDefinition, type SemanticCue } from './cues';

/** Requirement 32.5. */
export const MAX_VOICES = 8;

/** Requirement 32.8. */
export const MIN_CUE_INTERVAL_MS = 50;

/** Requirements 32.4, 32.14: the answers the layer must return, and no others. */
export const SUPPRESSION_REASONS = ['unlock_pending', 'min_interval', 'sound_disabled'] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

/** Design §8.3's `PlayResult`. */
export interface PlayResult {
  readonly played: boolean;
  readonly handle?: string;
  readonly suppressionReason?: SuppressionReason;
}

export interface Voice {
  readonly handle: string;
  readonly cue: SemanticCue;
  readonly loop: boolean;
  readonly startedAtMs: number;
  /** Monotonic tie-breaker — see the module header. */
  readonly sequence: number;
}

export interface PolicyState {
  readonly enabled: boolean;
  readonly unlocked: boolean;
  readonly voices: readonly Voice[];
  /** Last *start* time per cue, for Requirement 32.8. Suppressed requests do not update it. */
  readonly lastStartedAtMs: Readonly<Partial<Record<SemanticCue, number>>>;
  readonly nextSequence: number;
}

export function initialPolicyState(enabled: boolean): PolicyState {
  return { enabled, unlocked: false, voices: [], lastStartedAtMs: {}, nextSequence: 0 };
}

/**
 * What a play request does.
 *
 * `start` names the voice to create and `evict` the voice to stop first; `result` is what the
 * caller returns to the product. A decision with `played: false` never carries either, which is
 * what makes "suppressed" and "played" impossible to confuse at the call site.
 */
export type PlayDecision =
  | { readonly kind: 'suppressed'; readonly result: PlayResult; readonly state: PolicyState }
  | {
      readonly kind: 'reuse';
      readonly result: PlayResult;
      readonly state: PolicyState;
      readonly handle: string;
    }
  | {
      readonly kind: 'start';
      readonly result: PlayResult;
      readonly state: PolicyState;
      readonly voice: Voice;
      /** Requirement 32.21: the one-shot to stop first, when the layer was already full. */
      readonly evict: Voice | null;
    };

function suppressed(state: PolicyState, reason: SuppressionReason): PlayDecision {
  return { kind: 'suppressed', result: { played: false, suppressionReason: reason }, state };
}

/**
 * Requirement 32.21's victim: the earliest-started **one-shot**.
 *
 * Returns `null` when every voice is a loop, which is a state the layer must handle rather than
 * force: eight concurrent loops is eight states the user is genuinely waiting inside, and stopping
 * one of them to make room for a click would remove a status indicator to play a decoration.
 */
export function evictionCandidate(voices: readonly Voice[]): Voice | null {
  let oldest: Voice | null = null;
  for (const voice of voices) {
    if (voice.loop) continue;
    if (
      oldest === null ||
      voice.startedAtMs < oldest.startedAtMs ||
      (voice.startedAtMs === oldest.startedAtMs && voice.sequence < oldest.sequence)
    ) {
      oldest = voice;
    }
  }
  return oldest;
}

export function soundingLoop(voices: readonly Voice[], cue: SemanticCue): Voice | undefined {
  return voices.find((voice) => voice.loop && voice.cue === cue);
}

export function decidePlay(
  state: PolicyState,
  cue: SemanticCue,
  nowMs: number,
  handleFor: (cue: SemanticCue, sequence: number) => string,
): PlayDecision {
  // Requirement 32.14 before 32.4: a disabled layer is disabled whether or not it was unlocked,
  // and reporting `unlock_pending` to a user who turned sound off would name the wrong cause.
  if (!state.enabled) return suppressed(state, 'sound_disabled');
  if (!state.unlocked) return suppressed(state, 'unlock_pending');

  const definition = cueDefinition(cue);

  // Requirement 32.6 — Property 19. Checked *before* the interval gate on purpose: a repeat of a
  // sounding loop is not a suppressed request, it is the same instance continuing, and reporting
  // `min_interval` for it would tell the caller its loop had not started.
  if (definition.kind === 'loop') {
    const existing = soundingLoop(state.voices, cue);
    if (existing !== undefined) {
      return {
        kind: 'reuse',
        // Requirement 32.6: the same handle, the voice count unchanged, the playhead untouched.
        result: { played: true, handle: existing.handle },
        state,
        handle: existing.handle,
      };
    }
  }

  // Requirement 32.8. Strictly less than: a request exactly 50 ms after the last start is
  // "50 밀리초가 경과" and plays.
  const last = state.lastStartedAtMs[cue];
  if (last !== undefined && nowMs - last < MIN_CUE_INTERVAL_MS) {
    return suppressed(state, 'min_interval');
  }

  const voice: Voice = {
    handle: handleFor(cue, state.nextSequence),
    cue,
    loop: definition.kind === 'loop',
    startedAtMs: nowMs,
    sequence: state.nextSequence,
  };

  // Requirement 32.21: only when already at the cap.
  const evict = state.voices.length >= MAX_VOICES ? evictionCandidate(state.voices) : null;

  // Nothing to evict and no room: the request is dropped rather than breaking the 32.5 invariant.
  // Not a suppression reason — design §8.3 lists three and this is not one of them — so it is
  // reported as an unplayed result with no reason, and `layer.ts` logs it.
  if (evict === null && state.voices.length >= MAX_VOICES) {
    return { kind: 'suppressed', result: { played: false }, state };
  }

  const kept = evict === null ? state.voices : state.voices.filter((v) => v.handle !== evict.handle);

  return {
    kind: 'start',
    result: { played: true, handle: voice.handle },
    state: {
      ...state,
      voices: [...kept, voice],
      lastStartedAtMs: { ...state.lastStartedAtMs, [cue]: nowMs },
      nextSequence: state.nextSequence + 1,
    },
    voice,
    evict,
  };
}

/** Requirements 32.7, 32.19: remove a voice by handle. Unknown handles are a no-op, not an error. */
export function withVoiceStopped(state: PolicyState, handle: string): PolicyState {
  return { ...state, voices: state.voices.filter((voice) => voice.handle !== handle) };
}

/** Requirement 32.19: every loop stops, one-shots are left to finish on their own. */
export function withLoopsStopped(state: PolicyState): {
  readonly state: PolicyState;
  readonly stopped: readonly Voice[];
} {
  const stopped = state.voices.filter((voice) => voice.loop);
  return { state: { ...state, voices: state.voices.filter((voice) => !voice.loop) }, stopped };
}

/** Requirement 32.14: disabling holds the voice count at zero, so everything stops. */
export function withAllStopped(state: PolicyState): {
  readonly state: PolicyState;
  readonly stopped: readonly Voice[];
} {
  return { state: { ...state, voices: [] }, stopped: state.voices };
}

/** Requirement 32.5, as a predicate a test can assert after every step. */
export function voiceInvariantHolds(state: PolicyState): boolean {
  return state.voices.length >= 0 && state.voices.length <= MAX_VOICES;
}
