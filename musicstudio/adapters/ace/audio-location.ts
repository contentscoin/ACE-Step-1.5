/**
 * Where a produced audio lives on the engine, as `/v1/audio` wants it.
 *
 * `/query_result` does not report a file path. Each item's `file` is what
 * `_path_to_audio_url` in `acestep/api_server.py` made of the path: the download URL
 * itself, `/v1/audio?path=<percent-encoded path>`. Passing that on as the `path` query
 * of another `/v1/audio` request double-wraps it, and `audio_route.py` answers 403
 * because the "path" is not inside its output directory — every real song failed at
 * the last step while the scripted engine, which reported bare paths, kept passing.
 *
 * A bare path is still accepted, because the engine's local-cache branch
 * (`query_result_service.py`) returns whatever was cached, and older engines did
 * report paths. Anything else — an absolute `http(s)://` URL (which `_path_to_audio_url`
 * passes through unchanged) or another route — is not fetchable through this adapter's
 * origin and is answered with `null` for the caller to refuse.
 */

/** The engine-side audio route; the same path as `ACE_PATHS.audio`. */
const AUDIO_ROUTE = '/v1/audio';

/** `scheme://` — a URL somewhere else. A Windows drive path (`C:\…`) does not match. */
const ABSOLUTE_URL = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * The engine-side path to request from `/v1/audio`, or `null` when `file` names none.
 *
 * Args: `file`, a non-empty `file` value from a `/query_result` item.
 * Returns: the decoded path for the engine's own download URL, `file` itself for a bare
 * path, and `null` for an absolute URL or a download URL without a `path`.
 */
export function engineAudioPathOf(file: string): string | null {
  if (file.startsWith(`${AUDIO_ROUTE}?`)) {
    // `URLSearchParams` undoes the encoding `urllib.parse.quote(path, safe="")` applied.
    const path = new URLSearchParams(file.slice(AUDIO_ROUTE.length + 1)).get('path');
    return path === null || path === '' ? null : path;
  }
  return ABSOLUTE_URL.test(file) ? null : file;
}
