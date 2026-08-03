/**
 * The random source behind Requirement 14.2's "추측이 어려운 공개 링크".
 *
 * `randomBytes`, not `randomUUID` and not `Math.random`. The three differ in ways that
 * matter for a bearer credential:
 *
 * - `Math.random` is not a CSPRNG. Its output is predictable from a handful of samples, and
 *   a share token an attacker can predict is not a share token.
 * - `randomUUID` is cryptographically random but carries 122 bits, not 128, and renders as
 *   a *recognisable* shape. Both are survivable; neither is a reason to prefer it here when
 *   256 bits costs the same call.
 *
 * base64url because the token is a URL path segment (see `domain/sharing/share-link.ts`):
 * no `+`, no `/`, no `=` to escape, so the token that arrives is the token that was issued.
 */

import { randomBytes } from 'node:crypto';

import { SHARE_TOKEN_ENTROPY_BYTES } from '../../domain/sharing/bounds';
import type { ShareTokenSource } from './ports';

export const cryptoShareTokenSource: ShareTokenSource = {
  next: () => randomBytes(SHARE_TOKEN_ENTROPY_BYTES).toString('base64url'),
};
