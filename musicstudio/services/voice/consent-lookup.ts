/**
 * Task 6.1's `VoiceConsentLookupPort`, implemented (Requirement 16.12).
 *
 * 6.1 declared the port and left it failing closed until this task landed. Its report
 * fixed the contract this must honour: `hasUsableConsentRecord` returns **false** for
 * `잠정_사용_제한` and `사용_중지`, so the withdrawal state machine stays in one place
 * and Moderation_Service never re-decides whether a record is still valid.
 *
 * This is therefore a *composition*, not a policy. Both questions it answers are already
 * decided elsewhere:
 *
 * - is the profile usable right now? -> `ProfileAccessService.isUsable`, which reads
 *   `refusesGenerationForWithdrawal` (26.29) and the share list (26.18/26.20)
 * - does an affirmative clone record exist? -> `domain/voice/consent-record.ts`
 *
 * There is no second consent policy here and no branch that could become one: the only
 * logic is the conjunction.
 */

import {
  validateConsent,
  type VoiceConsentRecord,
} from '../../domain/voice/consent-record';

import type { VoiceConsentLookupPort, VoiceConsentQuery } from '../moderation/voice-consent-port';
import type { ProfileAccessService } from './profile-access-service';
import type { VoiceConsentRecordStorePort } from './store';

export interface VoiceConsentLookupDependencies {
  readonly records: VoiceConsentRecordStorePort;
  readonly access: ProfileAccessService;
}

/**
 * A record counts when it targets this profile, is a `clone` record, and validates.
 *
 * Re-validating a stored record rather than trusting a stored "valid" flag is
 * intentional: 26.14 makes records immutable, so re-running the pure rule can only ever
 * agree with what was decided at intake, and it means a change to the rule cannot leave
 * stale approvals behind.
 *
 * The submitter is *not* required to match. 26.12's record is about the speaker's
 * permission, not about who is generating; who may generate is 26.18/26.20's share list,
 * which `ProfileAccessService.isUsable` already applies to `submitterId`. Requiring both
 * would refuse a shared profile for every user except the one who first uploaded it.
 */
function hasAffirmativeCloneRecord(
  records: readonly VoiceConsentRecord[],
  voiceProfileId: string,
): boolean {
  return records.some(
    (record) =>
      record.draft.kind === 'clone' &&
      record.draft.targetProfileId === voiceProfileId &&
      validateConsent(record.draft).outcome === 'accepted',
  );
}

export function createVoiceConsentLookup(
  deps: VoiceConsentLookupDependencies,
): VoiceConsentLookupPort {
  return {
    hasUsableConsentRecord(query: VoiceConsentQuery): boolean {
      // Covers 26.22's deletion, 26.29's two withdrawal states and 26.18/26.20's
      // permission in one call.
      if (!deps.access.isUsable(query.voiceProfileId, query.submitterId)) return false;

      return hasAffirmativeCloneRecord(
        deps.records.recordsFor(query.voiceProfileId),
        query.voiceProfileId,
      );
    },
  };
}
