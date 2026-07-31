/**
 * Moderation_Service — the content policy inspection pipeline (design §9.1).
 *
 * One entry point, `inspect`, covering Requirements 16.1, 16.2, 16.3, 16.4, 16.7,
 * 16.10, 16.11, 16.12 and 16.14. The order of the four stages is the substantive
 * part:
 *
 * 1. **Substitute** artist names in style-bearing fields (16.3). Runs first so the
 *    classifier sees the text that will actually be sent onward — inspecting the
 *    pre-substitution text would flag a name the pipeline has already neutralised,
 *    turning a "we rewrote this for you" into a block.
 * 2. **Classify** every field's sanitized text (16.1 caption/lyrics/description,
 *    16.10 dialogue script, 16.11 impersonating utterance).
 * 3. **Consent**: rights confirmation on uploads (16.4, 16.14) and existence of a
 *    Voice_Consent_Record for a voice reference (16.12).
 * 4. **Decide**, and on a block write the audit entry (16.7).
 *
 * All reasons are collected rather than short-circuited, so one round trip tells the
 * caller everything that is wrong.
 *
 * **Credits.** Requirements 16.2 and 16.11 require the balance to be unchanged on a
 * block. This service has no credit port, so it cannot debit — the guarantee is
 * structural rather than a rule someone has to remember. The ordering that keeps any
 * debit strictly after approval lives in `generation-gate.ts`.
 */

import { substituteArtistNames } from '../../domain/moderation/artist-substitution';
import { isStyleBearingField, type ModerationField } from '../../domain/moderation/fields';
import type { PublicFigureEntry } from '../../domain/moderation/public-figures';
import {
  uploadsMissingRightsConsent,
  type UploadDeclaration,
} from '../../domain/moderation/upload-consent';
import type { AuditSinkPort } from '../../adapters/registry/ports';
import type { Clock } from '../clock';

import { policyBlockedDraft } from './audit';
import {
  rightsConsentBlockFor,
  violationClassesOf,
  type InspectedText,
  type ModerationBlock,
  type ModerationDecision,
  type SubstitutionNotice,
} from './decision';
import type { PolicyClassifierPort, PolicyViolation } from './policy-classifier';
import { denyingVoiceConsentLookup, type VoiceConsentLookupPort } from './voice-consent-port';

export interface ModerationTextInput {
  readonly field: ModerationField;
  readonly value: string;
}

/** Requirement 16.12 — a reference sample being attached to a Voice_Profile. */
export interface VoiceReferenceDeclaration {
  readonly voiceProfileId: string;
  readonly uploadIds: readonly string[];
}

export interface ModerationRequest {
  readonly accountId: string;
  /** Correlates the block audit entry with the generation request log (§11.2). */
  readonly requestId: string;
  readonly texts: readonly ModerationTextInput[];
  readonly uploads?: readonly UploadDeclaration[];
  readonly voiceReference?: VoiceReferenceDeclaration;
}

export interface ModerationServiceDependencies {
  readonly classifier: PolicyClassifierPort;
  readonly clock: Clock;
  readonly auditSink: AuditSinkPort;
  /** Task 6.2's store. Defaults to refusing, so an absent store fails closed. */
  readonly voiceConsent?: VoiceConsentLookupPort;
  /** Overridable so a deployment can supply the maintained curated list. */
  readonly figures?: readonly PublicFigureEntry[];
}

export class ModerationService {
  private readonly deps: ModerationServiceDependencies;
  private readonly voiceConsent: VoiceConsentLookupPort;

  constructor(deps: ModerationServiceDependencies) {
    this.deps = deps;
    this.voiceConsent = deps.voiceConsent ?? denyingVoiceConsentLookup;
  }

  inspect(request: ModerationRequest): ModerationDecision {
    const { texts, notices } = this.sanitize(request.texts);
    const blocks = [
      ...this.policyBlocks(texts),
      ...this.consentBlocks(request),
    ];

    if (blocks.length === 0) {
      return { outcome: 'approved', texts, notices };
    }

    const decision = {
      outcome: 'blocked' as const,
      blocks,
      violationClasses: violationClassesOf(blocks),
      texts,
    };

    // Requirement 16.7.
    this.deps.auditSink.record(
      policyBlockedDraft({
        accountId: request.accountId,
        requestId: request.requestId,
        decision,
        eventTimeMs: this.deps.clock.now().getTime(),
      }),
    );

    return decision;
  }

  /** Stage 1 — Requirement 16.3. */
  private sanitize(inputs: readonly ModerationTextInput[]): {
    texts: readonly InspectedText[];
    notices: readonly SubstitutionNotice[];
  } {
    const texts: InspectedText[] = [];
    const notices: SubstitutionNotice[] = [];

    for (const input of inputs) {
      if (!isStyleBearingField(input.field)) {
        texts.push({ field: input.field, original: input.value, sanitized: input.value });
        continue;
      }

      const result = substituteArtistNames(input.value, this.deps.figures);
      texts.push({ field: input.field, original: input.value, sanitized: result.text });
      for (const substitution of result.substitutions) {
        notices.push({ ...substitution, field: input.field });
      }
    }

    return { texts, notices };
  }

  /** Stage 2 — Requirements 16.1, 16.10, 16.11. */
  private policyBlocks(texts: readonly InspectedText[]): ModerationBlock[] {
    const violations: PolicyViolation[] = [];
    for (const text of texts) {
      violations.push(
        ...this.deps.classifier.classify({ field: text.field, text: text.sanitized }),
      );
    }

    return violations.length === 0 ? [] : [{ code: 'policy_violation', violations }];
  }

  /** Stage 3 — Requirements 16.4, 16.14, 16.12. */
  private consentBlocks(request: ModerationRequest): ModerationBlock[] {
    const blocks: ModerationBlock[] = [];

    const missing = uploadsMissingRightsConsent(request.uploads ?? []);
    if (missing.length > 0) {
      blocks.push(rightsConsentBlockFor(missing));
    }

    const voiceReference = request.voiceReference;
    if (
      voiceReference !== undefined &&
      !this.voiceConsent.hasUsableConsentRecord({
        voiceProfileId: voiceReference.voiceProfileId,
        submitterId: request.accountId,
      })
    ) {
      blocks.push({ code: 'voice_consent_missing', voiceProfileId: voiceReference.voiceProfileId });
    }

    return blocks;
  }
}
