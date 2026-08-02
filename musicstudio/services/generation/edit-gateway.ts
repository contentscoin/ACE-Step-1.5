/**
 * Generation_Gateway for Edit_Tasks (Requirement 7).
 *
 * Every criterion in Requirement 7 except 7.12 begins "THE Generation_Gateway SHALL",
 * and this is that gateway. It does four things and stops:
 *
 * 1. Resolves the source audio through the Library_Service port (7.10's subject).
 * 2. Validates — strength, interval, track, upload constraints, model capability —
 *    through `domain/edit/validation.ts`, and refuses with the violated constraint and
 *    its allowed value (7.2, 7.4, 7.6, 7.7, 7.9, 7.11).
 * 3. Submits to the Job_Orchestrator, which owns the lifecycle, the credit debit and
 *    the moderation gate (tasks 1.4, 1.5, 6.1). None of that is re-derived here.
 * 4. Returns the acceptance *together with* any Requirement 7.5 adjustment.
 *
 * The one thing worth reading carefully is the difference between 7.4 and 7.5, and it
 * is not decided here — `domain/edit/repaint-range.ts` decides it. 7.4 comes back as
 * an `invalid` validation and becomes a 400; 7.5 comes back as a `valid` validation
 * carrying an adjustment, and the request goes through with the clamped end.
 *
 * Requirement 7.12 is not here either, and deliberately so: lineage is written when
 * the assets exist, which is after the engine finishes, so it lives on the publication
 * path (`edit-lineage.ts`) rather than on the submit path.
 */

import { assetKindForEditKind } from '../../domain/edit/edit-kind';
import type { EditModelCatalogue } from '../../domain/edit/model-support';
import type { EditAdjustment, EditParameters, EditRequest } from '../../domain/edit/request';
import { validateEditRequest } from '../../domain/edit/validation';
import type { EditFieldViolation } from '../../domain/edit/violation';
import type { UploadDeclaration } from '../../domain/moderation/upload-consent';
import type { SongFieldViolation } from '../../domain/song/violation';
import type { ModerationDecision } from '../moderation/decision';

import { editRequestInvalid, editSourceAssetNotFound, editTaskUnsupported } from './edit-errors';
import type { EditSourceAudioPort } from './edit-ports';
import type { JobOrchestrator, SubmitJobInput, SubmitOutcome } from './job-orchestrator';

/**
 * Context handed to the moderation hook.
 *
 * The upload declaration is built here rather than by the caller, because the gateway
 * is the only place that knows the edit's purpose is `audio_edit` — which is what
 * Requirement 16.4 keys the rights-consent requirement off. The consent rule itself
 * stays in task 6.1's `Moderation_Service`; this only supplies its input, so there is
 * no second consent policy.
 */
export interface EditModerationContext {
  readonly uploads: readonly UploadDeclaration[];
  readonly edit: EditParameters;
}

export interface EditGatewayOptions {
  readonly orchestrator: JobOrchestrator;
  readonly sourceAudio: EditSourceAudioPort;
  /** Requirement 7.9's per-model capability table. */
  readonly catalogue: EditModelCatalogue;
}

export interface EditSubmissionInput {
  readonly accountId: string;
  readonly request: EditRequest;
  /** Engine named by the caller (Requirement 20.3). */
  readonly engineId?: string;
  /** Requirements 16.2/16.4/16.11, evaluated lazily by the orchestrator (§9.1). */
  readonly moderate?: (context: EditModerationContext) => ModerationDecision;
  /**
   * The uploader's rights confirmation (Requirement 16.4), when the source audio was
   * uploaded for this edit. Passed straight into the declaration the
   * Moderation_Service inspects.
   */
  readonly rightsConsent?: UploadDeclaration['rightsConsent'];
}

export interface EditSubmissionResult {
  readonly outcome: SubmitOutcome;
  /** Requirement 7.5: the adjustments applied, reported to the caller. */
  readonly adjustments: readonly EditAdjustment[];
}

export class EditGateway {
  private readonly orchestrator: JobOrchestrator;
  private readonly sourceAudio: EditSourceAudioPort;
  private readonly catalogue: EditModelCatalogue;

  constructor(options: EditGatewayOptions) {
    this.orchestrator = options.orchestrator;
    this.sourceAudio = options.sourceAudio;
    this.catalogue = options.catalogue;
  }

  async submit(input: EditSubmissionInput): Promise<EditSubmissionResult> {
    const { request } = input;
    const source = await this.sourceAudio.find({
      accountId: input.accountId,
      assetId: request.sourceAssetId,
    });
    if (source === undefined) throw editSourceAssetNotFound(request.sourceAssetId);

    const validation = validateEditRequest({
      request,
      sourceAudio: source,
      catalogue: this.catalogue,
    });

    if (validation.kind === 'invalid') {
      throw this.rejectionFor(input, validation.violations, validation.styleViolations);
    }

    const outcome = await this.orchestrator.submit(
      this.submissionOf(input, validation.parameters),
    );
    return { outcome, adjustments: validation.adjustments };
  }

  /**
   * Requirement 7.9 gets its own error; every other violation shares one.
   *
   * The model violation is recognised by its `models` allowance, which is the only
   * allowance kind that carries a supporting-model list, so the split needs no second
   * flag threaded out of the validator.
   */
  private rejectionFor(
    input: EditSubmissionInput,
    violations: readonly EditFieldViolation[],
    styleViolations: readonly SongFieldViolation[],
  ): Error {
    const unsupported = violations.find((violation) => violation.allowed.kind === 'models');
    if (unsupported !== undefined && unsupported.allowed.kind === 'models') {
      return editTaskUnsupported(
        input.request.kind,
        input.request.model ?? this.catalogue.defaultModel,
        unsupported.allowed.supportedBy,
      );
    }
    return editRequestInvalid(violations, styleViolations);
  }

  private submissionOf(input: EditSubmissionInput, edit: EditParameters): SubmitJobInput {
    const moderate = input.moderate;
    const context: EditModerationContext = {
      edit,
      uploads: [uploadDeclarationFor(edit, input.rightsConsent)],
    };

    return {
      accountId: input.accountId,
      // Design §3.6: extract yields `stem`, the rest yield `song`. This is what routes
      // the request and, through Requirement 19.7, what forces its lineage.
      assetKind: assetKindForEditKind(edit.kind),
      // Requirement 7's edits all start from audio, whatever else they carry.
      inputModality: 'audio',
      // The source length is what the engine works over, and what Requirement 2.2
      // prices. An edit does not choose an output length, so nothing is reserved.
      durationMs: Math.round(edit.source.durationSeconds * 1000),
      resultCount: edit.style.batchSize,
      // Requirement 7.12's parent, stated at the job level so a retry keeps it.
      inputAssetIds: [edit.source.assetId],
      edit,
      ...(edit.style.caption === undefined ? {} : { prompt: edit.style.caption }),
      ...(edit.style.seed === undefined ? {} : { seed: edit.style.seed }),
      ...(input.engineId === undefined ? {} : { engineId: input.engineId }),
      ...(moderate === undefined ? {} : { moderate: () => moderate(context) }),
    };
  }
}

/** Requirement 16.4: an edit's source audio is an `audio_edit` upload. */
function uploadDeclarationFor(
  edit: EditParameters,
  rightsConsent: UploadDeclaration['rightsConsent'],
): UploadDeclaration {
  return {
    uploadId: edit.source.assetId,
    purpose: 'audio_edit',
    mediaKind: 'audio',
    ...(rightsConsent === undefined ? {} : { rightsConsent }),
  };
}
