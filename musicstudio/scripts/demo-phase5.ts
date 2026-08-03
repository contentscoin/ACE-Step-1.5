/**
 * Phase 5 + Transcription_Adapter, running.
 *
 * There is no UI yet — Phase 7 owns the frontend and Phase 7/9 own the HTTP routes — so this is
 * what "working" looks like today: the **production services**, composed exactly as an API route
 * would compose them, driven through one user's story and printing what each step actually
 * returned.
 *
 * Only the edges are doubles: the stores, the object store and the ASR server. Every rule —
 * the listing query, the range planner, the visibility predicate, the like set, the persona
 * queue, the transcription normalisation — is the real implementation.
 *
 *     npx tsx scripts/demo-phase5.ts
 */

import { createLibraryService } from '../services/library/library-service';
import { createPlaybackService } from '../services/playback/playback-service';
import { createSharingService } from '../services/sharing/sharing-service';
import { createPersonaService } from '../services/persona/persona-service';
import { TranscriptionService } from '../services/transcription/transcription-service';
import { playbackVisibilityPort } from '../services/sharing/visibility-adapters';
import { createWhisperTranscriptionAdapter, WHISPER_TRANSCRIPTION_TIERS } from '../adapters/transcription';

import {
  assetRecord,
  inMemoryAssetStore,
  inMemoryPlaylistStore,
} from '../test/support/library-harness';
import {
  countingBytes,
  drain,
  inMemoryObjectStore,
  inMemoryPlaybackAssetStore,
  inMemoryWaveforms,
  playbackAsset,
} from '../test/support/playback-harness';
import {
  fakeTrainingPort,
  inMemoryLikeStore,
  inMemoryPersonaStore,
  inMemoryShareStore,
  inMemorySoundPackShareStore,
  personaAssetLookup,
  shareableAsset,
} from '../test/support/sharing-harness';
import {
  createInMemoryTranscriptionStore,
  createScriptedTranscriptionProbe,
} from '../test/support/speech-harness';
import { deterministicWhisperTransport } from '../test/support/deterministic-whisper-transport';
import { createMutableClock } from '../test/support/mutable-clock';

/* ------------------------------------------------------------------ printing */

const BOLD = '[1m';
const DIM = '[2m';
const GREEN = '[32m';
const RED = '[31m';
const CYAN = '[36m';
const YELLOW = '[33m';
const OFF = '[0m';

function heading(text: string): void {
  console.log(`\n${BOLD}${CYAN}${'━'.repeat(78)}${OFF}`);
  console.log(`${BOLD}${CYAN}  ${text}${OFF}`);
  console.log(`${BOLD}${CYAN}${'━'.repeat(78)}${OFF}`);
}

function step(text: string): void {
  console.log(`\n${BOLD}▸ ${text}${OFF}`);
}

function ok(text: string): void {
  console.log(`  ${GREEN}✓${OFF} ${text}`);
}

function refused(text: string): void {
  console.log(`  ${RED}✗${OFF} ${text}`);
}

function note(text: string): void {
  console.log(`  ${DIM}${text}${OFF}`);
}

function show(label: string, value: unknown): void {
  console.log(`  ${DIM}${label}${OFF} ${YELLOW}${JSON.stringify(value)}${OFF}`);
}

/** Run something that is supposed to be refused, and print the refusal. */
async function expectRefusal(label: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
    refused(`${label} — 거부되지 않았다 (버그)`);
  } catch (error: unknown) {
    const failure = error as { statusCode?: number; code?: string };
    refused(`${label} → ${String(failure.statusCode)} ${String(failure.code)}`);
  }
}

/* --------------------------------------------------------------- composition */

const NOW = Date.UTC(2026, 7, 3, 9, 0, 0);
const OWNER = 'owner-1';
const STRANGER = 'owner-2';
const ASSET = 'asset-a';
const OBJECT_BYTES = 1_000;

const clock = createMutableClock(new Date(NOW));

// --- Library (5.1)
const libraryAssets = inMemoryAssetStore([
  assetRecord({
    id: ASSET,
    name: 'Night Drive',
    caption: '늦은 밤 도심을 달리는 로파이 루프',
    tags: ['lo-fi', 'chill'],
    playCount: 0,
    createdAtMs: NOW - 3_600_000,
  }),
  assetRecord({ id: 'asset-b', name: 'Rain Window', tags: ['ambient'], createdAtMs: NOW - 7_200_000 }),
  assetRecord({ id: 'asset-c', name: 'Neon Rush', assetKind: 'sfx', createdAtMs: NOW - 1_800_000 }),
]);
const audited: string[] = [];
const library = createLibraryService({
  assets: libraryAssets,
  playlists: inMemoryPlaylistStore(),
  clock,
  audit: {
    record: async (event) => {
      audited.push(`${event.eventType}(${event.targetId})`);
    },
  },
});

// --- Sharing (5.3)
const shareAssets = inMemoryShareStore([
  shareableAsset({
    id: ASSET,
    name: 'Night Drive',
    caption: '늦은 밤 도심을 달리는 로파이 루프',
    tags: ['lo-fi', 'chill'],
    genres: ['lo-fi', 'downtempo'],
    isLoop: true,
    durationMs: 4_000,
  }),
  shareableAsset({ id: 'asset-b', name: 'Rain Window', genres: ['ambient'] }),
]);
const likes = inMemoryLikeStore();
const sharing = createSharingService({
  assets: shareAssets,
  likes,
  soundPacks: inMemorySoundPackShareStore([
    {
      soundPackId: 'pack-1',
      ownerId: OWNER,
      name: 'Soft UI',
      cueCount: 78,
      token: null,
      publishedAtMs: null,
      remixAllowed: false,
    },
  ]),
  clock,
  publicBaseUrl: 'https://studio.example',
  audit: {
    record: async (event) => {
      audited.push(`${event.eventType}(${event.targetId})`);
    },
  },
  disclosure: { obligationsFor: () => ['ai_generated_label'], apply: async () => undefined },
});

// --- Playback (5.2), gated by the *sharing* service's own visibility answer
const playbackAssets = inMemoryPlaybackAssetStore([
  playbackAsset({ id: ASSET, durationMs: 4_000, isLoop: true, frameCount: 192_000 }),
]);
const objects = inMemoryObjectStore([
  { objectKey: 'audio/asset-a', bytes: countingBytes(OBJECT_BYTES) },
]);
const playback = createPlaybackService({
  assets: playbackAssets,
  visibility: playbackVisibilityPort(sharing),
  objects,
  waveforms: inMemoryWaveforms(objects),
});

// --- Persona (5.3)
const REFERENCES = Array.from({ length: 8 }, (_unused, index) => `ref-${String(index)}`);
const training = fakeTrainingPort();
let personaSequence = 0;
const personas = createPersonaService({
  personas: inMemoryPersonaStore(),
  training,
  assets: personaAssetLookup(REFERENCES, OWNER),
  clock,
  generateId: () => `persona-${String((personaSequence += 1))}`,
});

// --- Transcription (2.7's adapter)
const whisper = deterministicWhisperTransport();
const transcriptionProbe = createScriptedTranscriptionProbe();
const transcription = new TranscriptionService({
  probe: transcriptionProbe,
  engine: createWhisperTranscriptionAdapter({
    transport: whisper,
    objectKeyOf: (audioId) => `audio/${audioId}.flac`,
  }),
  store: createInMemoryTranscriptionStore(),
  clock,
  tiers: WHISPER_TRANSCRIPTION_TIERS,
});

/* --------------------------------------------------------------------- story */

async function main(): Promise<void> {
  console.log(`${BOLD}MusicStudio — Phase 5 + Transcription_Adapter${OFF}`);
  note('UI·HTTP 라우트는 Phase 7/9. 아래는 서비스 계층을 그대로 조립해 실행한 결과.');

  /* ---------------------------------------------------------- 5.1 라이브러리 */
  heading('5.1  Library_Service — 목록 · 검색 · 정렬 · 커서');

  step('내 라이브러리 (기본: 생성 시각 내림차순)');
  const page = await library.list({ ownerId: OWNER });
  for (const asset of page.assets) {
    ok(`${asset.name.padEnd(14)} ${DIM}${asset.assetKind}  tags=[${asset.tags.join(', ')}]${OFF}`);
  }

  step('검색 — 캡션 본문까지 훑는다 (Req 11.3)');
  const found = await library.list({ ownerId: OWNER, search: '로파이' });
  ok(`"로파이" → ${found.assets.map((asset) => asset.name).join(', ')}`);

  step('종류 필터 (Req 11.12) · 페이지 커서 (Req 11.2)');
  const sfxOnly = await library.list({ ownerId: OWNER, assetKind: 'sfx' });
  ok(`assetKind=sfx → ${sfxOnly.assets.map((asset) => asset.name).join(', ')}`);
  const firstPage = await library.list({ ownerId: OWNER, pageSize: 2 });
  show('nextCursor', firstPage.nextCursor);
  const secondPage = await library.list({ ownerId: OWNER, pageSize: 2, cursor: firstPage.nextCursor });
  ok(`1페이지 ${firstPage.assets.length}건 → 2페이지 ${secondPage.assets.map((a) => a.name).join(', ')}`);

  step('남의 자산 이름 변경 (Req 11.9 — 403을 조항이 지정한다)');
  await expectRefusal('stranger가 Night Drive 이름 변경', () =>
    library.rename(STRANGER, ASSET, 'Stolen'),
  );

  /* -------------------------------------------------------------- 5.3 공개 */
  heading('5.3  Sharing_Service — 공개는 컬럼이 아니라 행이다');

  step('기본 상태 (Req 14.1 — 아무것도 하지 않아서 비공개)');
  show('탐색 피드', (await sharing.feed()).assets.map((asset) => asset.name));
  show('isPubliclyVisible', await sharing.isPubliclyVisible(ASSET));

  step('공개 (Req 14.2 — 추측이 어려운 링크 + Audit_Log)');
  const published = await sharing.publish({ ownerId: OWNER, assetId: ASSET, remixAllowed: true });
  ok(`링크 발급: ${published.url}`);
  note(`토큰 ${published.link.token.length}자 · base64url · 256비트 엔트로피`);

  step('공개 페이지 (Req 14.3 — 인증 없는 방문자)');
  const publicPage = await sharing.publicPage(published.link.token);
  show('제목', publicPage.title);
  show('캡션', publicPage.caption);
  show('재생', publicPage.playback);
  show('AI 생성 표기', publicPage.disclosures);
  note(`소유자 식별자 노출 여부: ${JSON.stringify(publicPage).includes(OWNER) ? '노출됨(버그)' : '없음'}`);

  step('탐색 피드 · 장르 필터 (Req 14.5, 14.6)');
  ok(`전체 → ${(await sharing.feed()).assets.map((a) => a.name).join(', ')}`);
  ok(`genre=lo-fi → ${(await sharing.feed({ genre: 'LO-FI' })).assets.map((a) => a.name).join(', ')}`);
  ok(`genre=ambient → ${(await sharing.feed({ genre: 'ambient' })).assets.map((a) => a.name).join(', ') || '(없음)'}`);

  step('좋아요 멱등 (Req 14.7·14.8 — Property 20)');
  show('user-9 첫 좋아요', await sharing.like(ASSET, 'user-9'));
  show('user-9 다시', await sharing.like(ASSET, 'user-9'));
  show('user-9 또', await sharing.like(ASSET, 'user-9'));
  show('user-7 좋아요', await sharing.like(ASSET, 'user-7'));
  note(`저장된 행 수: ${likes.rows.size}건 — 요청은 4번, 행은 2건`);

  step('원격 리믹스 (Req 14.9)');
  ok(`stranger → ${await sharing.remixPermissionFor(ASSET, STRANGER)}`);
  ok(`asset-b(비공개) stranger → ${await sharing.remixPermissionFor('asset-b', STRANGER)}`);

  step('Sound_Pack은 78개 큐가 아니라 한 항목 (Req 14.11)');
  const pack = await sharing.publishSoundPack({ ownerId: OWNER, soundPackId: 'pack-1' });
  ok(`${pack.name} — cueCount=${pack.cueCount}, 피드의 개별 자산 수는 그대로 ${(await sharing.feed()).assets.length}건`);

  /* -------------------------------------------------------------- 5.2 재생 */
  heading('5.2  Playback_Service — Range 스트리밍 · 재생 횟수 · 루프');

  step('전체 재생 (Range 없음)');
  const whole = await playback.stream({ assetId: ASSET, requesterId: STRANGER });
  show('status', whole.status);
  show('headers', whole.headers);
  show('playCount', whole.playCount);

  step('구간 이동 — bytes=400-599 (Req 12.2·12.3)');
  const partial = await playback.stream({
    assetId: ASSET,
    requesterId: STRANGER,
    rangeHeader: 'bytes=400-599',
  });
  show('status', partial.status);
  show('content-range', partial.headers['content-range']);
  const window = await drain(partial.body);
  ok(`받은 바이트 ${window.length}개, 첫 바이트=${String(window[0])} ${DIM}(객체의 i번 바이트는 i%256 → 400%256=144)${OFF}`);
  ok(`스토어에 실제로 요청한 창: ${JSON.stringify(objects.reads.at(-1))}`);
  show('playCount (구간 이동은 세지 않는다)', partial.playCount);

  step('범위 밖 요청 (Req 12.2 — 416은 크기를 함께 준다)');
  await expectRefusal('bytes=5000-', () =>
    playback.stream({ assetId: ASSET, requesterId: STRANGER, rangeHeader: 'bytes=5000-' }),
  );

  step('파형 (Req 12.7)');
  const waveform = await playback.waveform(ASSET, STRANGER, 16);
  ok(`버킷 ${waveform.buckets.length}개, 첫 3개 = ${JSON.stringify(waveform.buckets.slice(0, 3))}`);

  step('루프 이음 (Req 12.9 — durationMs=4000)');
  for (const elapsed of [3_999, 4_000, 4_001, 10_500]) {
    const position = await playback.positionAfter(ASSET, STRANGER, elapsed);
    ok(`${String(elapsed).padStart(6)}ms 경과 → pass ${position.pass}, 위치 ${position.positionMs}ms`);
  }

  step('공개 철회 (Req 14.4) → 링크도 스트림도 함께 닫힌다');
  await sharing.revoke({ ownerId: OWNER, assetId: ASSET });
  await expectRefusal('철회된 링크로 공개 페이지', () => sharing.publicPage(published.link.token));
  await expectRefusal('stranger의 스트리밍', () =>
    playback.stream({ assetId: ASSET, requesterId: STRANGER }),
  );
  ok(`소유자 본인은 여전히 재생 가능 → status ${String((await playback.stream({ assetId: ASSET, requesterId: OWNER })).status)}`);
  note('가시성은 Sharing_Service 한 곳이 답한다 — 피드에서 숨겨졌는데 스트리밍되는 상태가 생길 수 없다');

  /* ------------------------------------------------------------ 5.3 페르소나 */
  heading('5.3  Persona_Service — 엔진 슬롯이 하나라서 큐가 있다');

  step('참조 곡 7개로 학습 요청 (Req 15.2 — 최소 개수를 돌려준다)');
  await expectRefusal('참조 7곡', () =>
    personas.requestTraining({
      ownerId: OWNER,
      name: '내 목소리',
      referenceAssetIds: REFERENCES.slice(0, 7),
      consent: { rightsConfirmed: true, confirmedAtMs: NOW },
    }),
  );

  step('참조 곡 8개 — 두 건 연속 요청');
  const first = await personas.requestTraining({
    ownerId: OWNER,
    name: '내 목소리',
    referenceAssetIds: REFERENCES,
    consent: { rightsConfirmed: true, confirmedAtMs: NOW },
  });
  const second = await personas.requestTraining({
    ownerId: OWNER,
    name: '두 번째',
    referenceAssetIds: REFERENCES,
    consent: { rightsConfirmed: true, confirmedAtMs: NOW },
  });
  ok(`1번 → ${first.persona.status}  (학습 작업 식별자 ${first.trainingJobId})`);
  ok(`2번 → ${second.persona.status}  대기 순번 ${second.queuePosition}`);
  note(`엔진이 실제로 시작한 것: ${JSON.stringify(training.started)}`);

  step('진행률 (Req 15.3 — 대기 중인 쪽에 남의 숫자를 붙이지 않는다)');
  training.report = { ...training.report, currentStep: 42, totalSteps: 100 };
  show('1번(실행 중)', await personas.progress(first.persona.id, OWNER));
  show('2번(대기 중)', await personas.progress(second.persona.id, OWNER));

  step('학습 완료 → 어댑터 등록, 큐가 다음을 시작 (Req 15.4)');
  training.finish();
  const ready = await personas.completeTraining(first.persona.id);
  ok(`1번 ${ready.status}, adapterRef=${String(ready.adapterRef)}`);
  ok(`엔진이 시작한 것: ${JSON.stringify(training.started)}`);

  step('생성 요청에 페르소나 지정 (Req 15.5·15.6)');
  ok(`소유자 → adapterRef ${await personas.resolveAdapter(first.persona.id, OWNER)}`);
  await expectRefusal('남의 페르소나 지정', () =>
    personas.resolveAdapter(first.persona.id, STRANGER),
  );

  /* --------------------------------------------------------------- 2.7 전사 */
  heading('2.7  Transcription_Adapter — Whisper 응답을 밀리초 행으로');

  step('엔진이 초 단위 부동소수 세그먼트를 돌려준다');
  whisper.setSegments([
    { start: 0.4004, end: 1.9996, text: ' 늦은 밤 도심을 달려' },
    { start: 2.0, end: 3.4999, text: ' 신호등이 하나씩 꺼져가' },
    { start: 3.5001, end: 3.5002, text: ' (숨소리)' },
  ]);
  whisper.setLanguage('ko', 0.97);
  note('세 번째 세그먼트는 0.1ms — 반올림하면 길이 0이 된다');

  const result = await transcription.transcribe({ audioId: ASSET });
  for (const line of result.lines) {
    ok(`[${String(line.startMs).padStart(5)}ms – ${String(line.endMs).padStart(5)}ms] ${line.text}`);
  }
  show('언어', result.language);
  show('등급 / 모델', `${result.tierId} / ${result.modelId}`);
  note('길이 0이 된 행은 서비스가 버렸다 (Req 27.7) — 어댑터가 경계를 늘리지 않는다');

  step('언어 힌트를 주면 신뢰도를 보고하지 않는다 (Req 27.3 vs 27.4)');
  const hinted = await transcription.transcribe({ audioId: ASSET, languageCode: 'ja' });
  show('힌트 ja', hinted.language);
  note('엔진은 힌트에도 확률(0.97)을 돌려줬지만, 판별하지 않은 것을 판별했다고 보고하지 않는다');

  step('LRC 다운로드 (Req 27.10·27.13 — 태스크 2.3의 프린터를 그대로 쓴다)');
  await transcription.transcribe({ audioId: ASSET });
  const download = transcription.download(ASSET);
  for (const line of download.lrc.split('\n').filter((entry) => entry.length > 0)) ok(line);

  step('엔진 실패 (Req 27.16 — 예외가 아니라 사유 코드, 기존 결과는 보존)');
  whisper.failNextWithStatus(503);
  await expectRefusal('전사 재요청', () => transcription.transcribe({ audioId: ASSET }));
  ok(`저장된 결과는 그대로: ${String(transcription.download(ASSET).text.split('\n').length)}행`);

  /* ------------------------------------------------------------------ 감사 */
  heading('Audit_Log');
  for (const entry of audited) ok(entry);

  console.log(`\n${GREEN}${BOLD}데모 완료 — 위 출력은 전부 프로덕션 서비스 코드의 실제 반환값입니다.${OFF}\n`);
}

await main();
