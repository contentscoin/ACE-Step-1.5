/**
 * `@amicro/hover-lift` — Requirement 31.1's **hover interaction** category.
 *
 * ### Requirements 31.11–31.14 are why this is a `motion.div` around the child rather than a
 * wrapper that replaces it
 *
 * 31.11 keeps every interactive component receiving pointer and keyboard input **while an
 * animation plays**, with zero blocked milliseconds. Motion animates transforms on the compositor
 * and never sets `pointer-events`, so the child stays hittable throughout — but only if the
 * wrapper does not introduce an overlay of its own, which is the usual way this invariant gets
 * broken.
 *
 * The lift is `whileHover`/`whileFocus` together, so 31.14's focus indicator has the same geometry
 * the hover state does: a focus ring drawn on the child moves with the child, and the boundary
 * difference stays at 0 px rather than the 2 px the criterion permits.
 */

import { motion } from 'motion/react';
import type { ReactNode } from 'react';

import { transitionFor, useReducedMotion } from '../../motion/reduced-motion';
import type { MotionPresetId } from '../../motion/presets';

export interface HoverLiftProps {
  readonly children: ReactNode;
  readonly preset?: MotionPresetId;
  readonly className?: string;
}

export function HoverLift({ children, preset = 'snappy', className }: HoverLiftProps): ReactNode {
  const reduced = useReducedMotion();
  const resolved = transitionFor(preset, 'state_transfer', reduced);

  return (
    <motion.div
      className={className}
      whileHover={{ y: -2 }}
      whileFocus={{ y: -2 }}
      transition={resolved.transition}
    >
      {children}
    </motion.div>
  );
}
