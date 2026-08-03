/**
 * `@amicro/waveform-loader` — Requirement 31.1's **loading indicator** category, and the component
 * Requirement 31.6 names first among the eight permitted progress indicators.
 *
 * ### Why the bars are driven by `repeat` rather than by the progress value
 *
 * A loader that animated *from* the progress number would stop moving whenever the engine went
 * quiet for a few seconds, and a stopped indicator reads as a stopped job. Requirement 31.6 asks
 * for the indicator to be **shown** while the job waits or runs; 31.7 asks for the *number* to be
 * shown as text beside it. So the bars keep breathing on their own and the truth lives in the text
 * — which is the division `GenerationProgress` makes explicit.
 *
 * Under reduced motion this is still a `state_transfer` component (it says "the job is alive"), so
 * the bars keep moving, inside the 200 ms of Requirement 31.10.
 */

import { motion } from 'motion/react';
import type { ReactNode } from 'react';

import { transitionFor, useReducedMotion } from '../../motion/reduced-motion';
import type { MotionPresetId } from '../../motion/presets';

/** Bars in the waveform. Eight reads as a waveform and stays legible at 24 px tall. */
const BAR_COUNT = 8;

/** Seconds between one bar's cycle and the next, so the shape travels along the row. */
const BAR_PHASE_SECONDS = 0.09;

export interface WaveformLoaderProps {
  readonly preset?: MotionPresetId;
  readonly className?: string;
  /** For the accessible name — 31.7's text is `GenerationProgress`'s job, not this one's. */
  readonly label?: string;
}

export function WaveformLoader({
  preset = 'bouncy',
  className,
  label = '생성 중',
}: WaveformLoaderProps): ReactNode {
  const reduced = useReducedMotion();
  const resolved = transitionFor(preset, 'state_transfer', reduced);

  // A component that never animates has nothing to repeat, so the repeat is added only when
  // frames will actually play — `repeat: Infinity` on a zero-length transition is a busy loop.
  const transition =
    resolved.kind === 'instant'
      ? resolved.transition
      : { ...resolved.transition, repeat: Infinity, repeatType: 'mirror' as const };

  return (
    <div
      className={className}
      role="progressbar"
      aria-label={label}
      style={{ display: 'flex', alignItems: 'center', gap: 3, height: 24 }}
    >
      {Array.from({ length: BAR_COUNT }, (_unused, index) => (
        <motion.span
          key={index}
          initial={{ scaleY: 0.3 }}
          animate={{ scaleY: 1 }}
          transition={{ ...transition, delay: index * BAR_PHASE_SECONDS }}
          style={{
            display: 'block',
            width: 3,
            height: 24,
            borderRadius: 2,
            transformOrigin: 'center',
            background: 'currentColor',
          }}
        />
      ))}
    </div>
  );
}
