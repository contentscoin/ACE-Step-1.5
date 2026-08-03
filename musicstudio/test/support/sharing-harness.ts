/**
 * In-memory stores for `Sharing_Service` and `Persona_Service` (Requirements 14, 15).
 *
 * The feed store's `page` is literally `applyFeedQuery`, and the like store's `add` is a
 * `Map` keyed the way `asset_like`'s primary key is keyed — both on purpose. The seam
 * `services/sharing/ports.ts` describes exists so the rules live in one place and a store,
 * this one or a SQL one, implements the same function rather than its own reading of it.
 *
 * The training port models the engine as it actually is: **one run at a time**, refusing a
 * second `start` while one is live. A fake that accepted every start would make the queue in
 * `persona-service.ts` untestable, which is the part of it most likely to be wrong.
 */

import { applyFeedQuery, type FeedPage, type FeedQuery } from '../../domain/sharing/feed';
import type { AssetKind } from '../../domain/asset-kind';
import type { AssetReviewState } from '../../domain/moderation/review-state';
import type { PersonaStatus } from '../../domain/persona/persona';
import type { ShareLink } from '../../domain/sharing/share-link';
import { likeKey, type AssetLike } from '../../domain/sharing/like';
import type {
  LikeStore,
  ShareStore,
  ShareTokenSource,
  ShareableAsset,
  SoundPackShare,
  SoundPackShareStore,
} from '../../services/sharing/ports';
import type {
  PersonaAssetLookupPort,
  PersonaRecord,
  PersonaStore,
  PersonaTrainingPort,
  TrainingStartOutcome,
  TrainingStatusReport,
} from '../../services/persona/ports';

export const OWNER_ID = 'owner-1';
export const STRANGER_ID = 'owner-2';
export const ASSET_ID = 'asset-a';

export function shareableAsset(overrides: Partial<ShareableAsset> = {}): ShareableAsset {
  return {
    id: ASSET_ID,
    ownerId: OWNER_ID,
    name: 'Untitled',
    assetKind: 'song' as AssetKind,
    caption: '',
    tags: [],
    genres: [],
    playCount: 0,
    likeCount: 0,
    isDeleted: false,
    reviewState: 'none' as AssetReviewState,
    publishedAtMs: null,
    durationMs: 60_000,
    isLoop: false,
    remixAllowed: false,
    shareToken: null,
    ...overrides,
  };
}

export interface InMemoryShareStore extends ShareStore {
  readonly rows: Map<string, ShareableAsset>;
  /** For a test that wants to simulate a report arriving, or a soft delete. */
  patch(assetId: string, patch: Partial<ShareableAsset>): void;
}

export function inMemoryShareStore(
  seed: readonly ShareableAsset[] = [shareableAsset()],
  voiceProfileAssets: ReadonlyMap<string, readonly string[]> = new Map(),
): InMemoryShareStore {
  const rows = new Map(seed.map((asset) => [asset.id, asset]));

  function require(assetId: string): ShareableAsset {
    const asset = rows.get(assetId);
    if (asset === undefined) throw new Error(`no such asset: ${assetId}`);
    return asset;
  }

  return {
    rows,
    patch: (assetId, patch) => {
      rows.set(assetId, { ...require(assetId), ...patch });
    },
    find: async (assetId) => rows.get(assetId) ?? null,
    findByToken: async (token) =>
      [...rows.values()].find((asset) => asset.shareToken === token) ?? null,
    publish: async (link: ShareLink) => {
      const next: ShareableAsset = {
        ...require(link.assetId),
        shareToken: link.token,
        publishedAtMs: link.publishedAtMs,
        remixAllowed: link.remixAllowed,
      };
      rows.set(link.assetId, next);
      return next;
    },
    revoke: async (assetId) => {
      const next: ShareableAsset = {
        ...require(assetId),
        shareToken: null,
        publishedAtMs: null,
        remixAllowed: false,
      };
      rows.set(assetId, next);
      return next;
    },
    page: async (query: FeedQuery): Promise<FeedPage> => applyFeedQuery([...rows.values()], query),
    publicAssetIdsForVoiceProfile: async (voiceProfileId) =>
      (voiceProfileAssets.get(voiceProfileId) ?? []).filter((assetId) => {
        const asset = rows.get(assetId);
        return asset !== undefined && asset.publishedAtMs !== null;
      }),
  };
}

export interface InMemoryLikeStore extends LikeStore {
  readonly rows: Map<string, AssetLike>;
}

/** Keyed exactly as `PRIMARY KEY (asset_id, account_id)` is — see `domain/sharing/like.ts`. */
export function inMemoryLikeStore(): InMemoryLikeStore {
  const rows = new Map<string, AssetLike>();
  // `likeKey`, not a second spelling of it: `asset_like`'s primary key is one thing.
  const key = likeKey;

  return {
    rows,
    add: async (like) => {
      const id = key(like.assetId, like.accountId);
      if (rows.has(id)) return false;
      rows.set(id, like);
      return true;
    },
    remove: async (assetId, accountId) => rows.delete(key(assetId, accountId)),
    countFor: async (assetId) =>
      [...rows.values()].filter((like) => like.assetId === assetId).length,
    hasLiked: async (assetId, accountId) => rows.has(key(assetId, accountId)),
  };
}

export function inMemorySoundPackShareStore(
  seed: readonly SoundPackShare[] = [],
): SoundPackShareStore & { readonly rows: Map<string, SoundPackShare> } {
  const rows = new Map(seed.map((pack) => [pack.soundPackId, pack]));

  function require(soundPackId: string): SoundPackShare {
    const pack = rows.get(soundPackId);
    if (pack === undefined) throw new Error(`no such pack: ${soundPackId}`);
    return pack;
  }

  return {
    rows,
    find: async (soundPackId) => rows.get(soundPackId) ?? null,
    findByToken: async (token) => [...rows.values()].find((pack) => pack.token === token) ?? null,
    publish: async (soundPackId, token, atMs, remixAllowed) => {
      const next = { ...require(soundPackId), token, publishedAtMs: atMs, remixAllowed };
      rows.set(soundPackId, next);
      return next;
    },
    revoke: async (soundPackId) => {
      const next = {
        ...require(soundPackId),
        token: null,
        publishedAtMs: null,
        remixAllowed: false,
      };
      rows.set(soundPackId, next);
      return next;
    },
  };
}

/** Deterministic tokens of the published length, so a test can assert on them. */
export function countingTokenSource(prefix = 'tok'): ShareTokenSource & { issued: string[] } {
  const issued: string[] = [];
  let counter = 0;
  return {
    issued,
    next: () => {
      counter += 1;
      const body = `${prefix}${String(counter)}`;
      const token = body.padEnd(43, '0');
      issued.push(token);
      return token;
    },
  };
}

// ---------------------------------------------------------------- persona

export function personaRecord(overrides: Partial<PersonaRecord> = {}): PersonaRecord {
  return {
    id: 'persona-1',
    ownerId: OWNER_ID,
    name: 'My Voice',
    status: 'queued' as PersonaStatus,
    referenceAssetIds: Array.from({ length: 8 }, (_, index) => `ref-${String(index)}`),
    trainingJobId: null,
    adapterRef: null,
    createdAtMs: 1_700_000_000_000,
    updatedAtMs: 1_700_000_000_000,
    rightsConfirmedAtMs: 1_700_000_000_000,
    ...overrides,
  };
}

export interface InMemoryPersonaStore extends PersonaStore {
  readonly rows: Map<string, PersonaRecord>;
}

export function inMemoryPersonaStore(seed: readonly PersonaRecord[] = []): InMemoryPersonaStore {
  const rows = new Map(seed.map((persona) => [persona.id, persona]));
  return {
    rows,
    insert: async (record) => {
      rows.set(record.id, record);
    },
    find: async (personaId) => rows.get(personaId) ?? null,
    update: async (record) => {
      rows.set(record.id, record);
    },
    listByOwner: async (ownerId) =>
      [...rows.values()].filter((persona) => persona.ownerId === ownerId),
    listByStatus: async (status) => [...rows.values()].filter((persona) => persona.status === status),
  };
}

/** Every asset in the set belongs to `ownerId`; everything else belongs to nobody. */
export function personaAssetLookup(
  owned: readonly string[],
  ownerId = OWNER_ID,
): PersonaAssetLookupPort {
  const set = new Set(owned);
  return { ownerOf: async (assetId) => (set.has(assetId) ? ownerId : null) };
}

export interface FakeTrainingPort extends PersonaTrainingPort {
  /** Personas whose `start` was accepted, in order. */
  readonly started: string[];
  readonly deletedAdapters: string[];
  /** The run the engine believes it is doing, or `null`. */
  running: string | null;
  finish(): void;
  report: TrainingStatusReport;
}

/**
 * The engine, as a fake: one run at a time.
 *
 * `start` answers `busy` while a run is live, which is what `/v1/training/start`'s
 * 400 `Training already in progress` means to this layer.
 */
export function fakeTrainingPort(): FakeTrainingPort {
  const port: FakeTrainingPort = {
    started: [],
    deletedAdapters: [],
    running: null,
    report: {
      isTraining: false,
      trainingJobId: null,
      stage: 'training',
      currentStep: null,
      totalSteps: null,
      estimatedSecondsRemaining: null,
      error: null,
    },
    finish: () => {
      port.running = null;
      port.report = { ...port.report, isTraining: false, trainingJobId: null };
    },
    start: async ({ personaId }): Promise<TrainingStartOutcome> => {
      if (port.running !== null) return { kind: 'busy' };
      port.running = personaId;
      port.started.push(personaId);
      port.report = {
        ...port.report,
        isTraining: true,
        trainingJobId: `run-${personaId}`,
        stage: 'training',
        currentStep: 0,
        totalSteps: 100,
      };
      return { kind: 'started', trainingJobId: `run-${personaId}`, totalSteps: 100 };
    },
    status: async () => port.report,
    exportAdapter: async (personaId) => `adapter-${personaId}`,
    deleteAdapter: async (adapterRef) => {
      port.deletedAdapters.push(adapterRef);
    },
  };
  return port;
}
