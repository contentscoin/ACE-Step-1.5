/**
 * Which DiT model supports which Edit_Task (Requirement 7.9).
 *
 * Requirement 7.9 refuses an edit the *selected model* cannot do and returns the
 * models that can, so the answer needs a per-model table rather than a per-engine
 * one. That is deliberately not on `Engine_Descriptor` (design §3.2): a descriptor
 * describes one engine deployment, while ACE-Step serves several DiT checkpoints
 * behind a single deployment and reports their capabilities per model on
 * `/v1/models` (`supported_task_types` in
 * `acestep/api/http/model_service_routes.py`). Folding a sub-model distinction into
 * the descriptor would either flatten it — one engine, one capability set, which is
 * false — or make the descriptor grow a second, nested capability model.
 *
 * So the catalogue is its own value, pure and engine-agnostic here, populated from
 * the engine's own report in `adapters/ace/model-tasks.ts`.
 */

import { EDIT_KINDS, type EditKind } from './edit-kind';

export interface EditModelCapability {
  /** Model name as the engine reports and accepts it, e.g. `acestep-v15-base`. */
  readonly model: string;
  readonly supportedKinds: readonly EditKind[];
}

export interface EditModelCatalogue {
  readonly models: readonly EditModelCapability[];
  /** Used when a request names no model. */
  readonly defaultModel: string;
}

export function editModelCatalogue(
  models: readonly EditModelCapability[],
  defaultModel: string,
): EditModelCatalogue {
  return { models, defaultModel };
}

export function findEditModel(
  catalogue: EditModelCatalogue,
  model: string,
): EditModelCapability | undefined {
  return catalogue.models.find((entry) => entry.model === model);
}

/**
 * `true` only when the catalogue positively says so.
 *
 * A model the catalogue has never heard of is *not* treated as capable. Requirement
 * 7.9 exists to stop a request the engine would reject from being charged for, and
 * assuming capability for an unknown name would defeat that; the caller is told
 * which models are known to support the edit instead.
 */
export function supportsEditKind(
  catalogue: EditModelCatalogue,
  model: string,
  kind: EditKind,
): boolean {
  return findEditModel(catalogue, model)?.supportedKinds.includes(kind) ?? false;
}

/** Requirement 7.9's list, in catalogue order so the answer is stable. */
export function modelsSupportingEditKind(
  catalogue: EditModelCatalogue,
  kind: EditKind,
): readonly string[] {
  return catalogue.models
    .filter((entry) => entry.supportedKinds.includes(kind))
    .map((entry) => entry.model);
}

/** Edit kinds no model in the catalogue can perform. Empty in a healthy catalogue. */
export function unsupportedEditKinds(catalogue: EditModelCatalogue): readonly EditKind[] {
  return EDIT_KINDS.filter((kind) => modelsSupportingEditKind(catalogue, kind).length === 0);
}
