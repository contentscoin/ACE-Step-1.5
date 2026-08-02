/**
 * Background-music request vocabulary (Requirement 21).
 *
 * Engine-agnostic like `domain/song/request.ts`: mood, scene, instrumentation, a
 * target length, whether it loops, and optionally a reference asset to match. The
 * translation into ACE-Step's fields never happens here — a validated
 * `BgmParameters` becomes a Custom_Mode song request (see `song-request.ts`), which
 * `adapters/ace/` already knows how to put on the wire.
 *
 * Requirement 21.4 is expressed in the *type*, not in a runtime check: there is no
 * `lyrics` field and no `instrumental` flag to set wrongly. Every `bgm` request is
 * instrumental because a `bgm` request cannot say otherwise.
 */

import type { SongTimeSignature } from '../song/engine-bounds';

/** Requirements 21.12, 21.13: the asset whose BPM and key are to be matched. */
export interface BgmReferenceAsset {
  readonly assetId: string;
  readonly bpm: number;
  readonly keyScale: string;
}

export interface BgmGenerationRequest {
  /** Requirement 21.1's 분위기. Folded into the caption; no separate engine field. */
  readonly mood?: string;
  /** Requirement 21.1's 장면 설명. Bounded by 21.5. */
  readonly sceneDescription: string;
  /** Requirement 21.1's 악기 구성. */
  readonly instrumentation?: readonly string[];
  /** Requirement 21.2. */
  readonly targetLengthSeconds: number;
  /** Requirement 21.6: a loop asset, subject to the four seam criteria. */
  readonly loop?: boolean;
  readonly bpm?: number;
  readonly keyScale?: string;
  readonly timeSignature?: number;
  /** Absent means the engine picks; Requirement 21.18 varies it across attempts. */
  readonly seed?: number;
  /** Requirement 21.12. Overrides `bpm` and `keyScale` when present. */
  readonly reference?: BgmReferenceAsset;
}

/** Requirement 21.9: several intensity variants of one cue. */
export interface BgmIntensityVariantRequest extends BgmGenerationRequest {
  /** Requirement 21.9: 1–4. */
  readonly variantCount: number;
  /**
   * Loudness gap between adjacent intensity steps, LUFS.
   *
   * Absent means the midpoint of Requirement 21.11's 1.0–6.0 LUFS window. Stated as
   * a request field rather than as a constant because the requirement gives a range
   * and not a value, and a caller scoring a tense scene may want the full 6 LUFS
   * while a caller scoring dialogue wants the minimum.
   */
  readonly intensityGapLufs?: number;
  /** Loudness of the quietest variant, LUFS. Defaults to `BGM_BASE_LOUDNESS_LUFS`. */
  readonly baseLoudnessLufs?: number;
}

/**
 * A validated request.
 *
 * `instrumental` and `lyricsMetadata` are both constants of the type: Requirement
 * 21.4 fixes every `bgm` request to instrumental parameters *and* requires the
 * produced asset's lyrics metadata to be recorded empty, and those are two different
 * obligations — one on the request, one on the stored asset — so both are carried.
 */
export interface BgmParameters {
  readonly sceneDescription: string;
  /** Mood, scene and instrumentation, composed into the engine's caption. */
  readonly caption: string;
  readonly targetLengthSeconds: number;
  readonly loop: boolean;
  readonly bpm?: number;
  readonly keyScale?: string;
  readonly timeSignature?: SongTimeSignature;
  readonly seed?: number;
  /** Requirement 21.12: present when a reference pinned the BPM and key. */
  readonly referenceAssetId?: string;
  /** Requirement 21.4, on the request. */
  readonly instrumental: true;
  /** Requirement 21.4, on the stored asset. */
  readonly lyricsMetadata: '';
}

/** Requirement 21.9's validated form: the shared cue plus its per-variant ladder. */
export interface BgmIntensityVariantParameters {
  readonly cue: BgmParameters;
  readonly variantCount: number;
  readonly intensityGapLufs: number;
  readonly baseLoudnessLufs: number;
}

/**
 * Loudness of intensity step 1 when the caller names none, LUFS.
 *
 * −20 LUFS sits a little below the −14 LUFS delivery target of Requirement 30.2, so
 * that a four-step ladder at the default gap still leaves the loudest step under that
 * target rather than needing attenuation. **Product decision**, not a transcription.
 */
export const BGM_BASE_LOUDNESS_LUFS = -20.0;

/**
 * How the engine is told which intensity variant it is generating (Requirement 21.9).
 *
 * Through the caption, because intensity is an arrangement instruction — fewer layers,
 * lighter percussion — and not a gain applied afterwards. Requirement 21.9 fixes BPM,
 * key and target length across the variants and says nothing about the caption, which is
 * precisely the room needed for the variants to differ musically at all.
 *
 * The wording is a bare "intensity level N of M" rather than an adjective ladder, so
 * that nothing here invents a vocabulary the requirements do not define. A single
 * variant gets no suffix: there is no ladder to place it on.
 */
export function withIntensityCaption(
  parameters: BgmParameters,
  step: number,
  count: number,
): BgmParameters {
  if (count <= 1) return parameters;
  return {
    ...parameters,
    caption: `${parameters.caption}, intensity level ${String(step)} of ${String(count)}`,
  };
}

/** Composes the caption Requirement 21.1's three descriptive inputs amount to. */
export function bgmCaption(request: BgmGenerationRequest): string {
  const parts = [
    request.mood?.trim(),
    request.sceneDescription.trim(),
    request.instrumentation
      ?.map((instrument) => instrument.trim())
      .filter((instrument) => instrument.length > 0)
      .join(', '),
  ];
  return parts.filter((part): part is string => part !== undefined && part.length > 0).join(', ');
}
