/**
 * Lyric-synced music video, behind a feature flag (Requirement 10.9).
 *
 * Requirement 10.9 opens with `WHERE 뮤직비디오 생성 기능이 활성화된 경우` — it is
 * conditional on a capability being switched on, not unconditional. So what task 2.3
 * owns is the gate and the seam: the flag, the port, and the guarantee that the
 * renderer is handed the same `Timed_Lyrics` the LRC file was printed from.
 *
 * No video pipeline is built here, and that is deliberate rather than deferred work.
 * A renderer belongs with the Python DSP/media worker (design §5, §12), needs an
 * encoder in the deployment, and has no requirement clauses describing its output
 * format, resolution or typography. Implementing one behind this port later changes
 * nothing above it.
 */

import type { TimedLyrics } from '../../domain/lyrics/timed-lyrics';

export interface LyricVideoRequest {
  readonly trackId: string;
  /** The rendered audio to lay under the video. */
  readonly audioAssetId: string;
  /** Already ordered and bounds-checked by `TimedLyricsService`. */
  readonly timedLyrics: TimedLyrics;
}

export interface LyricVideoRendition {
  readonly videoAssetId: string;
}

export interface LyricVideoPort {
  render(request: LyricVideoRequest): Promise<LyricVideoRendition>;
}

/**
 * The flag plus its implementation.
 *
 * `port` is optional so that "enabled with nothing wired" is representable and is
 * treated as disabled rather than as a crash — a misconfigured flag should not fail a
 * download that Requirement 10.8 promises independently of 10.9.
 */
export interface LyricVideoFeature {
  readonly enabled: boolean;
  readonly port?: LyricVideoPort;
}

export const LYRIC_VIDEO_DISABLED: LyricVideoFeature = { enabled: false };

export type LyricVideoOutcome =
  | { readonly kind: 'rendered'; readonly rendition: LyricVideoRendition }
  /** The feature is off, or no renderer is wired. Not an error. */
  | { readonly kind: 'disabled' };

export async function requestLyricVideo(
  feature: LyricVideoFeature,
  request: LyricVideoRequest,
): Promise<LyricVideoOutcome> {
  if (!feature.enabled || feature.port === undefined) return { kind: 'disabled' };
  return { kind: 'rendered', rendition: await feature.port.render(request) };
}
