/**
 * The seams around `Library_Service` (design §2.2, §4.1).
 *
 * Interfaces rather than clients, for the reason `services/timeline/ports.ts` gives: no
 * PostgreSQL and no object store is reachable from this environment, and every rule in
 * Requirements 11 and 13 is a product-layer rule that must be testable without either.
 *
 * ### Why the store takes a whole query rather than filters
 *
 * `applyLibraryQuery` in `domain/library/query.ts` is the specification of a listing —
 * owner scope, deletion filter, kind filter, search, order, cursor. A store that received
 * loose filters would re-derive that combination, and an in-memory store and a SQL one
 * would drift the first time one of them forgot Requirement 11.7. The store receives the
 * query and returns the page; the in-memory implementation is literally
 * `applyLibraryQuery`, and a SQL one has one function to be equivalent to.
 */

import type { AssetKind } from '../../domain/asset-kind';
import type { DownloadFormat } from '../../domain/library/download';
import type { LibraryAssetSummary, LibraryPage, LibraryQuery } from '../../domain/library/query';

/** The stored asset, as the library reads and writes it. */
export interface LibraryAssetRecord extends LibraryAssetSummary {
  /** Where the stored audio lives. `null` once Requirement 11.8 has purged it. */
  readonly objectKey: string | null;
  readonly deletedAtMs: number | null;
  readonly sampleRate: number;
  readonly channels: number;
  readonly durationMs: number;
  /** Requirement 13.5 — set on a `stem` asset, naming the asset it was split from. */
  readonly stemSourceAssetId: string | null;
}

export interface LibraryAssetStore {
  find(assetId: string): Promise<LibraryAssetRecord | null>;
  /** Requirements 11.1-11.4, 11.7, 11.12 — see the header on why this takes the query. */
  page(query: LibraryQuery): Promise<LibraryPage>;
  rename(assetId: string, name: string): Promise<LibraryAssetRecord>;
  setDeleted(assetId: string, isDeleted: boolean, atMs: number | null): Promise<LibraryAssetRecord>;
  /** Requirement 11.8's permanent deletion: the row and its audio, both gone. */
  purge(assetId: string): Promise<void>;
  /** Requirement 11.8's sweep — every asset whose retention window has closed. */
  findPurgeDue(nowMs: number): Promise<readonly LibraryAssetRecord[]>;
  setTags(assetId: string, tags: readonly string[]): Promise<LibraryAssetRecord>;
  /** Requirement 11.13, cue name ascending. */
  listSoundPackAssets(packId: string): Promise<readonly LibraryAssetRecord[]>;
  /** Requirement 13.5 — the stems split from one source asset. */
  listStemsOf(sourceAssetId: string): Promise<readonly LibraryAssetRecord[]>;
}

/** Requirement 11.10. Order is the store's to preserve; see `playlist_item`'s primary key. */
export interface PlaylistRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly name: string;
  /** In the order the user gave. */
  readonly assetIds: readonly string[];
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface PlaylistStore {
  insert(record: PlaylistRecord): Promise<void>;
  find(playlistId: string): Promise<PlaylistRecord | null>;
  update(record: PlaylistRecord): Promise<void>;
  remove(playlistId: string): Promise<void>;
  listByOwner(ownerId: string): Promise<readonly PlaylistRecord[]>;
}

/**
 * Requirement 13.3's conversion, which task 3.1 owns.
 *
 * Declared here as a port because the *decision* to convert is 13.1's and this service's,
 * while the conversion itself is `musicstudio_dsp.convert_for_download`'s. The port returns
 * bytes rather than writing them, because Requirement 13.1 hands the user an attachment and
 * a converted download is not a stored asset.
 */
export interface DownloadConversionPort {
  convert(request: {
    readonly objectKey: string;
    readonly format: DownloadFormat;
    /**
     * Requirement 13.7's metadata tags.
     *
     * They arrive as an argument because only the encoder can write them — the tag lives
     * inside the encoded bytes — while the wording is the product's
     * (`domain/disclosure/ai-disclosure.ts`). `convert_for_download` in the DSP worker takes
     * the same argument for the same reason.
     */
    readonly tags: Readonly<Record<string, string>>;
  }): Promise<DownloadPayload>;
}

export interface DownloadPayload {
  readonly bytes: Uint8Array;
  readonly format: DownloadFormat;
  /** Requirement 13.10 — always 48 kHz, asserted at the seam rather than assumed. */
  readonly sampleRate: number;
  /**
   * The tags the encoder actually wrote back into the file, read back from it.
   *
   * Required, not optional, and that is the whole value of the field: the failure mode of
   * Requirement 13.7 is silent — a download with no marker is still a working download — so
   * an implementation that could omit this would be an implementation that never gets
   * checked. `download-service.ts` compares it with what it asked for.
   */
  readonly tags: Readonly<Record<string, string>>;
}

/** Requirement 13.5's archive. Built by the caller's storage layer, not by this service. */
export interface StemArchivePort {
  archive(request: {
    readonly entries: readonly { readonly objectKey: string; readonly fileName: string }[];
  }): Promise<Uint8Array>;
}

/** Requirement 13.4 needs to know the requester's plan, and which plans carry the flag. */
export interface PlanEntitlementPort {
  planIdFor(accountId: string): Promise<string>;
}

/** What the caller is told about an asset it may download. */
export interface DownloadableAsset {
  readonly assetId: string;
  readonly name: string;
  readonly assetKind: AssetKind;
  readonly formats: readonly DownloadFormat[];
}
