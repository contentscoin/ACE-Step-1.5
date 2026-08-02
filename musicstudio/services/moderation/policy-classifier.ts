/**
 * The content policy classifier, behind a port.
 *
 * Requirements 16.1 and 16.10 require an inspection; they do not say how it is
 * performed. The real classifier is expected to become a model, so the decision
 * lives behind this one-method interface and the pipeline never learns which
 * implementation it has. `rule-based-classifier.ts` supplies a deterministic
 * implementation that needs no network, no weights and no fixture — which is what
 * makes the pipeline testable at all.
 *
 * The port is synchronous on purpose. A model-backed classifier will need an
 * asynchronous call, but making that change later is a one-line signature edit,
 * whereas an `async` seam today would force every pure rule in the pipeline to be
 * awaited for no present benefit.
 */

import type { ModerationField } from '../../domain/moderation/fields';
import type { PolicyViolationClass } from '../../domain/moderation/violation-class';

/** One reason a piece of text failed inspection. */
export interface PolicyViolation {
  /** The classification Requirements 16.2 and 16.11 require in the response. */
  readonly violationClass: PolicyViolationClass;
  readonly field: ModerationField;
  /**
   * The text that triggered the classification — a term or utterance from the
   * input, never the whole input. It travels into the audit entry (16.7) so a
   * reviewer can see *why* without the log becoming a copy of user content.
   */
  readonly evidence: string;
}

export interface PolicyClassificationInput {
  readonly field: ModerationField;
  /**
   * The text as it will be sent onward — after Requirement 16.3 substitution.
   * Inspecting the pre-substitution text would flag a name the pipeline has
   * already neutralised.
   */
  readonly text: string;
}

export interface PolicyClassifierPort {
  /** Empty result means the text passed. Must be a pure function of the input. */
  classify(input: PolicyClassificationInput): readonly PolicyViolation[];
}

/** Passes everything. For tests where classification is not the subject. */
export const permissivePolicyClassifier: PolicyClassifierPort = {
  classify: () => [],
};
