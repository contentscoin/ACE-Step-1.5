/**
 * The waiting/running display (Requirements 31.6, 31.7).
 *
 * The loader says "alive", the text says "where" — see `progress.ts` for why those are two things
 * and not one. The text refreshes on its own timer rather than only when the parent re-renders,
 * because 31.7's 2-second bound is about the *display*, and a parent that happened not to
 * re-render would leave a stale number on screen indefinitely.
 */

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { WaveformLoader } from '../amicro/WaveformLoader';
import {
  PROGRESS_TEXT_REFRESH_MS,
  progressLabel,
  type ProgressState,
} from './progress';

export interface GenerationProgressProps {
  /** Read on each tick, so a polling client can hand over a mutable source. */
  readonly read: () => ProgressState;
  readonly className?: string;
}

export function GenerationProgress({ read, className }: GenerationProgressProps): ReactNode {
  const [label, setLabel] = useState(() => progressLabel(read()));

  useEffect(() => {
    const timer = setInterval(() => {
      setLabel(progressLabel(read()));
    }, PROGRESS_TEXT_REFRESH_MS);
    return () => {
      clearInterval(timer);
    };
  }, [read]);

  return (
    <div className={className} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <WaveformLoader label={label.text} />
      {/* `aria-live` so a screen reader hears the number change without polling the DOM. */}
      <span aria-live="polite" style={{ fontVariantNumeric: 'tabular-nums' }}>
        {label.text}
      </span>
    </div>
  );
}
