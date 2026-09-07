/**
 * `PlaybackAssetStore` over PostgreSQL (roadmap §4.4, slice S6).
 *
 * The playback service reads a narrower record than the library's — id, owner, kind, duration,
 * loop, deletion, object key, frame count — and until this file its only implementation was the
 * in-memory double in `test/support/playback-harness.ts`. Streaming through a real gateway had
 * nothing to look an asset up in.
 *
 * ### `frameCount` is derived, not stored
 *
 * `audio_asset` holds `duration_ms` and `sample_rate` and no frame count. The product of the two
 * is the count, and storing it as well would be a third number that has to agree with the other
 * two. It is used for one thing — capping the waveform's bucket count at one bucket per frame —
 * so a rounding of at most half a millisecond at the boundary changes nothing a viewer sees.
 *
 * ### The increment is one statement, and returns the new value
 *
 * Requirement 12.4 asks for the count *after* the play. `UPDATE ... RETURNING` gives that under
 * concurrency without a read-modify-write: two simultaneous plays produce two increments and two
 * distinct return values, where a `SELECT` then an `UPDATE` could produce two of the same. An
 * asset that vanished between the stream's own lookup and this call returns its absence as 0
 * rather than throwing — the audio has already been served, and failing the request afterwards
 * would report an error for a play that happened.
 *
 * ### Timed lyrics are `null` for now, and that is a state the requirement admits
 *
 * Requirement 12.5's lines come from Transcription_Service, and no table stores them yet — the
 * service keeps them in its own store. `null` is what `playback-service.ts` already documents as
 * "this asset has no `Timed_Lyrics`", which is true of every asset here rather than a stand-in
 * for one. When the table exists this is one query.
 */

import type { TimedLyrics } from '../../../domain/lyrics/timed-lyrics';
import type { AssetKind } from '../../../domain/asset-kind';
import type { PlaybackAsset, PlaybackAssetStore } from '../ports';

/** The slice of `pg` this adapter uses; see `pg-account-repository.ts` on why it is structural. */
export interface PgQueryable {
  query<Row extends Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[] }>;
}

interface PlaybackRow extends Record<string, unknown> {
  readonly id: string;
  readonly owner_id: string;
  readonly asset_kind: AssetKind;
  readonly duration_ms: number;
  readonly sample_rate: number;
  readonly is_loop: boolean;
  readonly is_deleted: boolean;
  readonly object_key: string | null;
}

function toAsset(row: PlaybackRow): PlaybackAsset {
  return {
    id: row.id,
    ownerId: row.owner_id,
    assetKind: row.asset_kind,
    durationMs: row.duration_ms,
    isLoop: row.is_loop,
    isDeleted: row.is_deleted,
    objectKey: row.object_key,
    frameCount: Math.round((row.duration_ms * row.sample_rate) / 1000),
  };
}

export function createPgPlaybackAssetStore(db: PgQueryable): PlaybackAssetStore {
  return {
    async find(assetId) {
      const { rows } = await db.query<PlaybackRow>(
        `SELECT id, owner_id, asset_kind, duration_ms, sample_rate, is_loop, is_deleted, object_key
           FROM audio_asset WHERE id = $1`,
        [assetId],
      );
      const row = rows[0];
      return row === undefined ? null : toAsset(row);
    },

    async incrementPlayCount(assetId) {
      const { rows } = await db.query<{ play_count: string | number }>(
        `UPDATE audio_asset SET play_count = play_count + 1 WHERE id = $1 RETURNING play_count`,
        [assetId],
      );
      const row = rows[0];
      // `bigint` arrives as a string from `pg`; the same conversion `pg-asset-store.ts` makes,
      // for the same reason it is safe on a play count.
      return row === undefined ? 0 : Number(row.play_count);
    },

    async timedLyricsFor(): Promise<TimedLyrics | null> {
      return null;
    },
  };
}
