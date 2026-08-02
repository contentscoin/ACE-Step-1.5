/**
 * Edit_Task rejections (Requirements 7.4, 7.9, 7.11, 7.12).
 *
 * Three errors, because the criteria ask for three different things:
 *
 * - `edit_request_invalid` covers 7.4 and 7.11 — and 7.2, 7.6, 7.7 — because all of
 *   them are the same answer in different words: refuse, name the violated
 *   constraint, state its allowed value. The violation list carries both, as data.
 * - `edit_task_unsupported` is 7.9 specifically, which asks for something the other
 *   errors cannot express: *which models would work*. It is separated so a client can
 *   act on it — offer the model switch — rather than parsing a generic message.
 * - `edit_lineage_rejected` is a 7.12 write that the design §4.2 invariants refuse.
 *   500 rather than 4xx: the request was accepted and the engine has already produced
 *   audio, so this is an internal inconsistency, not caller error.
 *
 * All three are `GenerationError`s, so `api/gateway/error-handler.ts` renders them
 * with no new branch and `details` reaches the client inside the `error` object.
 */

import type { EditKind } from '../../domain/edit/edit-kind';
import { describeEditViolation, type EditFieldViolation } from '../../domain/edit/violation';
import { describeViolation, type SongFieldViolation } from '../../domain/song/violation';
import type { LineageEdge } from '../../domain/lineage/graph';
import type { LineageViolation } from '../../domain/lineage/invariants';

import { GenerationError } from './errors';

/** Requirements 7.2, 7.4, 7.6, 7.7, 7.10, 7.11. */
export function editRequestInvalid(
  violations: readonly EditFieldViolation[],
  styleViolations: readonly SongFieldViolation[] = [],
): GenerationError {
  const messages = [
    ...violations.map(describeEditViolation),
    ...styleViolations.map(describeViolation),
  ];

  return new GenerationError(400, 'edit_request_invalid', messages.join('; '), {
    violations,
    ...(styleViolations.length === 0 ? {} : { styleViolations }),
  });
}

/**
 * Requirement 7.9 — the selected model cannot do this edit.
 *
 * 409 rather than 400: the request is well formed and would succeed unchanged against
 * a different model, which is what the `supportedBy` list is for.
 */
export function editTaskUnsupported(
  kind: EditKind,
  model: string,
  supportedBy: readonly string[],
): GenerationError {
  const detail =
    supportedBy.length === 0
      ? `No available DiT model supports the "${kind}" Edit_Task.`
      : `The "${model}" DiT model does not support the "${kind}" Edit_Task. Supported by: ${supportedBy.join(', ')}.`;

  return new GenerationError(409, 'edit_task_unsupported', detail, {
    editKind: kind,
    selectedModel: model,
    supportedBy,
  });
}

/** Requirement 7.12 write refused by the design §4.2 invariants. */
export function editLineageRejected(
  violations: readonly LineageViolation[],
  edge?: LineageEdge,
): GenerationError {
  return new GenerationError(
    500,
    'edit_lineage_rejected',
    `Lineage for the Edit_Task result violates ${violations.map((violation) => violation.invariant).join(', ')}.`,
    { violations, ...(edge === undefined ? {} : { edge }) },
  );
}

/** The source asset an edit named does not exist, or is not the caller's. */
export function editSourceAssetNotFound(assetId: string): GenerationError {
  return new GenerationError(
    404,
    'edit_source_asset_not_found',
    'No such source Audio_Asset.',
    { assetId },
  );
}
