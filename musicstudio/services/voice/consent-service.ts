/**
 * Voice_Consent_Record intake (Requirements 26.12, 26.13, 26.14, 26.15, 26.26, 26.27).
 *
 * One rule governs the ordering here and it is the whole reason this is a service rather
 * than a validator: **the record is checked before the reference sample is persisted.**
 * Requirement 26.12 says the record is required "참조 샘플 영구 저장 이전 단계에서", and
 * 26.13 requires the upload to be discarded without permanent storage when the check
 * fails. A validator called after storage could not satisfy either, no matter what it
 * returned.
 *
 * So `recordCloneConsent` returns a verdict that *names* what the caller must do with
 * the upload, and task 2.7's Voice_Profile creation path calls it before it writes
 * anything durable.
 */

import { randomUUID } from 'node:crypto';

import type { AuditSinkPort } from '../../adapters/registry/ports';
import {
  missingConsentRecord,
  validateCloneConsent,
  validateVoiceConvertConsent,
  type CloneConsentRecordDraft,
  type ConsentItem,
  type ConsentRecordKind,
  type VoiceConsentRecord,
  type VoiceConvertConsentRecordDraft,
} from '../../domain/voice/consent-record';
import type { Clock } from '../clock';

import { consentRecordedDraft } from './audit';
import { consentIncomplete } from './errors';
import { responsibleUseGuidance, type ResponsibleUseGuidance } from './responsible-use';
import type { VoiceConsentRecordStorePort } from './store';

export interface ConsentServiceDependencies {
  readonly records: VoiceConsentRecordStorePort;
  readonly clock: Clock;
  readonly auditSink: AuditSinkPort;
  /** Requirement 26.27 — where the responsible-use document lives. */
  readonly publicBaseUrl: string;
  readonly newConsentRecordId?: () => string;
}

/**
 * Requirement 26.13 — the verdict, including what to do with the upload.
 *
 * `discardUploads` is stated rather than left implicit because it is an action the
 * caller must take, and a boolean the caller has to derive from `outcome` is a boolean
 * someone eventually forgets.
 */
export type ConsentIntake =
  | { readonly outcome: 'recorded'; readonly record: VoiceConsentRecord }
  | {
      readonly outcome: 'rejected';
      readonly unmetItems: readonly ConsentItem[];
      readonly discardUploads: true;
    };

export class ConsentService {
  private readonly deps: ConsentServiceDependencies;
  private readonly newId: () => string;

  constructor(deps: ConsentServiceDependencies) {
    this.deps = deps;
    this.newId = deps.newConsentRecordId ?? (() => randomUUID());
  }

  /**
   * Requirements 26.12–26.15 — the `cloned` profile record.
   *
   * `draft` may be `undefined`, which is 26.13's "동의 기록이 첨부되지 않았"; it is
   * answered with the same item list a negative record gets, so a client fixing the
   * request has one shape to handle.
   */
  recordCloneConsent(draft: CloneConsentRecordDraft | undefined): ConsentIntake {
    const validation =
      draft === undefined ? missingConsentRecord('clone') : validateCloneConsent(draft);

    if (validation.outcome === 'rejected') return rejectIntake(validation.unmetItems);
    return this.store(draft as CloneConsentRecordDraft);
  }

  /** Requirement 26.26 — the voice conversion record, a Generation_Job precondition. */
  recordVoiceConvertConsent(
    draft: VoiceConvertConsentRecordDraft | undefined,
  ): ConsentIntake {
    const validation =
      draft === undefined
        ? missingConsentRecord('voice_convert')
        : validateVoiceConvertConsent(draft);

    if (validation.outcome === 'rejected') return rejectIntake(validation.unmetItems);
    return this.store(draft as VoiceConvertConsentRecordDraft);
  }

  /**
   * Same checks, raising `VoiceError` instead of returning a verdict.
   *
   * For the HTTP path, where 422 with the unmet item names *is* the response. The
   * verdict-returning form stays for task 2.7's creation path, which has an upload to
   * discard before it can answer.
   */
  requireCloneConsent(draft: CloneConsentRecordDraft | undefined): VoiceConsentRecord {
    const intake = this.recordCloneConsent(draft);
    if (intake.outcome === 'rejected') throw consentIncomplete(intake.unmetItems);
    return intake.record;
  }

  requireVoiceConvertConsent(
    draft: VoiceConvertConsentRecordDraft | undefined,
  ): VoiceConsentRecord {
    const intake = this.recordVoiceConvertConsent(draft);
    if (intake.outcome === 'rejected') throw consentIncomplete(intake.unmetItems);
    return intake.record;
  }

  recordsFor(voiceProfileId: string): readonly VoiceConsentRecord[] {
    return this.deps.records.recordsFor(voiceProfileId);
  }

  /** Requirement 26.27 — handed to both screens the criterion names. */
  guidance(): ResponsibleUseGuidance {
    return responsibleUseGuidance(this.deps.publicBaseUrl);
  }

  private store(
    draft: CloneConsentRecordDraft | VoiceConvertConsentRecordDraft,
  ): ConsentIntake {
    const record: VoiceConsentRecord = { consentRecordId: this.newId(), draft };
    this.deps.records.append(record);

    // Requirement 26.15.
    this.deps.auditSink.record(
      consentRecordedDraft({
        submitterId: draft.submitterId,
        voiceProfileId: draft.targetProfileId,
        consentRecordId: record.consentRecordId,
        kind: draft.kind satisfies ConsentRecordKind,
        eventTimeMs: this.deps.clock.now().getTime(),
      }),
    );

    return { outcome: 'recorded', record };
  }
}

function rejectIntake(unmetItems: readonly ConsentItem[]): ConsentIntake {
  return { outcome: 'rejected', unmetItems, discardUploads: true };
}
