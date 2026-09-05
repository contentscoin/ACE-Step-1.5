import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createFilesystemObjectStore,
  ObjectKeyRejected,
} from '../../../services/playback/adapters/filesystem-object-store';
import type { AudioObjectPort, AudioObjectWritePort } from '../../../services/playback/ports';
import { countingBytes, inMemoryObjectStore } from '../../support/playback-harness';

/**
 * One contract for the object store, run against both implementations (roadmap §4.4, S1).
 *
 * The account and asset contracts explain the shape. This one exists because the in-memory
 * double's `put` was a test-only extension for years of the tree's life — the port itself had
 * no write — so the double was never held to a write contract at all. Now that a real store
 * writes, the two have to agree on what a written object looks like when read back, and the
 * cases below are that agreement: length, type, window contents, and what happens at the edges
 * of a window.
 *
 * `countingBytes` is used throughout so a window's contents identify its offset: byte `i` is
 * `i % 256`, and a read that started one byte early or late returns a recognisably wrong
 * sequence rather than a plausible one.
 */

type ObjectStore = AudioObjectPort & AudioObjectWritePort;

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value !== undefined) chunks.push(value);
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function contractFor(name: string, open: () => Promise<ObjectStore>) {
  describe(`object store contract — ${name}`, () => {
    it('reports a stored object by length and type', async () => {
      const store = await open();
      await store.put('audio/one', countingBytes(1_000), 'audio/wav');

      expect(await store.head('audio/one')).toEqual({ contentLength: 1_000, contentType: 'audio/wav' });
    });

    it('reports null for an object that was never written', async () => {
      const store = await open();
      expect(await store.head('audio/missing')).toBeNull();
    });

    it('reads a whole object back byte for byte', async () => {
      const store = await open();
      await store.put('audio/whole', countingBytes(300), 'audio/flac');

      const bytes = await collect(await store.read({ objectKey: 'audio/whole', start: 0, end: 299 }));
      expect(bytes).toEqual(countingBytes(300));
    });

    it('reads a window whose contents identify its offset, with `end` inclusive', async () => {
      const store = await open();
      await store.put('audio/window', countingBytes(1_000), 'audio/flac');

      const bytes = await collect(await store.read({ objectKey: 'audio/window', start: 250, end: 259 }));
      expect(Array.from(bytes)).toEqual([250, 251, 252, 253, 254, 255, 0, 1, 2, 3]);
    });

    it('reads the final byte when a window ends exactly at the object', async () => {
      // The off-by-one that a store with an exclusive `end` would get wrong.
      const store = await open();
      await store.put('audio/tail', countingBytes(10), 'audio/flac');

      const bytes = await collect(await store.read({ objectKey: 'audio/tail', start: 9, end: 9 }));
      expect(Array.from(bytes)).toEqual([9]);
    });

    it('refuses a window that runs past the object rather than truncating it', async () => {
      // `resolveRange` clamps every window it produces, so one that reaches the port out of
      // bounds is a programming error; both implementations surface it rather than guessing.
      const store = await open();
      await store.put('audio/short', countingBytes(10), 'audio/flac');

      await expect(store.read({ objectKey: 'audio/short', start: 5, end: 10 })).rejects.toThrow(
        /out of bounds/,
      );
      await expect(store.read({ objectKey: 'audio/short', start: 7, end: 6 })).rejects.toThrow(
        /out of bounds/,
      );
    });

    it('refuses to read an object that does not exist', async () => {
      const store = await open();
      await expect(store.read({ objectKey: 'audio/none', start: 0, end: 0 })).rejects.toThrow(
        /no such object/,
      );
    });

    it('overwrites in place, so a second put replaces length and type together', async () => {
      const store = await open();
      await store.put('audio/replace', countingBytes(100), 'audio/wav');
      await store.put('audio/replace', countingBytes(40), 'audio/flac');

      expect(await store.head('audio/replace')).toEqual({ contentLength: 40, contentType: 'audio/flac' });
      const bytes = await collect(await store.read({ objectKey: 'audio/replace', start: 0, end: 39 }));
      expect(bytes).toEqual(countingBytes(40));
    });

    it('keeps objects under different keys apart', async () => {
      const store = await open();
      await store.put('audio/a', countingBytes(5), 'audio/wav');
      await store.put('audio/b', new Uint8Array([9, 9, 9]), 'audio/wav');

      expect((await store.head('audio/a'))?.contentLength).toBe(5);
      expect((await store.head('audio/b'))?.contentLength).toBe(3);
    });
  });
}

// The in-memory double's `put` predates the write port and is synchronous. Adapting it here,
// rather than changing the harness, keeps every existing playback test untouched.
contractFor('in-memory double', async () => {
  const double = inMemoryObjectStore([]);
  return {
    head: (key) => double.head(key),
    read: (request) => double.read(request),
    put: async (key, bytes, contentType) => {
      double.put(key, bytes, contentType);
    },
    remove: async (key) => {
      double.remove(key);
    },
  };
});

describe('filesystem object store', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function freshRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'musicstudio-objects-'));
    roots.push(root);
    return root;
  }

  contractFor('filesystem', async () => createFilesystemObjectStore(await freshRoot()));

  it('refuses a key that would escape the root, before touching the filesystem', async () => {
    // The one place the contract diverges on purpose: a map has no root to escape.
    const store = createFilesystemObjectStore(await freshRoot());

    for (const key of ['../outside', 'audio/../../etc/passwd', '/absolute', 'audio//double', '']) {
      await expect(store.put(key, new Uint8Array([1]), 'audio/wav')).rejects.toBeInstanceOf(
        ObjectKeyRejected,
      );
      await expect(store.head(key)).rejects.toBeInstanceOf(ObjectKeyRejected);
    }
    expect(await readdir(store.root)).toEqual([]);
  });

  it("refuses a key that would collide with the store's own sidecar or temp files", async () => {
    const store = createFilesystemObjectStore(await freshRoot());
    await expect(store.put('audio/x.meta.json', new Uint8Array([1]), 'audio/wav')).rejects.toBeInstanceOf(
      ObjectKeyRejected,
    );
    await expect(store.put('audio/x.tmp', new Uint8Array([1]), 'audio/wav')).rejects.toBeInstanceOf(
      ObjectKeyRejected,
    );
  });

  it('leaves no temporary file behind after a successful put', async () => {
    // The atomic write's tell: a `.tmp` that survives a put is a rename that did not happen.
    const store = createFilesystemObjectStore(await freshRoot());
    await store.put('audio/clean', countingBytes(16), 'audio/wav');

    const entries = await readdir(join(store.root, 'audio'));
    expect(entries.sort()).toEqual(['clean', 'clean.meta.json']);
  });

  it('treats bytes with no sidecar as absent rather than untyped', async () => {
    const store = createFilesystemObjectStore(await freshRoot());
    await store.put('audio/typed', countingBytes(4), 'audio/wav');
    await rm(join(store.root, 'audio', 'typed.meta.json'));

    expect(await store.head('audio/typed')).toBeNull();
  });

  it('removes both the object and its sidecar', async () => {
    const store = createFilesystemObjectStore(await freshRoot());
    await store.put('audio/gone', countingBytes(4), 'audio/wav');
    await store.remove('audio/gone');

    expect(await store.head('audio/gone')).toBeNull();
    expect(await readdir(join(store.root, 'audio'))).toEqual([]);
  });
});
