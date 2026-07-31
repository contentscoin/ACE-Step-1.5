/**
 * Requirement 26.27 — the responsible-use guidance link.
 *
 * The criterion asks for the document to be reachable in **one interaction** from the
 * `cloned` profile creation screen and the voice conversion screen, and for it to cover
 * the six prohibited uses and the withdrawal procedure. What the backend can guarantee
 * is that both surfaces are handed the same absolute URL alongside the consent
 * requirements, rather than each screen hard-coding a path that can rot independently.
 *
 * The rendered document is the web layer's (task 7.x). The six labels travel with the
 * link so a screen can show them inline without a second request, which is also what
 * makes "one interaction" achievable rather than aspirational.
 */

import {
  PROHIBITED_USE_CLASSES,
  PROHIBITED_USE_LABELS,
  type ProhibitedUseClass,
} from '../../domain/voice/prohibited-use';
import {
  IDENTITY_VERIFICATION_WINDOW_MS,
  WITHDRAWAL_INTAKE_WINDOW_MS,
} from '../../domain/voice/windows';

export const RESPONSIBLE_USE_GUIDE_PATH = '/guides/responsible-voice-use';

export interface ProhibitedUseSummary {
  readonly class: ProhibitedUseClass;
  readonly label: string;
}

export interface ResponsibleUseGuidance {
  /** Absolute, so a client never assembles it from a base URL of its own. */
  readonly guideUrl: string;
  readonly prohibitedUses: readonly ProhibitedUseSummary[];
  /** Requirement 26.28 — hours from intake to provisional restriction. */
  readonly withdrawalIntakeHours: number;
  /** Requirement 26.31 — days the claimant has to verify identity. */
  readonly identityVerificationDays: number;
}

export function responsibleUseGuidance(publicBaseUrl: string): ResponsibleUseGuidance {
  return {
    guideUrl: new URL(RESPONSIBLE_USE_GUIDE_PATH, publicBaseUrl).toString(),
    prohibitedUses: PROHIBITED_USE_CLASSES.map((value) => ({
      class: value,
      label: PROHIBITED_USE_LABELS[value],
    })),
    withdrawalIntakeHours: WITHDRAWAL_INTAKE_WINDOW_MS / 3_600_000,
    identityVerificationDays: IDENTITY_VERIFICATION_WINDOW_MS / 86_400_000,
  };
}
