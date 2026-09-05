/**
 * The object store, on a local filesystem (roadmap §4.4, step S1).
 *
 * ### Why the first object store is a directory
 *
 * Nothing in the tree could *write* an audio object before this file. `AudioObjectPort` had
 * `head` and `read`, the in-memory double in `test/support/playback-harness.ts` had a `put` that
 * existed only for seeding tests, and the generation path — engine bytes in, stored asset out —
 * had no seam to hand the bytes to. That is the gap S1 closes, and it closes it with the
 * smallest store that is honest: a directory. S3 or MinIO is a second implementation of the same
 * two ports, and the composition root swaps it in with no caller aware.
 *
 * ### Writes are atomic, and the reason is `head`
 *
 * A caller that observes the object exists must be able to trust its length. A plain
 * `writeFile` produces a file whose size grows while the bytes land, so `head` during a write
 * would report a partial length and `read` would hand out a window of a file still being
 * written. Every object is therefore written to a temporary sibling and renamed into place;
 * rename is atomic on POSIX, so the object either does not exist or is complete. A crash
 * mid-write leaves a stray `.tmp` file and no half object — which is the failure that is easy
 * to see and clean up, rather than the one that looks like a working store returning noise.
 *
 * ### The content type lives beside the bytes
 *
 * A filesystem has no content type. Deriving it from the extension would make the key's
 * spelling load-bearing, and the key is an opaque address the product chose. So the type is
 * written to a sidecar (`<object>.meta.json`) in the same atomic step, and `head` reads it back.
 * An object with bytes and no sidecar is treated as absent — a store that reported a length
 * with no type would hand the player a body it cannot label.
 *
 * ### Keys are validated, because this store resolves them to paths
 *
 * `../` in an object key is a request to read outside the root. The in-memory double has no
 * such concept — a map key is just a string — so this is the one place the contract diverges
 * on purpose: a key that would escape the root is refused here and is unremarkable there. The
 * contract test pins the refusal.
 */

import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';

import type { AudioObjectMetadata, AudioObjectPort, AudioObjectWritePort } from '../ports';

/** The sidecar's shape. Versioned in name only — a second field would be a second version. */
interface ObjectSidecar {
  readonly contentType: string;
}

const SIDECAR_SUFFIX = '.meta.json';
const TEMP_SUFFIX = '.tmp';

/**
 * An object key that cannot escape the root or collide with this store's own files.
 *
 * Segments are `[A-Za-z0-9._-]+`, joined by `/`. That admits every key the product mints
 * (`audio/<uuid>`) and refuses `..`, absolute paths, empty segments, and the sidecar and temp
 * suffixes — a key ending in `.meta.json` would let a `put` overwrite another object's type.
 */
const KEY_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class ObjectKeyRejected extends Error {
  constructor(readonly objectKey: string, reason: string) {
    super(`object key rejected: ${reason}`);
    this.name = 'ObjectKeyRejected';
  }
}

function assertValidKey(objectKey: string): void {
  if (objectKey.length === 0 || objectKey.length > 1024) {
    throw new ObjectKeyRejected(objectKey, 'length must be 1..1024');
  }
  const segments = objectKey.split('/');
  for (const segment of segments) {
    if (!KEY_SEGMENT.test(segment)) {
      throw new ObjectKeyRejected(objectKey, `segment "${segment}" is not [A-Za-z0-9._-]`);
    }
    if (segment === '.' || segment === '..') {
      throw new ObjectKeyRejected(objectKey, 'dot segments are not allowed');
    }
  }
  if (objectKey.endsWith(SIDECAR_SUFFIX) || objectKey.endsWith(TEMP_SUFFIX)) {
    throw new ObjectKeyRejected(objectKey, 'reserved suffix');
  }
}

export interface FilesystemObjectStore extends AudioObjectPort, AudioObjectWritePort {
  /** The directory every key resolves under. Exposed so a test can look at what was written. */
  readonly root: string;
}

export function createFilesystemObjectStore(rootDirectory: string): FilesystemObjectStore {
  const root = resolve(rootDirectory);

  /** Resolves a validated key and proves the result stayed under the root. */
  function pathFor(objectKey: string): string {
    assertValidKey(objectKey);
    const path = resolve(join(root, ...objectKey.split('/')));
    // Belt and braces: `assertValidKey` already refuses every escape we know how to spell, and
    // this refuses any we do not. A path that is not under `root + sep` is not ours.
    if (path !== root && !path.startsWith(root + sep)) {
      throw new ObjectKeyRejected(objectKey, 'resolves outside the store root');
    }
    return path;
  }

  async function readSidecar(path: string): Promise<ObjectSidecar | null> {
    try {
      const raw = await readFile(path + SIDECAR_SUFFIX, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        typeof (parsed as { contentType?: unknown }).contentType === 'string'
      ) {
        return { contentType: (parsed as ObjectSidecar).contentType };
      }
      return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  return {
    root,

    async put(objectKey, bytes, contentType) {
      const path = pathFor(objectKey);
      await mkdir(dirname(path), { recursive: true });

      // Both files land through a temporary name and a rename, and the sidecar goes first: an
      // observer that sees the object sees a type for it. The reverse order could expose bytes
      // with no type for the width of one rename.
      const sidecar = path + SIDECAR_SUFFIX;
      const sidecarTemp = sidecar + TEMP_SUFFIX;
      const objectTemp = path + TEMP_SUFFIX;

      await writeFile(sidecarTemp, JSON.stringify({ contentType } satisfies ObjectSidecar));
      await rename(sidecarTemp, sidecar);
      await writeFile(objectTemp, bytes);
      await rename(objectTemp, path);
    },

    async head(objectKey): Promise<AudioObjectMetadata | null> {
      const path = pathFor(objectKey);
      let size: number;
      try {
        size = (await stat(path)).size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
      const sidecar = await readSidecar(path);
      if (sidecar === null) return null;
      return { contentLength: size, contentType: sidecar.contentType };
    },

    async read({ objectKey, start, end }) {
      const path = pathFor(objectKey);
      const metadata = await this.head(objectKey);
      if (metadata === null) throw new Error(`no such object: ${objectKey}`);
      if (start < 0 || end >= metadata.contentLength || end < start) {
        // The same refusal the in-memory double makes, for the same reason its header gives: a
        // service asking for a window outside the object would be asking a real store for a
        // 416, and `resolveRange` in the domain has already clamped every window it produces.
        // A request that reaches here out of bounds is a programming error, not a client one.
        throw new Error(`window out of bounds: ${String(start)}-${String(end)}`);
      }
      // `createReadStream`'s `end` is inclusive, matching the port. `toWeb` yields the
      // `ReadableStream<Uint8Array>` the port promises without buffering the window.
      return Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream<Uint8Array>;
    },

    async remove(objectKey) {
      const path = pathFor(objectKey);
      await rm(path, { force: true });
      await rm(path + SIDECAR_SUFFIX, { force: true });
    },
  };
}
