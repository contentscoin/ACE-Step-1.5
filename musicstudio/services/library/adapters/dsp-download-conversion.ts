/**
 * `DownloadConversionPort` over the DSP sidecar (roadmap §4.4, slice S6).
 *
 * Requirement 13.3's re-encode runs in the worker (`musicstudio_dsp.convert_for_download`);
 * this reads the stored object, hands the bytes and the tags across, and returns what came
 * back. It decides nothing: entitlement is 13.4's and the download service's, the file name is
 * 13.6's, and the tag *wording* is the domain's. What this adds is the fetch and the shape.
 *
 * ### The tags come back from the file, and this file does not touch them
 *
 * `DownloadPayload.tags` is documented as "the tags the encoder actually wrote back into the
 * file, read back from it", and `download-service.ts` compares them with what it asked for and
 * refuses the download when they differ. That comparison is only worth making if this adapter
 * passes through what the worker read out of the encoded bytes rather than echoing its own
 * argument — so `convert_for_download_task` calls `read_tags` on its own output, and this
 * returns that value untouched. Echoing here would make the check compare a value with itself
 * and quietly certify every unmarked download.
 *
 * ### Whole bytes over the wire, still
 *
 * The base64-in-JSON transport is the stopgap `worker.py` names, and a download pays for it
 * twice — once out of the store, once through the sidecar. The replacement is the same one the
 * publication path is waiting for: an object key instead of bytes, once the sidecar can reach
 * the object store. Nothing above this file changes when that happens.
 */

import type { DspConversionClient } from '../../generation/adapters/dsp-http-client';
import type { AudioObjectPort } from '../../playback/ports';
import { readWholeObject } from '../../playback/adapters/object-bytes';
import { libraryAudioUnavailable } from '../errors';
import type { DownloadConversionPort, DownloadPayload } from '../ports';

export interface DspDownloadConversionOptions {
  readonly objects: AudioObjectPort;
  readonly dsp: DspConversionClient;
}

export function createDspDownloadConversion(
  options: DspDownloadConversionOptions,
): DownloadConversionPort {
  return {
    async convert(request): Promise<DownloadPayload> {
      const bytes = await readWholeObject(options.objects, request.objectKey);
      // The service already refused an asset with no `objectKey`; this is the object itself
      // being gone, which is the same answer to the user — there is no audio to send — and it
      // reuses the service's own error so the response does not depend on which layer noticed.
      if (bytes === null) throw libraryAudioUnavailable(request.objectKey);

      const converted = await options.dsp.convertForDownload(bytes, request.format, request.tags);
      return {
        bytes: converted.bytes,
        format: converted.format,
        sampleRate: converted.sampleRate,
        tags: converted.tags,
      };
    },
  };
}
