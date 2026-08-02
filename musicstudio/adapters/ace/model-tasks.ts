/**
 * The DiT model capability catalogue Requirement 7.9 refuses against.
 *
 * ACE-Step reports capability per model, not per deployment: `/v1/models` returns
 * `{ name, is_default, is_loaded, supported_task_types }` for every checkpoint it can
 * see, and `_read_model_supported_tasks` in
 * `acestep/api/http/model_service_routes.py` answers `TASK_TYPES_TURBO` for a model
 * whose `config.json` sets `is_turbo` and `TASK_TYPES_BASE` for everything else.
 *
 * So there are two ways to populate the catalogue and both belong here:
 *
 * - `aceEditModelCatalogueFrom` — the real one, folding an engine `/v1/models`
 *   answer into the product layer's `EditModelCatalogue`. This is the integration
 *   point: whoever polls the engine's inventory feeds it in, and the catalogue then
 *   reflects the checkpoints actually installed.
 * - `ACE_DEFAULT_EDIT_MODEL_CATALOGUE` — the fallback for a composition that has not
 *   read the inventory yet, built from the model names in
 *   `acestep/api/model_download.py` and the same turbo rule the engine applies.
 *
 * **Discrepancy worth knowing**: the engine's Gradio path uses a *different* rule.
 * `get_ui_control_config` in `acestep/ui/gradio/events/generation/model_config.py`
 * grants the base task list only when `is_pure_base` is set, which means an SFT
 * checkpoint is offered the turbo task list in the UI while `/v1/models` reports it
 * the base list. The product layer talks HTTP only (design §1.4.4), so it follows the
 * HTTP answer, and `aceEditModelCatalogueFrom` prefers the engine's own report over
 * any local inference.
 */

import {
  editModelCatalogue,
  type EditModelCapability,
  type EditModelCatalogue,
} from '../../domain/edit/model-support';

import {
  ACE_TASK_TYPES_BASE,
  ACE_TASK_TYPES_TURBO,
  editKindsForTaskTypes,
} from './task-type';

/** One entry of the engine's `/v1/models` answer, in the fields this needs. */
export interface AceModelInventoryEntry {
  readonly name: string;
  readonly supportedTaskTypes: readonly string[];
  readonly isDefault?: boolean;
}

/**
 * `true` when the engine would flag this checkpoint `is_turbo`.
 *
 * Name-based, because the flag lives in a `config.json` the product layer cannot
 * read. Used only for the fallback catalogue; a real inventory answer carries the
 * task list outright and never needs this.
 */
export function isAceTurboModelName(model: string): boolean {
  return /(^|[-_])turbo([-_]|$)/.test(model.toLowerCase());
}

/** Requirement 7.9's catalogue, from whatever the engine reported. */
export function aceEditModelCatalogueFrom(
  inventory: readonly AceModelInventoryEntry[],
  fallbackDefaultModel: string = ACE_DEFAULT_DIT_MODEL,
): EditModelCatalogue {
  const models: readonly EditModelCapability[] = inventory.map((entry) => ({
    model: entry.name,
    supportedKinds: editKindsForTaskTypes(entry.supportedTaskTypes),
  }));
  const declaredDefault = inventory.find((entry) => entry.isDefault === true)?.name;

  return editModelCatalogue(models, declaredDefault ?? fallbackDefaultModel);
}

/**
 * The engine's own default checkpoint.
 *
 * `acestep/api/lifespan_runtime.py` defaults `ACESTEP_CONFIG_PATH` to this name, so
 * an edit request that selects no model is judged against the model the engine would
 * have used anyway.
 */
export const ACE_DEFAULT_DIT_MODEL = 'acestep-v15-turbo';

/** The checkpoints `MODEL_REPO_MAPPING` in `acestep/api/model_download.py` knows. */
export const ACE_KNOWN_DIT_MODELS: readonly string[] = [
  'acestep-v15-turbo',
  'acestep-v15-turbo-shift3',
  'acestep-v15-base',
  'acestep-v15-sft',
];

/**
 * Fallback catalogue, applying the `/v1/models` rule to the known model names.
 *
 * A composition that has read the engine inventory should replace this; it exists so
 * Requirement 7.9 has a defensible answer before the first inventory poll rather than
 * silently accepting every edit on every model.
 */
export const ACE_DEFAULT_EDIT_MODEL_CATALOGUE: EditModelCatalogue = aceEditModelCatalogueFrom(
  ACE_KNOWN_DIT_MODELS.map((name) => ({
    name,
    supportedTaskTypes: isAceTurboModelName(name)
      ? [...ACE_TASK_TYPES_TURBO]
      : [...ACE_TASK_TYPES_BASE],
    isDefault: name === ACE_DEFAULT_DIT_MODEL,
  })),
);
