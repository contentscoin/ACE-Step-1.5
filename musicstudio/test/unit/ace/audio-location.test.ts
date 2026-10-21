import { describe, expect, it } from 'vitest';

import { engineAudioPathOf } from '../../../adapters/ace/audio-location';

/**
 * Unwrapping the `file` value `/query_result` reports.
 *
 * Each case is a shape `acestep/api_server.py::_path_to_audio_url` or the engine's
 * local-cache branch can produce.
 */
describe('engineAudioPathOf', () => {
  it('decodes the path out of the engine download URL', () => {
    // `urllib.parse.quote(path, safe="")` encodes "/" too.
    expect(engineAudioPathOf('/v1/audio?path=%2Ftmp%2Fapi_audio%2Fa%20b.flac')).toBe(
      '/tmp/api_audio/a b.flac',
    );
  });

  it('round-trips non-ASCII paths', () => {
    const path = '/data/출력/곡.flac';
    expect(engineAudioPathOf(`/v1/audio?path=${encodeURIComponent(path)}`)).toBe(path);
  });

  it('passes a bare path through, Windows drive paths included', () => {
    expect(engineAudioPathOf('/tmp/cached.flac')).toBe('/tmp/cached.flac');
    expect(engineAudioPathOf('C:\\acestep\\out.flac')).toBe('C:\\acestep\\out.flac');
  });

  it('names nothing for an absolute URL or a download URL without a path', () => {
    expect(engineAudioPathOf('https://cdn.example/out.flac')).toBeNull();
    expect(engineAudioPathOf('/v1/audio?other=1')).toBeNull();
    expect(engineAudioPathOf('/v1/audio?path=')).toBeNull();
  });
});
