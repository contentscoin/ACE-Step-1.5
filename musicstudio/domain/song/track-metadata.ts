/**
 * The metadata a finished song carries (Requirement 3.4).
 *
 * Requirement 3.4 lists six values the engine *finally used* — caption, lyrics,
 * BPM, key/scale, time signature and length — which is not the same as the six the
 * user asked for: in Simple_Mode the user supplied none of them, and in
 * Custom_Mode the engine filled whatever was left empty (Requirement 4.7). So this
 * is a record of the outcome, read back from the engine's own answer, and each
 * field is nullable because the engine reports only what it settled on.
 *
 * Persisting it belongs to the Library layer; task 2.1 decodes it and hands it to
 * whoever stores the Audio_Asset.
 */
export interface SongTrackMetadata {
  readonly caption: string | null;
  readonly lyrics: string | null;
  readonly bpm: number | null;
  readonly keyScale: string | null;
  readonly timeSignature: number | null;
  readonly durationSeconds: number | null;
  /** Free-text genre list the engine reports alongside the six. */
  readonly genres: string | null;
}

export const EMPTY_SONG_TRACK_METADATA: SongTrackMetadata = {
  caption: null,
  lyrics: null,
  bpm: null,
  keyScale: null,
  timeSignature: null,
  durationSeconds: null,
  genres: null,
};

/** True once the engine has reported every value Requirement 3.4 asks us to store. */
export function isCompleteTrackMetadata(metadata: SongTrackMetadata): boolean {
  return (
    metadata.caption !== null &&
    metadata.lyrics !== null &&
    metadata.bpm !== null &&
    metadata.keyScale !== null &&
    metadata.timeSignature !== null &&
    metadata.durationSeconds !== null
  );
}
