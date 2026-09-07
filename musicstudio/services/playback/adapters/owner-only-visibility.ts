/**
 * `AssetVisibilityPort` for a deployment with no sharing (roadmap §4.4, slice S6).
 *
 * Requirement 12.6 gates a private asset's stream, and Requirement 14 — publishing an asset,
 * minting its link, revoking it — is what makes an asset public. `Sharing_Service` exists and
 * every rule in it is tested, but none of its stores has a PostgreSQL adapter yet (§4.5 B1), so
 * a composed gateway has no table in which an asset could have been published.
 *
 * The truthful answer in that state is "nothing is public", and that is what this returns. It
 * is not a hole in the gate: `playback-service.ts` checks ownership *first*, so an owner still
 * streams their own audio, and this decides only the case the deployment cannot yet reach —
 * a stranger asking for someone else's asset, which is refused, which is correct while no
 * asset can have been shared.
 *
 * The failure mode to avoid was the opposite one. A port that answered `true` to get streaming
 * working would have made every asset in the system world-readable, and nothing in the tests
 * would have said so.
 */

import type { AssetVisibilityPort } from '../ports';

export const ownerOnlyVisibility: AssetVisibilityPort = {
  isPubliclyVisible: async () => false,
};
