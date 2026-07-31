/**
 * Generators and in-memory ports for the timeline suites (Requirement 28, design §6.4, §7.1).
 *
 * ### The generator constructs valid projects; it does not filter for them
 *
 * A `Timeline_Project` is only *valid* when no two clips on the same track overlap
 * (Requirement 28.7), every clip's trims leave at least a millisecond (28.10), every fade is
 * within half the play length (28.17), and the whole thing is under the 500-clip ceiling (28.5).
 * An `fc.record` over arbitrary field values satisfies that essentially never — with four clips
 * on four tracks the chance of a non-overlapping layout is already small, and it falls off a
 * cliff from there.
 *
 * So `validProject` **lays the clips out** rather than proposing and rejecting: per track it walks
 * a cursor forward by a generated gap and the clip's own play length, which makes non-overlap a
 * property of the construction. Everything a real project varies is still varied — the number of
 * clips, which tracks they land on, their source durations, trims, gains, fades, mute flags, the
 * project's tempo and signature, and the *order of the clip list*, which Requirement 28.32 makes
 * part of the equivalence relation. This is the discipline `test/property/cue-pack-manifest.test.ts`
 * uses, applied to a structure whose validity is relational rather than per-entry.
 *
 * Projects are kept **small** — at most 6 clips over at most 4 tracks. Requirement 28.5's ceiling
 * of 500 is a bound to hit with a targeted example, not with 100 random draws: a 500-clip project
 * costs 124 750 pairwise overlap comparisons per validation, and the properties below validate
 * several times per run. See `test/unit/timeline/limits.test.ts` for the ceiling itself.
 *
 * ### Numeric values move in the steps the schema stores
 *
 * Gain and track volume are generated on a 0.1 dB grid and pan on a 0.01 grid, matching
 * `numeric(4,1)` and `numeric(3,2)` in `db/migrations/0015_timeline_project.sql` — and matching
 * Requirement 28.32's comparison tolerances, which are what those column types were chosen for.
 * A generator producing values the schema could not store would be testing a state the product
 * cannot reach.
 */

import fc from 'fast-check';

import {
  CLIP_GAIN_DB_MAX,
  CLIP_GAIN_DB_MIN,
  TEMPO_BPM_MAX,
  TEMPO_BPM_MIN,
  TIME_SIGNATURES,
  TRACK_PAN_MAX,
  TRACK_PAN_MIN,
  TRACK_VOLUME_DB_MAX,
  TRACK_VOLUME_DB_MIN,
  fadeCeilingMs,
} from '../../domain/timeline/bounds';
import { NO_ATTRIBUTION_REQUIRED, type AssetProvenance } from '../../domain/provenance';
import { createHistory } from '../../domain/timeline/history';
import {
  defaultTrackSettings,
  type TimelineClip,
  type TimelineProject,
  type TrackSettings,
} from '../../domain/timeline/project';
import type {
  MixdownAssetStore,
  MixdownRenderPort,
  MixdownRenderRequest,
  MixdownRenderResult,
  StoredMix,
} from '../../services/timeline/mixdown-ports';
import type {
  TimelineAssetCatalogue,
  TimelineAssetState,
  TimelineProjectStore,
  TimelineProjectRecord,
} from '../../services/timeline/ports';

/** At most this many clips per generated project. See the header on why it is small. */
export const GENERATED_CLIP_MAX = 6;
/** At most this many distinct tracks, so collisions are actually possible to lay out around. */
export const GENERATED_TRACK_MAX = 4;

/** Decibels on the 0.1 dB grid `numeric(4,1)` stores. */
function decibels(min: number, max: number): fc.Arbitrary<number> {
  return fc.integer({ min: Math.round(min * 10), max: Math.round(max * 10) }).map((v) => v / 10);
}

/** Pan on the 0.01 grid `numeric(3,2)` stores. */
function panArbitrary(): fc.Arbitrary<number> {
  return fc
    .integer({ min: Math.round(TRACK_PAN_MIN * 100), max: Math.round(TRACK_PAN_MAX * 100) })
    .map((v) => v / 100);
}

export function clipGainArbitrary(): fc.Arbitrary<number> {
  return decibels(CLIP_GAIN_DB_MIN, CLIP_GAIN_DB_MAX);
}

export function trackVolumeArbitrary(): fc.Arbitrary<number> {
  return decibels(TRACK_VOLUME_DB_MIN, TRACK_VOLUME_DB_MAX);
}

export function trackPanArbitrary(): fc.Arbitrary<number> {
  return panArbitrary();
}

export function trackSettingsArbitrary(): fc.Arbitrary<TrackSettings> {
  return fc.record({
    volumeDb: trackVolumeArbitrary(),
    pan: trackPanArbitrary(),
    muted: fc.boolean(),
    solo: fc.boolean(),
  });
}

/** What a clip needs before it is placed. The placement is the generator's job, not this. */
interface ClipSpec {
  readonly track: number;
  readonly sourceDurationMs: number;
  readonly trimStartMs: number;
  readonly trimEndMs: number;
  readonly gapMs: number;
  readonly gainDb: number;
  readonly fadeInRatio: number;
  readonly fadeOutRatio: number;
  readonly muted: boolean;
}

function clipSpecArbitrary(): fc.Arbitrary<ClipSpec> {
  return fc
    .record({
      track: fc.integer({ min: 0, max: GENERATED_TRACK_MAX - 1 }),
      sourceDurationMs: fc.integer({ min: 40, max: 30_000 }),
      // Trims as a fraction of the source, so the "trims leave at least 1 ms" rule of
      // Requirement 28.10 holds by construction rather than by rejection.
      trimStartRatio: fc.double({ min: 0, max: 0.4, noNaN: true, noDefaultInfinity: true }),
      trimEndRatio: fc.double({ min: 0, max: 0.4, noNaN: true, noDefaultInfinity: true }),
      gapMs: fc.integer({ min: 0, max: 4_000 }),
      gainDb: clipGainArbitrary(),
      // Requirement 28.17's ceiling is 50 %, so the ratio never exceeds it.
      fadeInRatio: fc.double({ min: 0, max: 0.5, noNaN: true, noDefaultInfinity: true }),
      fadeOutRatio: fc.double({ min: 0, max: 0.5, noNaN: true, noDefaultInfinity: true }),
      muted: fc.boolean(),
    })
    .map((spec) => {
      const trimStartMs = Math.floor(spec.sourceDurationMs * spec.trimStartRatio);
      const trimEndMs = Math.floor(spec.sourceDurationMs * spec.trimEndRatio);
      return {
        track: spec.track,
        sourceDurationMs: spec.sourceDurationMs,
        trimStartMs,
        trimEndMs,
        gapMs: spec.gapMs,
        gainDb: spec.gainDb,
        fadeInRatio: spec.fadeInRatio,
        fadeOutRatio: spec.fadeOutRatio,
        muted: spec.muted,
      };
    });
}

/**
 * Place the specs on their tracks, left to right, so no two on a track overlap.
 *
 * The clip list keeps the *generation* order rather than being grouped by track, so the order
 * Requirement 28.32 compares is genuinely varied and interleaved across tracks.
 */
function placeClips(specs: readonly ClipSpec[], assetIds: readonly string[]): TimelineClip[] {
  const cursorByTrack = new Map<number, number>();
  const clips: TimelineClip[] = [];

  for (const [index, spec] of specs.entries()) {
    const playLengthMs = spec.sourceDurationMs - spec.trimStartMs - spec.trimEndMs;
    if (playLengthMs < 1) continue;

    const cursor = cursorByTrack.get(spec.track) ?? 0;
    const startTimeMs = cursor + spec.gapMs;
    cursorByTrack.set(spec.track, startTimeMs + playLengthMs);

    const ceiling = fadeCeilingMs(playLengthMs);
    clips.push({
      id: `clip-${String(index)}`,
      assetId: assetIds[index % assetIds.length] ?? 'asset-0',
      sourceDurationMs: spec.sourceDurationMs,
      startTimeMs,
      track: spec.track,
      trimStartMs: spec.trimStartMs,
      trimEndMs: spec.trimEndMs,
      gainDb: spec.gainDb,
      fadeInMs: Math.min(Math.floor(playLengthMs * spec.fadeInRatio), ceiling),
      fadeOutMs: Math.min(Math.floor(playLengthMs * spec.fadeOutRatio), ceiling),
      muted: spec.muted,
    });
  }

  return clips;
}

export interface ValidProjectOptions {
  readonly minClips?: number;
  readonly maxClips?: number;
  /** Force a tempo and signature, for the bar-boundary snap cases. */
  readonly requireTempo?: boolean;
}

/** A valid `Timeline_Project`. See the header on why it is built rather than filtered. */
export function validProject(options: ValidProjectOptions = {}): fc.Arbitrary<TimelineProject> {
  const tempo = options.requireTempo === true
    ? fc.integer({ min: TEMPO_BPM_MIN, max: TEMPO_BPM_MAX })
    : fc.option(fc.integer({ min: TEMPO_BPM_MIN, max: TEMPO_BPM_MAX }), { nil: null });
  const signature = options.requireTempo === true
    ? fc.constantFrom(...TIME_SIGNATURES)
    : fc.option(fc.constantFrom(...TIME_SIGNATURES), { nil: null });

  return fc
    .record({
      name: fc.string({ minLength: 1, maxLength: 60 }),
      description: fc.string({ maxLength: 120 }),
      tempoBpm: tempo,
      timeSignature: signature,
      specs: fc.array(clipSpecArbitrary(), {
        minLength: options.minClips ?? 0,
        maxLength: options.maxClips ?? GENERATED_CLIP_MAX,
      }),
      tracks: fc.array(trackSettingsArbitrary(), { minLength: 32, maxLength: 32 }),
    })
    .map((seed) => ({
      id: 'project-0',
      ownerId: 'owner-0',
      name: seed.name,
      description: seed.description,
      tempoBpm: seed.tempoBpm,
      timeSignature: seed.timeSignature,
      clips: placeClips(seed.specs, ASSET_IDS),
      tracks: seed.tracks,
    }));
}

/** The asset ids generated clips reference, and the catalogue that resolves them. */
export const ASSET_IDS = ['asset-0', 'asset-1', 'asset-2'] as const;

/**
 * A catalogue that agrees with whatever duration a clip claims.
 *
 * The generated projects vary source durations per clip while reusing three asset ids, which no
 * real library would do. That is fine for every property here — none of them consults the
 * catalogue — and this catalogue exists for the service tests, which supply their own durations.
 */
export function fixedAssetCatalogue(
  assets: readonly TimelineAssetState[],
): TimelineAssetCatalogue {
  const byId = new Map(assets.map((asset) => [asset.assetId, asset]));
  return {
    lookup: (assetId) => Promise.resolve(byId.get(assetId) ?? null),
  };
}

export function assetState(
  assetId: string,
  durationMs: number,
  overrides: Partial<TimelineAssetState> = {},
): TimelineAssetState {
  return { assetId, ownerId: 'owner-0', durationMs, isDeleted: false, ...overrides };
}

/**
 * An in-memory `TimelineProjectStore`.
 *
 * No PostgreSQL is reachable here, so every service test runs against this. Records are stored
 * as handed over — they are already immutable values — and `listByOwner` returns insertion order,
 * which is the only order the port promises.
 */
export function inMemoryTimelineStore(): TimelineProjectStore & {
  readonly size: () => number;
} {
  const records = new Map<string, TimelineProjectRecord>();

  return {
    insert: (record) => {
      records.set(record.project.id, record);
      return Promise.resolve();
    },
    load: (projectId) => Promise.resolve(records.get(projectId) ?? null),
    update: (record) => {
      records.set(record.project.id, record);
      return Promise.resolve();
    },
    remove: (projectId) => {
      records.delete(projectId);
      return Promise.resolve();
    },
    listByOwner: (ownerId) =>
      Promise.resolve([...records.values()].filter((r) => r.project.ownerId === ownerId)),
    size: () => records.size,
  };
}

/** A record wrapping a project, for tests that need one without going through the service. */
export function recordOf(project: TimelineProject, atMs = 1_000): TimelineProjectRecord {
  return { project, history: createHistory(), createdAtMs: atMs, updatedAtMs: atMs };
}

/** A project with `count` untouched tracks and the given clips. */
export function projectWith(clips: readonly TimelineClip[]): TimelineProject {
  return {
    id: 'project-0',
    ownerId: 'owner-0',
    name: 'Scene 1',
    description: '',
    tempoBpm: null,
    timeSignature: null,
    clips,
    tracks: Array.from({ length: 32 }, () => defaultTrackSettings()),
  };
}

/** A clip with sensible defaults, for example-based tests. */
export function clip(overrides: Partial<TimelineClip> = {}): TimelineClip {
  return {
    id: 'clip-a',
    assetId: 'asset-0',
    sourceDurationMs: 10_000,
    startTimeMs: 0,
    track: 0,
    trimStartMs: 0,
    trimEndMs: 0,
    gainDb: 0,
    fadeInMs: 0,
    fadeOutMs: 0,
    muted: false,
    ...overrides,
  };
}


/* ------------------------------------------------ Mixdown_Renderer (28.24–28.29) */

/**
 * A stub `MixdownRenderPort`, and it is a stub on purpose.
 *
 * The audio half of Requirements 28.24–28.28 — the samples, the summation order's effect on
 * them, the attenuation coefficient's application — is rendered in
 * `dsp/src/musicstudio_dsp/mixdown.py` and asserted there, as design §10's Properties 12 and
 * 13 (`dsp/test/test_mixdown.py`). No buffer ever crosses this seam, so a fake that mixed
 * real audio in TypeScript would be a *second renderer*, and the two would drift.
 *
 * What the stub is for is the half that cannot be tested from Python: that an empty target set
 * is refused **before** the port is called at all (Requirement 28.29), that the clips arrive in
 * summation order (28.26), and that a result breaching a stated invariant is reported rather
 * than stored. The default result is derived from the request — the length from
 * `expectedLengthMs`, the order from the clips as sent — so a test that wants to breach an
 * invariant has to say so explicitly through `overrides`.
 */
export function stubMixdownRenderPort(overrides: Partial<MixdownRenderResult> = {}): {
  readonly port: MixdownRenderPort;
  readonly requests: MixdownRenderRequest[];
} {
  const requests: MixdownRenderRequest[] = [];
  return {
    requests,
    port: {
      render: (request) => {
        requests.push(request);
        const frameCount = Math.round(
          (request.expectedLengthMs * request.params.sampleRate) / 1000,
        );
        return Promise.resolve({
          objectKey: `mixes/${request.projectId}.flac`,
          sampleRate: request.params.sampleRate,
          channels: request.params.channels,
          frameCount,
          durationMs: request.expectedLengthMs,
          renderedClipIds: request.clips.map((clip) => clip.clipId),
          peakBefore: 0.5,
          peakAfter: 0.5,
          attenuationDb: 0,
          normalised: false,
          ...overrides,
        });
      },
    },
  };
}

/** A `MixdownAssetStore` that records what it was asked to save. */
export function recordingMixAssetStore(): MixdownAssetStore & {
  readonly saved: StoredMix[];
} {
  const saved: StoredMix[] = [];
  return {
    saved,
    save: (mix) => {
      saved.push(mix);
      return Promise.resolve();
    },
  };
}

/**
 * Provenance for a rendered mix.
 *
 * Supplied by the caller rather than invented by the renderer, because Requirement 33.20's
 * fold over input assets and engines is task 6.3's (Property 18). See
 * `services/timeline/mixdown-renderer.ts`.
 */
export function mixProvenance(overrides: Partial<AssetProvenance> = {}): AssetProvenance {
  return {
    engineId: 'musicstudio-mixdown',
    weightLicenseId: 'not-applicable',
    attributionText: NO_ATTRIBUTION_REQUIRED,
    commercialUseAllowed: true,
    nonCommercialLicenseListVersion: 1,
    recordedAtMs: 1_000,
    aiGenerated: true,
    ...overrides,
  };
}
