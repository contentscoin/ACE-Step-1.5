/**
 * Reading a whole object out of the store (roadmap §4.4, slice S6).
 *
 * `AudioObjectPort` deliberately serves *windows*: Requirement 12.3 gives a seek one second to
 * start sending, so the streaming path never materialises an object it is going to hand out a
 * slice of. The two S6 read paths are the opposite case — the DSP converts and reduces whole
 * files, and both tasks take the bytes over the wire — so they need the whole object, and this
 * is the one place that says so out loud rather than each adapter quietly draining a stream.
 *
 * `head` first, because the port's `read` takes an inclusive end and there is no "to the end"
 * form: the length is what turns "all of it" into a window. An object with no metadata is
 * absent as far as the store is concerned, and this reports that as `null` rather than as an
 * empty buffer — a caller that converted zero bytes would produce a valid, silent file.
 */

import type { AudioObjectPort } from '../ports';

export async function readWholeObject(
  objects: AudioObjectPort,
  objectKey: string,
): Promise<Uint8Array | null> {
  const metadata = await objects.head(objectKey);
  if (metadata === null) return null;
  if (metadata.contentLength === 0) return new Uint8Array(0);

  const stream = await objects.read({
    objectKey,
    start: 0,
    end: metadata.contentLength - 1,
  });

  // A reader rather than `for await`: async iteration over a `ReadableStream` is a newer
  // addition than the stream itself, and the port promises the stream, not the iterator.
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    chunks.push(value);
    total += value.length;
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
