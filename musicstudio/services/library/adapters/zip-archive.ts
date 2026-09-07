/**
 * `StemArchivePort` as a ZIP file (roadmap §4.4, slice S6).
 *
 * Requirement 13.5 hands the user "하나의 압축 파일" holding the stems split from one source.
 * This builds it in this process, from the stored objects, with no dependency: the format's
 * stored-entry form is a header, the bytes, and a directory at the end, and a ZIP writer that
 * only ever stores is small enough to read in one sitting.
 *
 * ### Stored, not deflated
 *
 * Every entry is compression method 0. The entries are FLAC, WAV, MP3 or OGG — all already
 * compressed or already incompressible — so deflating them buys a percent or two for the cost
 * of a compressor in the request path. A ZIP reader treats a stored entry exactly like a
 * deflated one, so nothing downstream can tell.
 *
 * ### No ZIP64, and the bound is stated
 *
 * Offsets and sizes are 32-bit here. An archive over 4 GiB, or one entry over it, would need
 * ZIP64's extra records; a stem set is a handful of minutes-long files, so the case is refused
 * with a named error rather than silently written as a corrupt archive — the failure mode of
 * an overflowed offset is an archive that opens and is wrong.
 */

import type { AudioObjectPort } from '../../playback/ports';
import { readWholeObject } from '../../playback/adapters/object-bytes';
import { libraryAudioUnavailable } from '../errors';
import type { StemArchivePort } from '../ports';

/** The format's 32-bit ceiling on any size or offset it records. */
const ZIP32_MAX = 0xffff_ffff;

export class ZipArchiveTooLarge extends Error {
  constructor(readonly totalBytes: number) {
    super(`archive exceeds the 4 GiB limit of a non-ZIP64 archive: ${String(totalBytes)} bytes`);
    this.name = 'ZipArchiveTooLarge';
  }
}

/**
 * CRC-32 (IEEE 802.3), which every ZIP entry carries.
 *
 * The table is built once on first use rather than written out as 256 literals; a reader can
 * check the polynomial in one line instead of trusting a wall of hex.
 */
let crcTable: Uint32Array | null = null;

/** Exported so a test can check it against the standard vector rather than against itself. */
export function crc32(bytes: Uint8Array): number {
  if (crcTable === null) {
    crcTable = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        // 0xEDB88320 — the IEEE polynomial, reversed. Worth reading a digit at a time: an
        // earlier draft of this line had 0xEDA88320, every field of the archive was still
        // well formed, and `unzip` was the only thing that noticed.
        value = (value & 1) === 1 ? 0xedb8_8320 ^ (value >>> 1) : value >>> 1;
      }
      crcTable[index] = value >>> 0;
    }
  }

  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc = (crcTable[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

interface ArchiveEntry {
  readonly name: Uint8Array;
  readonly data: Uint8Array;
  readonly crc: number;
  readonly offset: number;
}

export interface ZipArchiveOptions {
  readonly objects: AudioObjectPort;
}

export function createZipStemArchive(options: ZipArchiveOptions): StemArchivePort {
  return {
    async archive(request): Promise<Uint8Array> {
      const parts: Uint8Array[] = [];
      const entries: ArchiveEntry[] = [];
      let offset = 0;

      for (const entry of request.entries) {
        const data = await readWholeObject(options.objects, entry.objectKey);
        if (data === null) throw libraryAudioUnavailable(entry.objectKey);

        const name = new TextEncoder().encode(entry.fileName);
        const crc = crc32(data);
        const header = localFileHeader(name, crc, data.length);

        entries.push({ name, data, crc, offset });
        parts.push(header, data);
        offset += header.length + data.length;
        if (offset > ZIP32_MAX) throw new ZipArchiveTooLarge(offset);
      }

      const directoryOffset = offset;
      let directoryLength = 0;
      for (const entry of entries) {
        const record = centralDirectoryRecord(entry);
        parts.push(record);
        directoryLength += record.length;
      }
      parts.push(endOfCentralDirectory(entries.length, directoryLength, directoryOffset));

      return concat(parts);
    },
  };
}

/** `PK\3\4` — version 2.0, no flags, stored, zeroed DOS timestamp. */
function localFileHeader(name: Uint8Array, crc: number, size: number): Uint8Array {
  const header = new Uint8Array(30 + name.length);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x0403_4b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, 0, true);
  // A fixed timestamp rather than the clock: the archive is a function of its entries, so two
  // downloads of the same stems produce identical bytes, and nothing here needs a clock.
  view.setUint16(10, 0, true);
  view.setUint16(12, 0, true);
  view.setUint32(14, crc, true);
  view.setUint32(18, size, true);
  view.setUint32(22, size, true);
  view.setUint16(26, name.length, true);
  view.setUint16(28, 0, true);
  header.set(name, 30);
  return header;
}

/** `PK\1\2` — the same facts again, plus where the local header is. */
function centralDirectoryRecord(entry: ArchiveEntry): Uint8Array {
  const record = new Uint8Array(46 + entry.name.length);
  const view = new DataView(record.buffer);
  view.setUint32(0, 0x0201_4b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 20, true);
  view.setUint16(8, 0, true);
  view.setUint16(10, 0, true);
  view.setUint16(12, 0, true);
  view.setUint16(14, 0, true);
  view.setUint32(16, entry.crc, true);
  view.setUint32(20, entry.data.length, true);
  view.setUint32(24, entry.data.length, true);
  view.setUint16(28, entry.name.length, true);
  view.setUint16(30, 0, true);
  view.setUint16(32, 0, true);
  view.setUint16(34, 0, true);
  view.setUint16(36, 0, true);
  view.setUint32(38, 0, true);
  view.setUint32(42, entry.offset, true);
  record.set(entry.name, 46);
  return record;
}

/** `PK\5\6` — the trailer a reader finds first by scanning backwards. */
function endOfCentralDirectory(count: number, length: number, offset: number): Uint8Array {
  const record = new Uint8Array(22);
  const view = new DataView(record.buffer);
  view.setUint32(0, 0x0605_4b50, true);
  view.setUint16(4, 0, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, count, true);
  view.setUint16(10, count, true);
  view.setUint32(12, length, true);
  view.setUint32(16, offset, true);
  view.setUint16(20, 0, true);
  return record;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const bytes = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    bytes.set(part, cursor);
    cursor += part.length;
  }
  return bytes;
}
