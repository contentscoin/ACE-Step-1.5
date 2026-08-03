/**
 * `@amicro/text-reveal` — Requirement 31.1's **text display** category.
 *
 * The one **decorative** component in the table, and the one where Requirement 31.9 is visible:
 * under reduced motion the words do not stagger in at all, they are simply *there*. That is what
 * "재생 프레임 수 0 + 애니메이션 종료 상태로 즉시 표시" means, and it is why `transitionFor`
 * returns a distinct `instant` kind rather than a very short duration — a 1 ms stagger is still
 * frames, and a reader who asked for less motion asked for none of this.
 *
 * The text is split on spaces so each word animates as a unit. Splitting on characters would
 * animate each grapheme, which reads as a typewriter rather than a reveal and — with Korean text
 * — would break a syllable block into jamo on some fonts.
 */

import { motion } from 'motion/react';
import type { ReactNode } from 'react';

import { transitionFor, useReducedMotion } from '../../motion/reduced-motion';
import type { MotionPresetId } from '../../motion/presets';

export interface TextRevealProps {
  readonly text: string;
  readonly preset?: MotionPresetId;
  readonly className?: string;
  /** Seconds between words. Not a spring parameter — see `scripts/check-motion-presets.mjs`. */
  readonly staggerSeconds?: number;
}

export function TextReveal({
  text,
  preset = 'gentle',
  className,
  staggerSeconds = 0.04,
}: TextRevealProps): ReactNode {
  const reduced = useReducedMotion();
  const resolved = transitionFor(preset, 'decorative', reduced);

  // Requirement 31.9: zero frames, end state immediately. One node, no per-word wrappers — a
  // stagger of zero would still mount 40 animating elements for nothing.
  if (resolved.kind === 'instant') {
    return <span className={className}>{text}</span>;
  }

  const words = text.split(' ');

  return (
    <span className={className}>
      {words.map((word, index) => (
        <motion.span
          key={`${word}-${String(index)}`}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ ...resolved.transition, delay: index * staggerSeconds }}
          style={{ display: 'inline-block', whiteSpace: 'pre' }}
        >
          {index === words.length - 1 ? word : `${word} `}
        </motion.span>
      ))}
    </span>
  );
}
