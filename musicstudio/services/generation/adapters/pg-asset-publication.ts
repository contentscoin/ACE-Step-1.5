/**
 * `AssetPublicationPort`, for real (roadmap §4.4, step S3).
 *
 * This is the third of the three seams the re-plan found missing, and the one the other two
 * exist for. Until this file the port's only implementation was the recording double in the
 * test harness: it counted results and minted ids, and no byte the engine produced was ever
 * stored anywhere. This is the act of storing — the thing Requirement 16.6 means by "저장되면".
 *
 * ### The order of the four steps is the whole design
 *
 * For each result the engine produced:
 *
 * 1. **Normalise** through the DSP (`normalise_for_storage`): Requirement 19.4's 48 kHz and
 *    16.6's watermark, with the scheme version *reported back* rather than assumed.
 * 2. **Validate** the asset and its provenance with the domain's own functions, so a bad row
 *    is refused in the product's vocabulary before the database refuses it in its own.
 * 3. **Put** the normalised bytes under `audio/<asset id>`.
 * 4. **Insert** the `audio_asset` row, provenance included. If the insert fails, the object
 *    written in step 3 is removed — a stored object with no row is an orphan nothing can find
 *    or delete, and the sweep in Requirement 11.8 only knows about rows.
 *
 * The bytes go into the store *before* the row, not after. The row is what makes an asset
 * exist to the product, and an asset that exists but whose bytes are still arriving is the
 * state the atomic write in the filesystem store was built to prevent one layer down; this
 * ordering prevents it one layer up.
 *
 * ### Provenance is assembled from three sources, none of them this file
 *
 * - The engine's licence — `weightLicenseId`, `attributionText`, `commercialUseAllowed` and the
 *   non-commercial list version — comes from `EngineLicensePort`, which the composition root
 *   adapts from the `ProviderRegistry`. This file does not know what a registry is.
 * - The disclosure pair — `aiGenerated: true` and `watermarkId` — comes from
 *   `DisclosureService.provenanceFieldsFor(version)`, given the version step 1 reported.
 * - The engine's original sample rate comes from the DSP report (Requirement 19.5).
 *
 * `validateProvenance` then checks the whole, so a source that drifts is caught here.
 *
 * ### Lineage is not written here
 *
 * `withEditLineage` wraps this port and records the edge for a derived asset; `ports.ts` says
 * so. A `stem` or `mix` inserted through this port alone would be refused by the database's
 * deferred lineage trigger at commit, which is the correct outcome — it means the wrapper was
 * forgotten, and the error names the requirement.
 *
 * ### Only successful results become assets
 *
 * Requirement 5.6 says one `Audio_Asset` per result entry, and a result whose `status` is
 * `'failed'` has no audio to be an asset of. The returned ids are in result order *among the
 * successes*; the caller's own record of how many it asked for tells it how many are missing.
 */

import { randomUUID } from 'node:crypto';

import { validateAudioAsset, type AudioAsset } from '../../../domain/audio-asset';
import { validateProvenance, type AssetProvenance } from '../../../domain/provenance';
import type { LicenseDescriptor } from '../../../adapters/registry/license-descriptor';
import type { NormalizedGenerationResult } from '../../../adapters/normalized-generation';
import type { AudioObjectWritePort } from '../../playback/ports';
import type { Clock } from '../../clock';
import type { JobStorePort } from '../job-store';
import type { AssetPublicationPort, AssetPublicationRequest } from '../ports';

import type { DspClient } from './dsp-http-client';

/** The slice of `pg` this adapter uses; structural for the reasons `pg-account-repository.ts` gives. */
export interface PgQueryable {
  query<Row extends Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Row[] }>;
}

/** What an engine's licence contributes to every asset it produces (Requirement 33.7). */
export interface EngineLicense {
  readonly license: LicenseDescriptor;
  readonly nonCommercialLicenseListVersion: number;
}

/**
 * Engine id → licence. A port rather than the `ProviderRegistry` itself, so this adapter can be
 * exercised with a stub and the registry's class surface is not part of its contract.
 */
export interface EngineLicensePort {
  licenseFor(engineId: string): EngineLicense | null;
}

/** The two provenance fields Requirement 33.14 pairs; `DisclosureService.provenanceFieldsFor`. */
export interface DisclosureProvenancePort {
  provenanceFieldsFor(watermarkVersion: number): {
    readonly aiGenerated: true;
    readonly watermarkId: string;
  };
}

export interface PgAssetPublicationDependencies {
  readonly db: PgQueryable;
  readonly objects: AudioObjectWritePort;
  readonly dsp: DspClient;
  readonly licenses: EngineLicensePort;
  readonly disclosure: DisclosureProvenancePort;
  readonly clock: Clock;
  /**
   * Where an asset's name comes from. The publication request does not carry the prompt, so the
   * job is looked up here when a store is supplied; without one, names fall back to a label
   * built from the kind and the job id. Requirement 11.5 lets the user rename either way.
   */
  readonly jobs?: JobStorePort;
  readonly newId?: () => string;
}

/** `audio_asset.name` is bounded 1..200; a name from a prompt is cut to leave room for a suffix. */
const NAME_FROM_TEXT_MAX = 80;

/** A stored object's key. Fixed shape, so the key never has to be looked up to be derived. */
export function objectKeyFor(assetId: string): string {
  return `audio/${assetId}`;
}

export class AssetPublicationRejected extends Error {
  constructor(
    readonly jobId: string,
    readonly resultIndex: number,
    readonly violations: readonly string[],
  ) {
    super(
      `asset from job ${jobId} result ${String(resultIndex)} rejected: ${violations.join(', ')}`,
    );
    this.name = 'AssetPublicationRejected';
  }
}

export class EngineLicenseUnknown extends Error {
  constructor(readonly engineId: string) {
    super(`no licence is registered for engine ${engineId}`);
    this.name = 'EngineLicenseUnknown';
  }
}

function truncate(text: string, max: number): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

export function createPgAssetPublication(deps: PgAssetPublicationDependencies): AssetPublicationPort {
  const newId = deps.newId ?? randomUUID;

  async function nameFor(request: AssetPublicationRequest, index: number, count: number): Promise<string> {
    const suffix = count > 1 ? ` ${String(index + 1)}` : '';
    const job = deps.jobs === undefined ? undefined : await deps.jobs.find(request.jobId);
    const text = job?.input.song?.caption ?? job?.input.song?.description ?? job?.input.prompt;
    if (text !== undefined && text.trim() !== '') {
      return `${truncate(text, NAME_FROM_TEXT_MAX)}${suffix}`;
    }
    return `${request.assetKind} ${request.jobId.slice(0, 8)}${suffix}`;
  }

  async function publishOne(
    request: AssetPublicationRequest,
    result: NormalizedGenerationResult,
    index: number,
    count: number,
    license: EngineLicense,
  ): Promise<string> {
    // 1. Normalise. The version that comes back is the one that marked these bytes.
    const normalised = await deps.dsp.normaliseForStorage(new Uint8Array(result.audioBuffer));

    const id = newId();
    // `Clock.now()` is a `Date`; the row and the provenance record milliseconds.
    const nowMs = deps.clock.now().getTime();
    const disclosure = deps.disclosure.provenanceFieldsFor(normalised.watermarkVersion);

    const provenance: AssetProvenance = {
      engineId: request.engineId,
      weightLicenseId: license.license.weightLicenseId,
      attributionText: license.license.attributionText,
      commercialUseAllowed: license.license.commercialUseAllowed,
      nonCommercialLicenseListVersion: license.nonCommercialLicenseListVersion,
      recordedAtMs: nowMs,
      aiGenerated: disclosure.aiGenerated,
      watermarkId: disclosure.watermarkId,
    };

    const asset: AudioAsset = {
      id,
      ownerId: request.accountId,
      name: await nameFor(request, index, count),
      assetKind: request.assetKind,
      durationMs: Math.round(normalised.durationMs),
      sampleRate: normalised.sampleRate,
      channels: normalised.channels,
      engineId: request.engineId,
      seed: result.seed,
      isLoop: false,
      commercialUseAllowed: license.license.commercialUseAllowed,
      provenance,
      createdAtMs: nowMs,
      isDeleted: false,
    };

    // 2. Validate in the domain's vocabulary before the database's.
    const violations = [
      ...validateAudioAsset(asset),
      ...validateProvenance(provenance).map((violation) => `provenance:${String(violation)}`),
    ];
    if (violations.length > 0) {
      throw new AssetPublicationRejected(request.jobId, index, violations);
    }

    // 3. Bytes first, under a key derived from the id, so nothing has to be looked up later.
    const objectKey = objectKeyFor(id);
    const contentType = `audio/${normalised.audioFormat}`;
    await deps.objects.put(objectKey, normalised.bytes, contentType);

    // 4. The row. On failure the object goes too — see the header.
    try {
      await deps.db.query(
        `INSERT INTO audio_asset
           (id, owner_id, name, asset_kind, duration_ms, sample_rate, channels, engine_id, seed,
            is_loop, commercial_use_allowed, provenance, created_at, is_deleted, object_key)
         VALUES ($1, $2, $3, $4::asset_kind, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, false, $14)`,
        [
          asset.id,
          asset.ownerId,
          asset.name,
          asset.assetKind,
          asset.durationMs,
          asset.sampleRate,
          asset.channels,
          asset.engineId,
          asset.seed,
          asset.isLoop,
          asset.commercialUseAllowed,
          JSON.stringify(provenance),
          new Date(asset.createdAtMs),
          objectKey,
        ],
      );
    } catch (error) {
      await deps.objects.remove(objectKey);
      throw error;
    }

    return id;
  }

  return {
    async publish(request) {
      const license = deps.licenses.licenseFor(request.engineId);
      if (license === null) throw new EngineLicenseUnknown(request.engineId);

      const successes = request.results.filter((result) => result.status === 'success');
      const ids: string[] = [];
      for (const [index, result] of successes.entries()) {
        ids.push(await publishOne(request, result, index, successes.length, license));
      }
      return ids;
    },
  };
}
