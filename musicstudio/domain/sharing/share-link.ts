/**
 * The public link (Requirement 14.2), and what makes it "추측이 어려운".
 *
 * The token is a **bearer credential**. Requirement 14.3 hands the page to an
 * unauthenticated visitor holding the link, so anyone who guesses a token gets everything a
 * legitimate visitor gets. That makes the token's width the whole access-control story, and
 * the two rules below follow from it:
 *
 * - **Random, not derived.** A token derived from the asset identifier, the owner or the
 *   publication time is guessable by anyone who knows those, and all three leak: an asset
 *   id appears in the owner's own URLs, a publication time is displayed on the page itself.
 * - **Reissued on republication.** Revoking (14.4) destroys the token rather than parking
 *   it. Reusing the old one on republication would make a link the owner believed dead come
 *   back to life without them doing anything, which is not what "공개 철회" promises anyone
 *   who was given the link in between.
 *
 * Generating a token needs a random source and is therefore in `services/sharing`; this
 * module is the shape, the predicate and the URL, which are pure.
 */

import { SHARE_TOKEN_LENGTH } from './bounds';

/** base64url — the alphabet `Buffer.toString('base64url')` produces, with no padding. */
const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface ShareLink {
  readonly assetId: string;
  readonly token: string;
  readonly publishedAtMs: number;
  /** Requirement 14.9. `false` unless the owner said otherwise. */
  readonly remixAllowed: boolean;
}

export function isShareToken(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length === SHARE_TOKEN_LENGTH &&
    SHARE_TOKEN_PATTERN.test(value)
  );
}

/**
 * The public URL for a token.
 *
 * The token is a *path* segment rather than a query parameter, because query strings are
 * logged by proxies and analytics far more casually than paths are, and this one is a
 * credential. `baseUrl` is supplied by the caller — nothing in the domain knows the host.
 */
export function shareLinkUrl(baseUrl: string, token: string): string {
  const root = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  return `${root}/s/${token}`;
}

/** The token in a public URL, or `null` if the URL is not one. */
export function shareTokenFromUrl(url: string): string | null {
  const match = /\/s\/([A-Za-z0-9_-]+)\/?$/.exec(url);
  const token = match?.[1];
  return token !== undefined && isShareToken(token) ? token : null;
}
