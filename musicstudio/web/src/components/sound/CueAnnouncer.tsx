/**
 * The visual half of every cue (Requirements 32.15, 32.16).
 *
 * ### A sound is never the only channel
 *
 * Requirement 32.15 requires the mapped element and the status sentence to appear **within 200 ms**
 * of a cue and to stay for at least three seconds. This component is what makes that true for the
 * sentence: it subscribes to the layer, and a cue renders synchronously in the same task, so the
 * 200 ms budget is not a number to measure — there is no scheduling between the event and the
 * paint.
 *
 * The three-second floor is a timer, and it is a *floor*: a second cue arriving inside it replaces
 * the text rather than queueing, because the newer state is the true one and a queue would show
 * the user a state they had already left.
 *
 * ### The three states are told apart without colour
 *
 * Requirement 32.16 asks for **two or more non-colour channels**: a distinct icon shape and a
 * distinct text label. Both are here — `▲` / `■` / `●` and 성공 / 경고 / 오류 — and the colour is a
 * third channel on top rather than the carrier. A test asserts the shapes and the labels are
 * pairwise distinct, which is the part that would rot if someone unified the icons for tidiness.
 *
 * A suppressed cue announces nothing: Requirement 32.15 fires "WHEN 사운드 큐 재생이 요청되면",
 * and a request that returned `played: false` because sound is off should not put a toast on the
 * screen. The status text is a companion to the sound, not a replacement for it — the screens
 * already say what happened in their own markup.
 */

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { STATUS_PRESENTATION, type StatusKind } from '../../a11y/status';
import { cueDefinition, type CueSeverity, type SemanticCue } from '../../sound/cues';
import { useSound } from '../../sound/context';
import { chip, meta, panel, row } from '../../styles/ui';

/** Requirement 32.15's floor. */
export const CUE_ANNOUNCE_MIN_MS = 3_000;

/**
 * Requirement 32.16's channels come from `a11y/status.ts`, not from a table here.
 *
 * A cue's severity and a refusal's kind are the same four states, and the clause is about the
 * product's states rather than the sound layer's. Re-exported so existing importers keep working
 * — the type alias is what makes `CueSeverity` and `StatusKind` provably the same union.
 */
const _severityIsStatusKind: Record<CueSeverity, StatusKind> = {
  neutral: 'neutral',
  success: 'success',
  warning: 'warning',
  error: 'error',
};
void _severityIsStatusKind;

export const SEVERITY_PRESENTATION = STATUS_PRESENTATION;

interface Announcement {
  readonly cue: SemanticCue;
  readonly severity: CueSeverity;
  readonly status: string;
  readonly elements: readonly string[];
}

export function CueAnnouncer(): ReactNode {
  const sound = useSound();
  const [announcement, setAnnouncement] = useState<Announcement | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const unsubscribe = sound.subscribe((event) => {
      if (event.kind !== 'cue' || !event.result.played) return;
      const definition = cueDefinition(event.cue);
      setAnnouncement({
        cue: event.cue,
        severity: definition.severity,
        status: definition.status,
        elements: definition.elements,
      });
      // Replace rather than queue — see the module header.
      clearTimeout(timer);
      timer = setTimeout(() => {
        setAnnouncement(null);
      }, CUE_ANNOUNCE_MIN_MS);
    });

    return () => {
      unsubscribe();
      clearTimeout(timer);
    };
  }, [sound]);

  if (announcement === null) return null;

  const presentation = SEVERITY_PRESENTATION[announcement.severity];

  return (
    <div
      // `status` rather than `alert`: an alert interrupts a screen reader mid-sentence, and these
      // are companions to what the screen already says.
      role="status"
      aria-live="polite"
      data-cue={announcement.cue}
      style={{
        ...panel,
        ...row,
        position: 'fixed',
        right: 16,
        bottom: 16,
        maxWidth: 380,
        zIndex: 50,
        borderColor: presentation.tone,
      }}
    >
      <span aria-hidden="true" style={{ fontSize: 18 }}>
        {presentation.shape}
      </span>
      <div style={{ flex: 1 }}>
        {/* The label is text, so the state survives a greyscale screen and a screen reader. */}
        <span style={chip}>{presentation.label}</span>
        <div style={{ marginTop: 4 }}>{announcement.status}</div>
        <div style={meta}>{announcement.elements.join(' · ')}</div>
      </div>
    </div>
  );
}
