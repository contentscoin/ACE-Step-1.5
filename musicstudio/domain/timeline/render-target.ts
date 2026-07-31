/**
 * Requirements 28.19 and 28.20: which clips a mixdown renders.
 *
 * Both clauses are written as `THE Mixdown_Renderer SHALL`, and the renderer is task 4.2's.
 * They are here, as a pure function over a `Timeline_Project`, for two reasons: the decision is
 * made entirely from stored solo and mute state that task 4.1 owns (28.18, 28.32), and stating
 * it once means the renderer, the length calculation of 28.25 and the emptiness check of 28.29
 * cannot each answer "which clips?" differently. Task 4.2 consumes this; it does not restate it.
 *
 * The two clauses interact, and the interaction is the whole content of the function:
 *
 * - **28.20 first.** A clip is out if the clip is muted *or* its track is muted. The clause
 *   settles the collision explicitly — 동일 트랙이 솔로 상태이면서 음소거 상태인 경우 음소거를
 *   우선 적용 — so mute beats solo, and a track that is both is silent.
 * - **28.19 second.** *While* at least one track is soloed, only clips on soloed tracks survive.
 *   With no track soloed the clause does not apply and every unmuted clip survives, which is
 *   what makes solo a temporary focus rather than a stored filter.
 *
 * Clip order is preserved. Requirement 28.26's commutativity property (task 4.2's Property 12)
 * is about the *renderer* being insensitive to clip order; a selection step that reordered would
 * make that property test pass for a reason unrelated to the summation it is meant to check.
 */

import { type TimelineClip, type TimelineProject } from './project';

export type ClipExclusionReason = 'clip_muted' | 'track_muted' | 'not_soloed';

export interface ExcludedClip {
  readonly clipId: string;
  readonly reason: ClipExclusionReason;
}

export interface RenderTargetSet {
  /** Requirement 28.24's 렌더링 대상 클립, in project order. */
  readonly clips: readonly TimelineClip[];
  /** Why each other clip is out, so Requirement 28.29's rejection can say so. */
  readonly excluded: readonly ExcludedClip[];
  /** Whether Requirement 28.19's `WHILE` condition held. */
  readonly soloActive: boolean;
}

export function anyTrackSoloed(project: TimelineProject): boolean {
  return project.tracks.some((track) => track.solo);
}

/** Requirements 28.19, 28.20. */
export function renderTargetSet(project: TimelineProject): RenderTargetSet {
  const soloActive = anyTrackSoloed(project);
  const clips: TimelineClip[] = [];
  const excluded: ExcludedClip[] = [];

  for (const clip of project.clips) {
    const track = project.tracks[clip.track];

    // 28.20, applied before 28.19: mute wins, including over solo on the same track.
    if (clip.muted) {
      excluded.push({ clipId: clip.id, reason: 'clip_muted' });
      continue;
    }
    if (track === undefined || track.muted) {
      excluded.push({ clipId: clip.id, reason: 'track_muted' });
      continue;
    }

    // 28.19's `WHILE`: only meaningful when something is soloed.
    if (soloActive && !track.solo) {
      excluded.push({ clipId: clip.id, reason: 'not_soloed' });
      continue;
    }

    clips.push(clip);
  }

  return { clips, excluded, soloActive };
}
