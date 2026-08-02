/**
 * Edit_Task request vocabulary (Requirement 7).
 *
 * Engine-agnostic like `domain/song/request.ts`: these are editing concepts — a
 * source asset, a cover strength, an interval, a track name — not ACE-Step field
 * names. The translation to `src_audio_path` / `audio_cover_strength` /
 * `repainting_start` / `track_name` happens only in `adapters/ace/submit-payload.ts`.
 *
 * One request type per kind rather than one wide type with everything optional,
 * because the kinds share almost nothing: only cover has a strength, only repaint
 * has an interval, only extract and lego have a track. A single flat type would
 * admit combinations no kind allows and push the checking into the validator.
 *
 * Every kind carries an optional `style`, which is Requirement 7.1's "new style"
 * generalised. It is a Custom_Mode song request minus its `mode`, so the caption,
 * lyrics and musical metadata an edit restyles with are validated by Requirement 4's
 * existing validator instead of a second, parallel one.
 */

import type { CustomModeSongRequest, SongParameters } from '../song/request';

import type { EditKind } from './edit-kind';
import type { RepaintAdjustment } from './repaint-range';
import type { SourceAudio } from './source-audio';
import type { TrackName } from './track-name';

/** The musical side of an edit: whatever Requirement 4 already knows how to check. */
export type EditStyle = Omit<CustomModeSongRequest, 'mode'>;

interface EditRequestBase {
  /** Audio_Asset the edit starts from, and Requirement 7.12's lineage parent. */
  readonly sourceAssetId: string;
  /** Requirement 7.9: the DiT model to run on. Absent means the catalogue default. */
  readonly model?: string;
  readonly style?: EditStyle;
}

/** Requirements 7.1, 7.2. */
export interface CoverEditRequest extends EditRequestBase {
  readonly kind: 'cover';
  /** Requirement 7.2. Absent leaves the engine's own default in place. */
  readonly coverStrength?: number;
}

/** Requirements 7.3–7.5. Both bounds are required: there is no default interval. */
export interface RepaintEditRequest extends EditRequestBase {
  readonly kind: 'repaint';
  readonly repaintStartSeconds: number;
  readonly repaintEndSeconds: number;
}

/** Requirement 7.6. */
export interface ExtractEditRequest extends EditRequestBase {
  readonly kind: 'extract';
  readonly trackName: TrackName;
}

/** Requirement 7.7. */
export interface LegoEditRequest extends EditRequestBase {
  readonly kind: 'lego';
  readonly trackName: TrackName;
}

/**
 * Requirement 7.8.
 *
 * `trackClasses` is optional and has no criterion of its own: the engine's
 * `complete` instruction template takes an optional `{TRACK_CLASSES}` list
 * (`TASK_INSTRUCTIONS` in `acestep/constants.py`) and falls back to
 * `complete_default` without it, so it is forwarded when given and omitted when not.
 */
export interface CompleteEditRequest extends EditRequestBase {
  readonly kind: 'complete';
  readonly trackClasses?: readonly TrackName[];
}

export type EditRequest =
  | CoverEditRequest
  | RepaintEditRequest
  | ExtractEditRequest
  | LegoEditRequest
  | CompleteEditRequest;

/**
 * A validated edit, ready for the adapter.
 *
 * Absent optional fields are meaningful in the same way Requirement 4.7's are: an
 * omitted `coverStrength` leaves the engine's default alone rather than restating it,
 * so nothing downstream may substitute a value.
 */
export interface EditParameters {
  readonly kind: EditKind;
  readonly source: SourceAudio;
  /** Resolved: the request's model, or the catalogue default (Requirement 7.9). */
  readonly model: string;
  /** Requirement 7.1's new style, validated through Requirement 4's rules. */
  readonly style: SongParameters;
  readonly coverStrength?: number;
  readonly repaintStartSeconds?: number;
  /** Requirement 7.5: already clamped, with the adjustment reported separately. */
  readonly repaintEndSeconds?: number;
  readonly trackName?: TrackName;
  readonly trackClasses?: readonly TrackName[];
}

/** Requirement 7.5: adjustments the gateway must report back to the caller. */
export type EditAdjustment = RepaintAdjustment;
