/**
 * The demo backend's starting data.
 *
 * Separate from `demo-api.ts` so the behaviour and the fixtures are not read as one thing: the
 * former is the rules, this is what happens to be in the library on first load. A real deployment
 * deletes this file and nothing else changes.
 *
 * The assets differ from each other on purpose — kind, tags, genres, play count, lyrics, loop — so
 * that a screen's filter, sort and empty state are all reachable by clicking rather than only by a
 * test.
 */

import { TRACK_COUNT, TRACK_PAN_DEFAULT, TRACK_VOLUME_DB_DEFAULT } from '@domain/timeline/bounds';
import type { TimelineProject, TrackSettings } from '@domain/timeline/project';
import type { MasteringSuggestion } from '@domain/mastering/suggestion';

import type { StudioAsset } from './types';

const HOUR = 3_600_000;
const BASE = Date.UTC(2026, 7, 3, 9, 0, 0);

export function seedAssets(ownerId: string): readonly StudioAsset[] {
  return [
    {
      id: 'asset-night-drive',
      ownerId,
      name: 'Night Drive',
      assetKind: 'song',
      caption: '늦은 밤 도심을 달리는 로파이 트랙',
      lyrics: '늦은 밤 도심을 달려\n신호등이 하나씩 꺼져가',
      tags: ['lo-fi', 'chill'],
      genres: ['lo-fi', 'downtempo'],
      playCount: 128,
      createdAtMs: BASE - HOUR,
      isDeleted: false,
      durationMs: 184_000,
      sampleRate: 48_000,
      channels: 2,
      isLoop: false,
      timedLyrics: {
        lines: [
          { startMs: 400, text: '늦은 밤 도심을 달려' },
          { startMs: 4_200, text: '신호등이 하나씩 꺼져가' },
          { startMs: 9_100, text: '창문을 조금 열어둔 채로' },
          { startMs: 13_800, text: '아무 말도 하지 않았어' },
        ],
      },
      aiGenerated: true,
    },
    {
      id: 'asset-rain-window',
      ownerId,
      name: 'Rain Window',
      assetKind: 'bgm',
      caption: '창밖 빗소리 위에 얹은 앰비언트 루프',
      lyrics: '',
      tags: ['ambient', 'rain'],
      genres: ['ambient'],
      playCount: 46,
      createdAtMs: BASE - 2 * HOUR,
      isDeleted: false,
      durationMs: 32_000,
      sampleRate: 48_000,
      channels: 2,
      isLoop: true,
      timedLyrics: null,
      aiGenerated: true,
    },
    {
      id: 'asset-neon-rush',
      ownerId,
      name: 'Neon Rush',
      assetKind: 'sfx',
      caption: '네온 간판이 켜지는 짧은 효과음',
      lyrics: '',
      tags: ['ui', 'whoosh'],
      genres: [],
      playCount: 12,
      createdAtMs: BASE - 30 * 60_000,
      isDeleted: false,
      durationMs: 1_400,
      sampleRate: 48_000,
      channels: 1,
      isLoop: false,
      timedLyrics: null,
      aiGenerated: true,
    },
    {
      id: 'asset-narration',
      ownerId,
      name: '오프닝 내레이션',
      assetKind: 'dialogue',
      caption: '차분한 남성 화자, 도입부 안내',
      lyrics: '',
      tags: ['voice'],
      genres: [],
      playCount: 3,
      createdAtMs: BASE - 15 * 60_000,
      isDeleted: false,
      durationMs: 8_600,
      sampleRate: 48_000,
      channels: 1,
      isLoop: false,
      timedLyrics: {
        lines: [
          { startMs: 200, text: '어느 밤의 이야기입니다.' },
          { startMs: 3_400, text: '조금만 더 가까이 오세요.' },
        ],
      },
      aiGenerated: true,
    },
  ];
}

const DEFAULT_TRACK: TrackSettings = {
  volumeDb: TRACK_VOLUME_DB_DEFAULT,
  pan: TRACK_PAN_DEFAULT,
  muted: false,
  solo: false,
};

/**
 * A two-track arrangement with three clips, so trim, split and move all have something to act on.
 *
 * **Both trims are amounts removed** — `clipPlayLengthMs` is `sourceDurationMs - trimStartMs -
 * trimEndMs`, not `trimEndMs - trimStartMs`. The first draft of this fixture read `trimEndMs` as
 * an absolute end position and gave two of the three clips a play length of zero, which
 * `projectViolations` rejects outright. `test/pages/seed.test.ts` now asserts the fixture is a
 * valid project, so the same misreading cannot come back silently.
 *
 * Clip 3 sits on track 0 *after* clip 1 rather than beside it, which is what makes the overlap
 * refusal of Requirement 28.8 reachable by dragging clip 1 to the right.
 */
export function seedProject(): TimelineProject {
  return {
    id: 'project-1',
    ownerId: 'owner-1',
    name: '데모 프로젝트',
    description: '타임라인 편집 데모',
    tempoBpm: 92,
    timeSignature: 4,
    tracks: Array.from({ length: TRACK_COUNT }, () => DEFAULT_TRACK),
    clips: [
      {
        id: 'clip-1',
        assetId: 'asset-night-drive',
        sourceDurationMs: 184_000,
        startTimeMs: 0,
        track: 0,
        trimStartMs: 0,
        // 160 s off the tail: a 24 s excerpt of a 184 s track.
        trimEndMs: 160_000,
        gainDb: 0,
        fadeInMs: 400,
        fadeOutMs: 800,
        muted: false,
        effectChain: null,
      },
      {
        id: 'clip-2',
        assetId: 'asset-rain-window',
        sourceDurationMs: 32_000,
        startTimeMs: 4_000,
        track: 1,
        trimStartMs: 0,
        trimEndMs: 4_000,
        gainDb: -6,
        fadeInMs: 1_000,
        fadeOutMs: 1_000,
        muted: false,
        effectChain: null,
      },
      {
        id: 'clip-3',
        assetId: 'asset-neon-rush',
        sourceDurationMs: 1_400,
        startTimeMs: 30_000,
        track: 0,
        trimStartMs: 0,
        // A 1.4 s stinger, used whole.
        trimEndMs: 0,
        gainDb: 2,
        fadeInMs: 0,
        fadeOutMs: 0,
        muted: false,
        effectChain: null,
      },
    ],
  };
}

/**
 * A mastering suggestion (Requirements 30.1, 30.3, 30.4, 30.22).
 *
 * The measurement is the *reason* for the chain, and the numbers agree with it: a track measured
 * at −18.2 LUFS wants gain to reach −14, and a true peak of −0.4 dBTP wants a limiter. A fixture
 * whose chain did not follow from its measurement would make the A/B screen a decoration.
 */
export function seedSuggestion(): MasteringSuggestion {
  return {
    chain: {
      items: [
        // Every kind and parameter name is one `domain/effects/registry.ts` declares — a
        // suggestion naming an effect the product does not have would be unappliable.
        { kind: 'highpass', parameters: { cutoff_frequency_hz: 32 } },
        { kind: 'compressor', parameters: { threshold_db: -18, ratio: 2.5, attack_ms: 20, release_ms: 180 } },
        { kind: 'gain', parameters: { gain_db: 3.4 } },
      ],
    },
    source: 'model',
    engineId: 'deepafx-st',
    commercialUseAllowed: false,
    measurement: {
      integratedLoudnessLufs: -18.2,
      truePeakDbtp: -0.4,
      octaveBands: [
        { centreHz: 31.5, energyDb: -32.1 },
        { centreHz: 63, energyDb: -24.6 },
        { centreHz: 125, energyDb: -19.8 },
        { centreHz: 250, energyDb: -17.2 },
        { centreHz: 500, energyDb: -16.4 },
        { centreHz: 1_000, energyDb: -17.9 },
        { centreHz: 2_000, energyDb: -20.3 },
        { centreHz: 4_000, energyDb: -23.7 },
        { centreHz: 8_000, energyDb: -28.4 },
        { centreHz: 16_000, energyDb: -35.2 },
      ],
    },
  };
}
