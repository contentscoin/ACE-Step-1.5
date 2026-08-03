/**
 * The sound packs (Requirements 32.10, 32.17, 32.20, 32.23).
 *
 * ### The audio is synthesised, not shipped
 *
 * Requirement 32.17 caps the **runtime** at 20 KB gzipped and explicitly excludes audio assets —
 * but 78 cues × 2 packs of even short files is megabytes of download, and there is no licensed
 * asset set in this repository to ship. Each cue is therefore described as a handful of numbers
 * and rendered by an oscillator at play time: a shape, a pitch, a length, an envelope.
 *
 * That is a real product decision and it has a real consequence, recorded here rather than buried:
 * these are *synthesised* cues, and they sound like it. A designed pack would replace
 * `CueVoicing` with a URL per cue and nothing else in this directory would change — which is why
 * `SoundPack.voicing` is a function rather than a table of buffers.
 *
 * The upside is that 32.17 and 32.18 become structural: there is nothing to preload, so no browser
 * task is occupied for 50 ms, and the "assets" are a few hundred bytes of arithmetic.
 *
 * ### Two packs that differ in a way a user can hear
 *
 * Requirement 32.10 asks for at least two. `soft` is sine-based and quiet; `crisp` is
 * square/triangle and shorter. They differ in timbre and length rather than only in volume,
 * because a volume difference is what the volume control is for.
 */

import { cueDefinition, type CueSeverity, type SemanticCue } from './cues';

export const SOUND_PACK_IDS = ['soft', 'crisp'] as const;
export type SoundPackId = (typeof SOUND_PACK_IDS)[number];

export const DEFAULT_PACK_ID: SoundPackId = 'soft';

/** Everything the engine needs to make one cue audible. */
export interface CueVoicing {
  readonly wave: OscillatorType;
  readonly frequencyHz: number;
  /** For a loop, the length of one pass; for a one-shot, its whole length. */
  readonly durationMs: number;
  /** Peak gain before the layer's volume is applied, 0–1. */
  readonly peak: number;
}

export interface SoundPack {
  readonly id: SoundPackId;
  readonly name: string;
  readonly licence: string;
  voicing(cue: SemanticCue): CueVoicing;
}

/**
 * Pitch by severity, so the three states of Requirement 32.16 are also distinct by ear.
 *
 * Not a substitute for that clause — 32.16 is explicitly about *non-colour visual* channels and is
 * satisfied by the icon and the label in `CueAnnouncer`. This is the same distinction carried into
 * the channel the sound layer owns.
 */
const SEVERITY_BASE_HZ: Readonly<Record<CueSeverity, number>> = {
  neutral: 440,
  success: 660,
  warning: 392,
  error: 262,
};

/** A stable per-cue detune, so two neutral cues are not the same note. */
function cueOffsetHz(cue: SemanticCue): number {
  let hash = 0;
  for (const character of cue) hash = (hash * 31 + character.charCodeAt(0)) % 997;
  return (hash % 12) * 4;
}

export const SOUND_PACKS: Readonly<Record<SoundPackId, SoundPack>> = {
  soft: {
    id: 'soft',
    name: '부드러움',
    licence: 'MusicStudio 자체 합성 (오디오 파일 없음)',
    voicing(cue) {
      const definition = cueDefinition(cue);
      return {
        wave: 'sine',
        frequencyHz: SEVERITY_BASE_HZ[definition.severity] + cueOffsetHz(cue),
        durationMs: definition.kind === 'loop' ? 900 : 180,
        peak: definition.severity === 'error' ? 0.5 : 0.35,
      };
    },
  },
  crisp: {
    id: 'crisp',
    name: '또렷함',
    licence: 'MusicStudio 자체 합성 (오디오 파일 없음)',
    voicing(cue) {
      const definition = cueDefinition(cue);
      return {
        wave: definition.severity === 'error' ? 'square' : 'triangle',
        // An octave up, so switching packs mid-loop is audible — which is what makes the
        // ≤50 ms gap of Requirement 32.9 something a listener could actually catch us on.
        frequencyHz: (SEVERITY_BASE_HZ[definition.severity] + cueOffsetHz(cue)) * 2,
        durationMs: definition.kind === 'loop' ? 600 : 110,
        peak: definition.severity === 'error' ? 0.45 : 0.3,
      };
    },
  },
};

export function isSoundPackId(value: unknown): value is SoundPackId {
  return typeof value === 'string' && (SOUND_PACK_IDS as readonly string[]).includes(value);
}

export function soundPack(id: SoundPackId): SoundPack {
  return SOUND_PACKS[id];
}
