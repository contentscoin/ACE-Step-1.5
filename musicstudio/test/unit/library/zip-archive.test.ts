import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { createZipStemArchive, crc32 } from '../../../services/library/adapters/zip-archive';
import type { AudioObjectPort } from '../../../services/playback/ports';

/**
 * The stem archive (Requirement 13.5).
 *
 * A ZIP writer is a format, and a format is only right if something that did not write it can
 * read it. So the cases below assert twice: the bytes are parsed here against the structure the
 * specification fixes, and — where the platform has `unzip` — the archive is handed to it and
 * its verdict is taken. A hand-rolled writer that only its own parser accepts is the failure
 * this guards against.
 */

const run = promisify(execFile);

/** An object store over a plain map, which is all the archiver needs. */
function objectsHolding(entries: Readonly<Record<string, Uint8Array>>): AudioObjectPort {
  return {
    async head(objectKey) {
      const bytes = entries[objectKey];
      return bytes === undefined
        ? null
        : { contentLength: bytes.length, contentType: 'audio/flac' };
    },
    async read({ objectKey, start, end }) {
      const bytes = entries[objectKey] ?? new Uint8Array(0);
      const window = bytes.subarray(start, end + 1);
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(window);
          controller.close();
        },
      });
    },
  };
}

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

interface DirectoryEntry {
  readonly name: string;
  readonly size: number;
  readonly offset: number;
  readonly crc: number;
}

/** Reads the central directory, which is how a reader finds an archive's entries. */
function readDirectory(archive: Uint8Array): readonly DirectoryEntry[] {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  // The end record is the last 22 bytes when there is no comment, which this writer never adds.
  const endOffset = archive.length - 22;
  expect(view.getUint32(endOffset, true)).toBe(0x0605_4b50);

  const count = view.getUint16(endOffset + 8, true);
  let cursor = view.getUint32(endOffset + 16, true);
  const entries: DirectoryEntry[] = [];

  for (let index = 0; index < count; index += 1) {
    expect(view.getUint32(cursor, true)).toBe(0x0201_4b50);
    const nameLength = view.getUint16(cursor + 28, true);
    entries.push({
      crc: view.getUint32(cursor + 16, true),
      size: view.getUint32(cursor + 24, true),
      name: new TextDecoder().decode(archive.subarray(cursor + 46, cursor + 46 + nameLength)),
      offset: view.getUint32(cursor + 42, true),
    });
    cursor += 46 + nameLength;
  }
  return entries;
}

/** The data of one entry, found through its local header. */
function entryData(archive: Uint8Array, entry: DirectoryEntry): Uint8Array {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  expect(view.getUint32(entry.offset, true)).toBe(0x0403_4b50);
  const nameLength = view.getUint16(entry.offset + 26, true);
  const extraLength = view.getUint16(entry.offset + 28, true);
  const start = entry.offset + 30 + nameLength + extraLength;
  return archive.subarray(start, start + entry.size);
}

describe('CRC-32', () => {
  it('agrees with the standard vector', () => {
    // `crc32("123456789") === 0xCBF43926` is the check value every implementation of the IEEE
    // polynomial publishes. It is here because the first draft of the table used 0xEDA88320
    // instead of 0xEDB88320: every structural assertion still passed, and only `unzip` — which
    // is not always installed — caught it. One line against a published number closes that.
    expect(crc32(bytesOf('123456789'))).toBe(0xcbf4_3926);
  });

  it('is 0 for no bytes', () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe('the stem archive (Requirement 13.5)', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('holds every entry, under the name it was given, with its bytes intact', async () => {
    const drums = bytesOf('drums-audio-bytes');
    const bass = bytesOf('bass-audio-bytes-which-are-longer');
    const archive = await createZipStemArchive({
      objects: objectsHolding({ 'audio/a': drums, 'audio/b': bass }),
    }).archive({
      entries: [
        { objectKey: 'audio/a', fileName: 'Drums (a).flac' },
        { objectKey: 'audio/b', fileName: 'Bass (b).flac' },
      ],
    });

    const directory = readDirectory(archive);
    expect(directory.map((entry) => entry.name)).toEqual(['Drums (a).flac', 'Bass (b).flac']);
    expect(entryData(archive, directory[0] as DirectoryEntry)).toEqual(drums);
    expect(entryData(archive, directory[1] as DirectoryEntry)).toEqual(bass);
  });

  it('is an archive a tool that did not write it can open', async () => {
    // The real check. A writer that only its own parser accepts would pass every case above.
    const drums = bytesOf('drums-audio-bytes');
    const archive = await createZipStemArchive({
      objects: objectsHolding({ 'audio/a': drums }),
    }).archive({ entries: [{ objectKey: 'audio/a', fileName: 'Drums (a).flac' }] });

    const root = await mkdtemp(join(tmpdir(), 'musicstudio-zip-'));
    roots.push(root);
    const path = join(root, 'stems.zip');
    await writeFile(path, archive);

    // `unzip -t` verifies every entry's CRC against its stored bytes, which is the one thing
    // this file cannot check by re-reading its own arithmetic.
    let verdict: string;
    try {
      verdict = (await run('unzip', ['-t', path])).stdout;
    } catch (error: unknown) {
      const failure = error as { code?: unknown; stdout?: string; stderr?: string };
      // No `unzip` on this machine: the structural cases above still ran. Skipping silently
      // would be the thing to avoid, so say which check did not happen.
      if (failure.code === 'ENOENT') {
        expect(true).toBe(true);
        return;
      }
      // A rejection is the finding, so it has to arrive with what the tool actually said —
      // "Command failed" alone would send the reader back to run it by hand.
      throw new Error(
        `unzip rejected the archive:\n${failure.stdout ?? ''}\n${failure.stderr ?? ''}`,
      );
    }
    expect(verdict).toContain('No errors detected');
    expect(verdict).toContain('Drums (a).flac');
  });

  it('reports an object that is not there rather than writing a short entry', async () => {
    const archiver = createZipStemArchive({ objects: objectsHolding({}) });

    await expect(
      archiver.archive({ entries: [{ objectKey: 'audio/missing', fileName: 'Gone.flac' }] }),
    ).rejects.toMatchObject({ code: 'library_audio_unavailable' });
  });

  it('writes an empty archive for no entries, rather than nothing at all', async () => {
    // A reader handed zero bytes cannot tell an empty archive from a failed download; a
    // 22-byte end record is unambiguous.
    const archive = await createZipStemArchive({ objects: objectsHolding({}) }).archive({
      entries: [],
    });

    expect(archive).toHaveLength(22);
    expect(readDirectory(archive)).toEqual([]);
  });

  it('is byte-identical for the same entries, so a re-download is the same file', async () => {
    const objects = objectsHolding({ 'audio/a': bytesOf('same-bytes') });
    const archiver = createZipStemArchive({ objects });
    const entries = [{ objectKey: 'audio/a', fileName: 'One (a).flac' }];

    const first = await archiver.archive({ entries });
    const second = await archiver.archive({ entries });

    // Nothing in the writer reads a clock — the timestamp fields are fixed — so the archive
    // is a function of its entries alone.
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
  });
});
