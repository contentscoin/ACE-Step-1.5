/**
 * `Manifest_Printer` (Requirement 24.13; design §7.1).
 *
 * Turns a `Cue_Pack_Manifest` into the document that goes into the archive. Two decisions
 * carry Requirement 24.15's idempotence, and both are the ones `chain-printer.ts` makes
 * for Requirement 29.27 — the same problem, so the same answer rather than a new one:
 *
 * **1. Key order is fixed, not inherited.** `packName` then `entries`, and inside an entry
 * the fields of `CUE_MANIFEST_ENTRY_FIELDS` in that order. `JSON.stringify` preserves
 * insertion order, so a manifest assembled by hand with the keys in another order would
 * otherwise print differently from the same manifest after a parse.
 *
 * **2. Numbers are printed by `JSON.stringify`, unmodified.** No rounding and no fixed
 * decimal count. `JSON.stringify` emits the shortest representation that round-trips a
 * double exactly, so `JSON.parse(JSON.stringify(x)) === x` for every finite `x`; any
 * tidying here would *introduce* the drift a tolerance then has to absorb.
 *
 * There is one wrinkle Requirement 24 does not mention and a round-trip test finds
 * immediately: **`JSON.stringify(-0)` is `"0"`**, so negative zero does not survive a
 * round trip as itself. It cannot arise from a real export — a byte size, a duration and a
 * channel count are all positive, and a default volume of `-0` is the same level as `0` —
 * so the printer does not special-case it. What it does mean is that
 * `equivalence.ts` compares numbers by absolute difference rather than by `Object.is`,
 * which is stated there. The alternative, making the printer emit `-0`, would produce a
 * document no other JSON implementation can read back.
 *
 * Entry order is the manifest's own and is *not* re-sorted. `SEMANTIC_CUES` fixes taxonomy
 * order, the export writes entries in it, and re-sorting here would hide a pack that had
 * somehow acquired them in another order instead of letting the round trip show it.
 */

import type { CueManifestEntry, CuePackManifest } from './manifest';

/** The wire shape of one entry. Exported for the parser's benefit and for tests. */
export interface CueManifestEntryDocument {
  readonly path: string;
  readonly byteSize: number;
  readonly durationMs: number;
  readonly channels: number;
  readonly loop: boolean;
  readonly defaultVolume: number;
  readonly cueName: string;
  readonly categoryName: string;
}

export interface CuePackManifestDocument {
  readonly packName: string;
  readonly entries: readonly CueManifestEntryDocument[];
}

/**
 * The manifest as a plain JSON value.
 *
 * Returned as a value rather than a string for the caller that is about to nest it in a
 * larger payload or hand it to a `jsonb` write and would otherwise parse the string back.
 */
export function manifestToDocument(manifest: CuePackManifest): CuePackManifestDocument {
  return {
    packName: manifest.packName,
    entries: manifest.entries.map(entryToDocument),
  };
}

function entryToDocument(entry: CueManifestEntry): CueManifestEntryDocument {
  // Written out field by field, in `CUE_MANIFEST_ENTRY_FIELDS` order, rather than spread
  // from the entry: a spread would inherit the source object's key order and so make the
  // output depend on how the entry happened to be built.
  return {
    path: entry.path,
    byteSize: entry.byteSize,
    durationMs: entry.durationMs,
    channels: entry.channels,
    loop: entry.loop,
    defaultVolume: entry.defaultVolume,
    cueName: entry.cueName,
    categoryName: entry.categoryName,
  };
}

/** Requirement 24.13: the manifest as the document that goes into the archive. */
export function printManifest(manifest: CuePackManifest): string {
  return JSON.stringify(manifestToDocument(manifest));
}

/**
 * The same document, indented.
 *
 * A separate function rather than an option on `printManifest`, for the reason
 * `printChainPretty` is separate: Requirement 24.15's byte-identity is asserted against
 * `printManifest`, and a formatting flag threaded through call sites is a way for the
 * stored document to acquire whitespace the comparison does not expect.
 *
 * This is the form the export writes, because a manifest is a file a person opens after
 * unzipping — unlike an `Effect_Chain`, which lives in a column.
 */
export function printManifestPretty(manifest: CuePackManifest): string {
  return JSON.stringify(manifestToDocument(manifest), null, 2);
}
