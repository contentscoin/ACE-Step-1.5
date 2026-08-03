/**
 * `@amicro/fade-slide-enter` — Requirement 31.1's **entry transition** category.
 *
 * Classified `state_transfer` (`motion/classification.ts`): the animation is how the user learns a
 * panel appeared. Under reduced motion it therefore still plays, inside 200 ms (Requirement 31.10),
 * rather than being removed.
 *
 * The `initial`/`animate` values are opacity and offset — not spring parameters — so nothing here
 * trips the check of Requirement 31.5. The transition itself is always `transitionFor`'s answer.
 */

import { motion } from 'motion/react';
import type { ReactNode } from 'react';

import { transitionFor } from '../../motion/reduced-motion';
import { useReducedMotion } from '../../motion/reduced-motion';
import type { MotionPresetId } from '../../motion/presets';

export interface EnterTransitionProps {
  readonly children: ReactNode;
  /** Which preset to use. A preset *identifier*, never a spring (Requirement 31.4). */
  readonly preset?: MotionPresetId;
  readonly className?: string;
}

export function EnterTransition({
  children,
  preset = 'smooth',
  className,
}: EnterTransitionProps): ReactNode {
  const reduced = useReducedMotion();
  const resolved = transitionFor(preset, 'state_transfer', reduced);

  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={resolved.transition}
    >
      {children}
    </motion.div>
  );
}
