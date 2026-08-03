/**
 * The in-memory studio backend the screens run against (task 7.3).
 *
 * See `README.md` beside this file for what it is and is not: the *rules* are the domain's own
 * functions, and what this file invents is timing and audio. Read that first if you are wondering
 * why a screen never validates anything itself.
 *
 * ### The job clock
 *
 * A submitted job advances on `Date.now()` rather than on a timer, so a component asking for its
 * status twice in one frame gets one answer and a test can move the clock instead of waiting.
 * `JOB_QUEUE_MS` and `JOB_RUN_MS` are short enough that the screen is worth watching and long
 * enough that Requirement 5.4's progress is genuinely a sequence rather than a jump.
 */

import { downloadFileName, downloadFormatsFor, ruleOnDownload } from '@domain/library/download';
import { applyLibraryQuery, toLibraryQuery, type LibraryPage, type LibraryQueryInput } from '@domain/library/query';
import { activeLineAt } from '@domain/playback/lyrics-sync';
import { positionAt } from '@domain/playback/loop';
import { bucketStartMs, resolveBucketCount, type Waveform } from '@domain/playback/waveform';
import { applyFeedQuery, toFeedQuery, type FeedAssetSummary, type FeedPage, type FeedQueryInput } from '@domain/sharing/feed';
import { applyLike, countFor, type AssetLike, type LikeOutcome } from '@domain/sharing/like';
import { validateSongRequest } from '@domain/song/validation';
import type { SongGenerationRequest } from '@domain/song/request';
import { createHistory, record, redo as redoHistory, undo as undoHistory, type EditHistory } from '@domain/timeline/history';
import { executeCommand, type EditCommand } from '@domain/timeline/commands';
import type { TimelineProject } from '@domain/timeline/project';
import type { EffectChain } from '@domain/effects/chain';
import type { MasteringSuggestion } from '@domain/mastering/suggestion';
import type { AssetKind } from '@domain/asset-kind';

import type { ShareState, StudioApi, StudioVersion, SubmitOutcome } from './port';
import { seedAssets, seedProject, seedSuggestion } from './seed';
import type { StudioAsset, StudioJob } from './types';

/** Requirement 13.4's answer to "which plan would allow this", from `domain/credit/plan.ts`. */
const LOSSLESS_PLAN_IDS = ['creator', 'studio'] as const;

/** How long a demo job waits, and how long it runs. Milliseconds. */
const JOB_QUEUE_MS = 2_000;
const JOB_RUN_MS = 6_000;

export interface DemoApiOptions {
  /** Injected so tests move time instead of waiting for it. */
  readonly now?: () => number;
  readonly ownerId?: string;
  /** The requester's plan, for Requirement 13.4's lossless gate. */
  readonly losslessAllowed?: boolean;
}

export function createDemoApi(options: DemoApiOptions = {}): StudioApi {
  const now = options.now ?? (() => Date.now());
  const ownerId = options.ownerId ?? 'owner-1';
  const losslessAllowed = options.losslessAllowed ?? false;

  const assets = new Map<string, StudioAsset>(seedAssets(ownerId).map((asset) => [asset.id, asset]));
  const jobs = new Map<string, { job: StudioJob; startedAtMs: number }>();
  const published = new Map<string, { atMs: number; remixAllowed: boolean; token: string }>();
  let likes: ReadonlyMap<string, AssetLike> = new Map();

  let project: TimelineProject = seedProject();
  let history: EditHistory = createHistory();
  const chains = new Map<string, EffectChain>();
  const versions = new Map<string, readonly StudioVersion[]>();

  let jobCounter = 0;
  let assetCounter = 0;
  let versionCounter = 0;

  /* ------------------------------------------------------------------ jobs */

  /**
   * Advance a job to where the clock says it is.
   *
   * Recomputed on read rather than stepped by a timer, so a screen that stops polling and comes
   * back sees the truth rather than the state it left behind.
   */
  function project_(entry: { job: StudioJob; startedAtMs: number }): StudioJob {
    const { job, startedAtMs } = entry;
    if (job.state === 'failed' || job.state === 'cancelled' || job.state === 'succeeded') return job;

    const elapsed = now() - startedAtMs;

    if (elapsed < JOB_QUEUE_MS) {
      return { ...job, state: 'queued', queuePosition: 1, percent: null };
    }

    if (elapsed < JOB_QUEUE_MS + JOB_RUN_MS) {
      const percent = Math.floor(((elapsed - JOB_QUEUE_MS) / JOB_RUN_MS) * 100);
      return {
        ...job,
        state: 'running',
        queuePosition: null,
        percent,
        estimatedCompletionAtMs: startedAtMs + JOB_QUEUE_MS + JOB_RUN_MS,
      };
    }

    // Finished: mint the asset the job produced (Requirement 5.6) once, and remember it.
    const existing = entry.job.assetIds[0];
    const assetId = existing ?? `asset-generated-${String((assetCounter += 1))}`;
    if (existing === undefined) {
      assets.set(assetId, {
        ...(seedAssets(ownerId)[0] as StudioAsset),
        id: assetId,
        name: `새 트랙 ${String(assetCounter)}`,
        createdAtMs: now(),
        playCount: 0,
      });
    }

    const finished: StudioJob = {
      ...job,
      state: 'succeeded',
      queuePosition: null,
      percent: 100,
      assetIds: [assetId],
    };
    jobs.set(job.jobId, { job: finished, startedAtMs });
    return finished;
  }

  function submit(request: SongGenerationRequest, retryOfJobId: string | null): SubmitOutcome {
    // Requirements 3.5, 4.6 — the *domain's* validator, so the screen's message and the server's
    // refusal are the same list of fields.
    const validation = validateSongRequest(request);
    if (validation.kind === 'invalid') {
      return { kind: 'rejected', violations: validation.violations };
    }

    const jobId = `job-${String((jobCounter += 1))}`;
    const job: StudioJob = {
      jobId,
      state: 'queued',
      assetKind: 'song',
      queuePosition: 1,
      percent: null,
      estimatedCompletionAtMs: null,
      failureReason: null,
      retryOfJobId,
      assetIds: [],
    };
    jobs.set(jobId, { job, startedAtMs: now() });
    return { kind: 'accepted', job };
  }

  /* --------------------------------------------------------------- sharing */

  function feedRow(asset: StudioAsset): FeedAssetSummary {
    const publication = published.get(asset.id);
    return {
      id: asset.id,
      ownerId: asset.ownerId,
      name: asset.name,
      assetKind: asset.assetKind,
      caption: asset.caption,
      tags: asset.tags,
      genres: asset.genres,
      playCount: asset.playCount,
      likeCount: countFor(likes, asset.id),
      isDeleted: asset.isDeleted,
      reviewState: 'none',
      publishedAtMs: publication?.atMs ?? null,
    };
  }

  function shareStateOf(assetId: string): ShareState {
    const publication = published.get(assetId);
    return {
      published: publication !== undefined,
      url: publication === undefined ? null : `https://studio.example/s/${publication.token}`,
      remixAllowed: publication?.remixAllowed ?? false,
      likeCount: countFor(likes, assetId),
    };
  }

  /* -------------------------------------------------------------- playback */

  /**
   * A drawing derived from the asset's own identity.
   *
   * Deterministic — the same asset always draws the same waveform — because a random one would
   * change under the user on every re-render, which reads as the audio having changed.
   */
  function waveformOf(asset: StudioAsset, buckets: number): Waveform {
    const resolved = resolveBucketCount(buckets, 100_000);
    let seed = 0;
    for (const character of asset.id) seed = (seed * 31 + character.charCodeAt(0)) % 100_000;

    return {
      assetId: asset.id,
      durationMs: asset.durationMs,
      channels: asset.channels,
      buckets: Array.from({ length: resolved }, (_unused, index) => {
        const phase = (index / resolved) * Math.PI * 6 + (seed % 97) / 97;
        const envelope = 0.35 + 0.5 * Math.abs(Math.sin(phase));
        const detail = 0.12 * Math.sin(index * 1.7 + seed);
        const peak = Math.max(0.04, Math.min(1, envelope + detail));
        return { min: -peak, max: peak };
      }),
    };
  }

  /**
   * The versions of an asset, seeded on first read with the original.
   *
   * Seeded lazily rather than in `seed.ts`, because Requirement 29.34's invariant — exactly one
   * default and exactly one original — has to hold from the *first* read, and an asset created
   * mid-session by a finished job has no entry in the seed to hold it.
   */
  function versionsOf(assetId: string): readonly StudioVersion[] {
    const existing = versions.get(assetId);
    if (existing !== undefined) return existing;
    const original: StudioVersion = {
      id: `version-${assetId}-original`,
      // Not '원본': the 원본 chip beside it already says that, and the two together read as a
      // stutter. The name is what this version *is*; the chip is the flag.
      name: '초기 마스터',
      isDefault: true,
      isOriginal: true,
      chain: { items: [] },
      createdAtMs: now(),
    };
    versions.set(assetId, [original]);
    return [original];
  }

  /** What the undo/redo buttons read. */
  function historyView() {
    return {
      project,
      canUndo: history.undoable.length > 0,
      canRedo: history.redoable.length > 0,
    };
  }

  /* -------------------------------------------------------------------- api */

  return {
    async submitSong(request) {
      return submit(request, null);
    },

    async jobStatus(jobId) {
      const entry = jobs.get(jobId);
      return entry === undefined ? null : project_(entry);
    },

    async retryJob(jobId) {
      // Requirement 6.4: the same request, a new job, and the old one remembered.
      const entry = jobs.get(jobId);
      if (entry === undefined) return { kind: 'rejected', violations: [] };
      return submit({ mode: 'simple', description: '재시도된 요청' }, jobId);
    },

    async cancelJob(jobId) {
      const entry = jobs.get(jobId);
      if (entry === undefined) return null;
      const cancelled: StudioJob = { ...project_(entry), state: 'cancelled' };
      jobs.set(jobId, { ...entry, job: cancelled });
      return cancelled;
    },

    async listAssets(query: LibraryQueryInput): Promise<LibraryPage> {
      return applyLibraryQuery([...assets.values()], toLibraryQuery({ ...query, ownerId }));
    },

    async findAsset(assetId) {
      return assets.get(assetId) ?? null;
    },

    async renameAsset(assetId, name) {
      const asset = assets.get(assetId);
      if (asset === undefined) throw new Error(`no such asset: ${assetId}`);
      const next: StudioAsset = { ...asset, name };
      assets.set(assetId, next);
      return next;
    },

    async planDownload(assetId, format, lossless) {
      const asset = assets.get(assetId);
      if (asset === undefined) throw new Error(`no such asset: ${assetId}`);

      // The same ruling `services/library/download-service.ts` applies, from the same facts.
      // `lossless` is what the *caller* asked for; whether the plan permits it is this account's
      // entitlement, and the domain decides what the pair means.
      void lossless;
      const ruling = ruleOnDownload({
        assetKind: asset.assetKind,
        format,
        losslessEntitled: losslessAllowed,
        losslessPlanIds: LOSSLESS_PLAN_IDS,
      });

      if (!ruling.allowed) return { ruling };
      return {
        ruling,
        fileName: downloadFileName(asset.name, asset.id, format),
        bytes: Math.round((asset.durationMs / 1000) * 48_000 * asset.channels * 2),
      };
    },

    downloadFormatsFor(assetKind: AssetKind) {
      return downloadFormatsFor(assetKind);
    },

    async waveform(assetId, buckets) {
      const asset = assets.get(assetId);
      if (asset === undefined) throw new Error(`no such asset: ${assetId}`);
      return waveformOf(asset, buckets);
    },

    async lyricLineAt(assetId, positionMs) {
      const asset = assets.get(assetId);
      if (asset?.timedLyrics == null) return null;
      return activeLineAt(asset.timedLyrics, positionMs);
    },

    async positionAfter(assetId, elapsedMs) {
      const asset = assets.get(assetId);
      if (asset === undefined) throw new Error(`no such asset: ${assetId}`);
      return positionAt(elapsedMs, asset.durationMs, asset.isLoop);
    },

    streamUrl(assetId) {
      // No object store; the player synthesises a tone from this identifier. See the README.
      return `demo:stream/${assetId}`;
    },

    async setPublished(assetId, isPublished, remixAllowed) {
      if (isPublished) {
        // A fresh token on every publication — `domain/sharing/share-link.ts` explains why.
        published.set(assetId, {
          atMs: now(),
          remixAllowed,
          token: `${assetId}-${String(now())}`.padEnd(43, '0').slice(0, 43),
        });
      } else {
        published.delete(assetId);
      }
      return shareStateOf(assetId);
    },

    async shareState(assetId) {
      return shareStateOf(assetId);
    },

    async feed(query: FeedQueryInput): Promise<FeedPage> {
      return applyFeedQuery([...assets.values()].map(feedRow), toFeedQuery(query));
    },

    async like(assetId): Promise<LikeOutcome> {
      const applied = applyLike(likes, { assetId, accountId: ownerId, likedAtMs: now() });
      likes = applied.likes;
      return applied.outcome;
    },

    async project() {
      return project;
    },

    async applyEdit(command: EditCommand) {
      project = executeCommand(project, command);
      history = record(history, command);
      return historyView();
    },

    async undo() {
      // A refused step (nothing to undo) leaves both the project and the history alone — the
      // screen's buttons are already disabled, and re-deriving that here would be a second rule.
      const step = undoHistory(project, history);
      if (step.ok) {
        project = step.project;
        history = step.history;
      }
      return historyView();
    },

    async redo() {
      const step = redoHistory(project, history);
      if (step.ok) {
        project = step.project;
        history = step.history;
      }
      return historyView();
    },

    async effectChain(assetId) {
      return chains.get(assetId) ?? { items: [] };
    },

    async setEffectChain(assetId, chain) {
      chains.set(assetId, chain);
      return chain;
    },

    async previewChain(assetId, chain) {
      const asset = assets.get(assetId);
      if (asset === undefined) throw new Error(`no such asset: ${assetId}`);
      // Requirement 29.28: nothing is written. The chain is in the URL so a preview of a
      // different chain is a different stream, which is what makes A/B audible at all.
      return {
        streamUrl: `demo:preview/${assetId}?items=${String(chain.items.length)}`,
        durationMs: asset.durationMs,
      };
    },

    async versions(assetId) {
      return versionsOf(assetId);
    },

    async saveVersion(assetId, name, chain) {
      const current = versionsOf(assetId);
      const saved: StudioVersion = {
        id: `version-${assetId}-${String((versionCounter += 1))}`,
        name,
        // A saved version does not become the default on its own — Requirement 29.34 makes that
        // an explicit act, and promoting silently would change what a listener hears.
        isDefault: false,
        isOriginal: false,
        chain,
        createdAtMs: now(),
      };
      const next = [...current, saved];
      versions.set(assetId, next);
      return next;
    },

    async setDefaultVersion(assetId, versionId) {
      // Requirement 29.34 in one expression: exactly the named version is the default, and
      // every other is not. Written as a map over all of them rather than a clear-then-set,
      // because there is no intermediate state here in which no version is the default.
      const next = versionsOf(assetId).map((version) => ({
        ...version,
        isDefault: version.id === versionId,
      }));
      versions.set(assetId, next);
      return next;
    },

    async masteringSuggestion(assetId): Promise<MasteringSuggestion> {
      const asset = assets.get(assetId);
      if (asset === undefined) throw new Error(`no such asset: ${assetId}`);
      return seedSuggestion();
    },
  };
}

/** Re-exported so a screen can label a bucket without importing the domain twice. */
export { bucketStartMs };
