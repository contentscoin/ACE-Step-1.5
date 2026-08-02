import {
  ACE_DEFAULT_EDIT_MODEL_CATALOGUE,
  ACE_DEFAULT_DIT_MODEL,
} from '../../adapters/ace/model-tasks';
import type { EditModelCatalogue } from '../../domain/edit/model-support';
import type { SourceAudioDescriptor } from '../../domain/edit/source-audio';
import type {
  EditSourceAudioPort,
  EditSourceAudioRecord,
} from '../../services/generation/edit-ports';

/**
 * Test stand-ins for the two Library_Service seams the Edit_Task path depends on.
 *
 * Requirement 7.10's constraints are properties of the *stored* audio, so a test that
 * wants to violate one states it here rather than manufacturing a file. That keeps the
 * whole of 7.10/7.11 assertable without storage, which is the point of the port being
 * narrow.
 */

/** A 200-second, 8 MB wav — inside every Requirement 7.10 bound. */
export const VALID_SOURCE_AUDIO: SourceAudioDescriptor = {
  assetId: 'asset-source-1',
  format: 'wav',
  durationSeconds: 200,
  sizeBytes: 8 * 1024 * 1024,
  enginePath: '/tmp/ace-uploads/asset-source-1.wav',
};

export interface ConfigurableSourceAudioPort extends EditSourceAudioPort {
  /** Register (or replace) the audio behind an asset id. */
  set(record: EditSourceAudioRecord): void;
  /** Forget an asset, so the gateway reports it missing. */
  remove(assetId: string): void;
  readonly queries: readonly { readonly accountId: string; readonly assetId: string }[];
}

export function createSourceAudioPort(
  ...records: readonly EditSourceAudioRecord[]
): ConfigurableSourceAudioPort {
  const byId = new Map<string, EditSourceAudioRecord>();
  const queries: { accountId: string; assetId: string }[] = [];
  for (const record of records.length === 0 ? [VALID_SOURCE_AUDIO] : records) {
    byId.set(record.assetId, record);
  }

  return {
    queries,
    set(record) {
      byId.set(record.assetId, record);
    },
    remove(assetId) {
      byId.delete(assetId);
    },
    find: async (query) => {
      queries.push({ accountId: query.accountId, assetId: query.assetId });
      return byId.get(query.assetId);
    },
  };
}

/** The engine's real catalogue: turbo cannot extract/lego/complete, base can. */
export const TEST_EDIT_MODEL_CATALOGUE: EditModelCatalogue = ACE_DEFAULT_EDIT_MODEL_CATALOGUE;

/** A base checkpoint, so a test can request every one of the five edit kinds. */
export const BASE_DIT_MODEL = 'acestep-v15-base';

/** The engine's default checkpoint, which is a turbo one (Requirement 7.9's subject). */
export const TURBO_DIT_MODEL = ACE_DEFAULT_DIT_MODEL;
