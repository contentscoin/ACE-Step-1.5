# MusicStudio 인수인계서 (Handoff)

작성 시점: 태스크 **4.2 Mixdown_Renderer** 완료 직후 (4.1 시점 문서를 갱신).
스펙: `.kiro/specs/ai-music-generation-service/` (requirements.md / design.md / tasks.md).

이 문서는 다음 담당자가 코드베이스를 다시 조사하지 않고 4.2로 넘어갈 수 있도록 하는 데 목적이 있다.

---

## 1. 지금 어디까지 되어 있는가

| Phase | 태스크 | 상태 |
|---|---|---|
| 1 | 1.0–1.5 Foundation (데이터 모델, 인프라, 엔진 추상화) | 완료 |
| 2 | 2.1–2.7 Core Generation (곡, BGM, SFX, 대사, V2A) | 완료 |
| 3 | 3.1–3.4 Audio Processing (DSP, 이펙트, 마스터링, 사운드 팩) | 완료 |
| 4 | 4.1 Timeline_Service | 완료 |
| 4 | **4.2 Mixdown_Renderer** | **완료 (이번 작업)** |
| 4 | 4.3 클립 이펙트 및 타임라인 통합 | 미착수 — **다음 작업** |
| 5–9 | Library/재생/공유, 안전·라이선스, 프런트엔드, 관측성, 공개 API | 미착수 |
| 6 | 6.1, 6.2 (안전·동의 일부) | 완료 |

### 현재 테스트 기준선 (green)

```
cd musicstudio
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"   # npm 은 기본 PATH 에 없다
npm run lint          # clean
npm run typecheck     # 0 errors
npm test              # 2726 passed | 20 skipped  (~47 s)
python3 dsp/scripts/check_import_boundary.py
dsp/.venv/bin/python -m pytest dsp/test   # 410 passed | 5 skipped  (~54 s)
```

4.1 시점 기준선은 TypeScript 2666, Python 365 였다. 4.2 가 TypeScript +60, Python +45 를 더했다.
(Python 총 시간이 38 s → 54 s 로 늘어난 것은 4.2 때문이 아니다. `--durations` 상위 8개는 전부
태스크 3.2/3.3 의 것이고 4.2 의 테스트는 각 1 s 미만이다. 측정 머신 부하 차이로 보인다.)

- TypeScript 20 skip = `test/integration/db-schema.test.ts` (PostgreSQL 없음). **정상이며 그대로 둔다.**
- Python 5 skip = `pydub`/`ffmpeg` 폴백 경로. **정상이며 그대로 둔다.**
- 이 숫자를 줄이기 위해 테스트를 삭제하거나 `.skip` 하지 않는다.

---

## 2. 절대 깨뜨리면 안 되는 것 하나

**`musicstudio/` 는 `acestep/` 를 절대 import 하지 않는다** (design §1.4.4, §14 위험 #9).

- TypeScript 측: `musicstudio/eslint.boundary.mjs` (`npm run lint`)
- Python 측: `musicstudio/dsp/scripts/check_import_boundary.py`
- 둘 다 CI 필수 체크(`.github/workflows/musicstudio-ci.yml`)다. 예외를 추가하거나 규칙을 약화시키지 않는다.

엔진에 도달하는 유일한 경로는 `ACE_Engine_Adapter` 의 HTTP 인터페이스다(§3.1).

---

## 3. 환경 제약 (재발견하지 말 것)

- PostgreSQL, Redis, SMTP, BullMQ **모두 접근 불가**. 포트 뒤에 인메모리 fake 를 두는 것이 이 저장소의 방식이다
  (`test/support/fake-redis.ts`, `test/support/in-memory-account-repository.ts`,
  `test/support/timeline-harness.ts` 의 `inMemoryTimelineStore` 등).
- 마이그레이션은 **한 번도 적용된 적이 없다.** 스키마 검증은 "도메인 상수와 SQL 문자열이 일치하는가"를 보는
  parity 테스트로 한다.
- `npm` 은 `$HOME/.nvm/versions/node/v22.23.1/bin` 에 있다.
- Python 은 `dsp/.venv/bin/python` (3.11). 맨 `python3` 는 3.9 이고 import boundary 스크립트 실행에만 쓴다.

---

## 4. 이 저장소의 관례 (따르면 리뷰가 통과한다)

### 4.1 bounds 와 threshold 의 분리

- **bounds** = 그 대상이 *무엇인지* 정의하는 수. `domain/<area>/bounds.ts` 에 상수로 둔다.
- **threshold** = 어떤 오디오가 *허용되는지*에 대한 판단. `domain/quality/threshold-set.ts` 를 통해 읽는다
  (Req 34.4 로 운영자가 재조정 가능해야 하는 것들).
- 판별 기준: **그 수를 바꾸면 이미 기록된 측정값의 의미가 바뀌는가?** 바뀌면 bounds, 안 바뀌면 threshold 후보.
- `QUALITY_THRESHOLD_NAMES` 를 늘리면 `test/unit/bgm/threshold-set.test.ts` 의 exhaustive 목록도 함께 고쳐야 한다.

### 4.2 파서/프린터/동등 관계 (design §7.1)

지금까지 네 쌍이 있고 모두 같은 모양이다:

| 구조체 | 위치 |
|---|---|
| `Lyrics_Document`, `Timed_Lyrics` | `domain/lyrics/{lyrics,lrc}-{parser,printer}.ts` + `equivalence.ts` |
| `Effect_Chain` | `domain/effects/{chain-parser,chain-printer,equivalence}.ts` |
| `Cue_Pack_Manifest` | `domain/sound-pack/{manifest-parser,manifest-printer,equivalence}.ts` |
| `Timeline_Project` | `domain/timeline/{project-parser,project-printer,equivalence}.ts` ← 4.1 |

실패 형태는 전부 `domain/parse-error.ts` 의 `ParseError` / `ParseResult<T>` 다.

**두 번 배운 교훈 — 다시 배우지 말 것:**

1. **`JSON.stringify(-0) === "0"`.** 따라서 수치 왕복 주장은 반드시 **절대 차이**로 비교한다.
   `toBe` / `Object.is` 는 `-0` 과 `0` 에서 실패한다. 그리고 `!(drift <= tolerance)` 로 쓴다 —
   `drift > tolerance` 는 `NaN` 을 조용히 통과시킨다.

   **4.2 가 여기서 한 번 미끄러졌으니 덧붙인다: 두 형태는 서로 바꿔 쓸 수 없고, 술어의 방향이 기준이다.**
   *위반* 술어("허용 범위를 벗어났는가")는 `!(drift <= tol)` 로 써야 `NaN` 이 위반으로 잡힌다.
   *허용* 술어("허용 범위 안인가", 예: `mixdownLengthWithinTolerance`)는 평범한 `drift <= tol` 이
   맞다 — 이쪽에서 `!(drift > tol)` 로 쓰면 `NaN` 을 **통과**시킨다. 방향을 헷갈리면 정확히 반대가 된다.
2. **프린터는 객체의 키 삽입 순서를 물려받으면 안 된다.** 스프레드가 아니라 필드를 하나씩 나열해서
   순서를 고정한다. 안 그러면 바이트 동일 재출력이 깨진다.

### 4.3 마이그레이션

- 파일명 `NNNN_snake_case.sql`, **번호에 빈칸이 없어야 한다**(`db/runner.ts` 가 검사).
- `0001`–`0015` 사용 중. **다음 빈 번호는 `0016`.**
- parity 테스트는 **존재 + 유일성 + gap-free** 로 검증한다. **"최신 마이그레이션은 NNNN 이다" 같은 단정은 쓰지 않는다** —
  태스크 3.2 가 정확히 그 취약함을 제거했다. 모든 후속 태스크에서 무관한 이유로 깨지고, 사람이 테스트를 읽는 대신
  고치도록 훈련시킨다.
- SQLSTATE 관례: `MS` + 요구사항 번호 (예: 타임라인은 `MS028`).
- 헤더 주석이 길고 load-bearing 하다. parity 테스트에서 "이 컬럼은 없다"를 단정할 때는 주석을 제거한 DDL 을 봐야 한다
  (`test/unit/timeline/schema-parity.test.ts` 의 `ddlOf` 참고).

### 4.4 속성 기반 테스트 (PBT)

- design §10 이 Property **1–24** 를 번호로 고정한다. `tasks.md` §9.2 에 소유 태스크 매핑표가 있다.
  **번호를 새로 만들거나 재배정하지 않는다.** 번호 없는 불변식은 명시적으로 "unnumbered" 라고 적어
  9.2 의 감사가 오집계하지 않게 한다.
- 최소 반복 100회 (`fast-check` 의 `numRuns`, `hypothesis` 의 `max_examples`).
- 주석 형식: `Feature: ai-music-generation-service, Property {번호}: {속성 문장}` + `**Validates: Requirements N.M**`.
- **`await fc.assert(fc.asyncProperty(...))` 의 `await` 를 빠뜨리지 않는다.** 태스크 2.6 이 `await` 누락으로
  공허하게 통과하는 속성을 출하한 적이 있다.
- **생성기는 유효 입력 공간으로 제약해서 만든다(smart generator).** `fc.record` 로 임의값을 뽑고 걸러내는 방식은
  관계적 유효성(예: 겹치지 않는 클립 배치)을 가진 구조에서는 사실상 성공하지 않는다.
  참고 구현: `test/property/cue-pack-manifest.test.ts`, `test/support/timeline-harness.ts` 의 `validProject`.
- 속성 테스트가 실패해 반례가 나오면 세 가지 중 하나로 분류한다: (1) 테스트가 틀렸다, (2) 코드 버그다,
  (3) 명세가 이상하다 — 3번이면 **수용 기준을 임의로 바꾸지 말고** 사용자에게 묻는다.
- **속성이 어느 하네스에 사는가는 그 속성이 무엇에 대한 것인지로 정한다.** 샘플에 대한 진술은 Python
  (`hypothesis`), 파서·계획·상태 전이에 대한 진술은 TypeScript(`fast-check`). 지금까지: 1–11·16–23 은
  TypeScript, **12·13**(믹스다운, `dsp/test/test_mixdown.py`) · 14·24(이펙트) · 15(마스터링)는 Python.

### 4.5 오류 계약

- 서비스 거절은 `services/generation/errors.ts` 의 `GenerationError`(statusCode, code, details)로 던진다.
  게이트웨이(`api/gateway/error-handler.ts`)가 분기 추가 없이 렌더링한다.
- 상태 코드 관례: 요청이 잘못됨 → 400. 요청은 정상이지만 **현재 상태**가 거부 → 409.
  남의 리소스 → 403(존재 여부를 숨기지 않는다 — 식별자는 소유자만 얻을 수 있으므로 403 이 정직하다).
  품질 미달처럼 사용자가 재생성으로 대응할 수 있는 것 → 422. 서비스가 약속을 못 지킨 것 → 500.

---

## 5. 4.1 이 남긴 것 (다음 태스크가 그대로 쓸 것)

### 5.1 도메인 — `musicstudio/domain/timeline/`

| 파일 | 내용 |
|---|---|
| `bounds.ts` | Req 28 의 구조적 수치: 트랙 0–31, 클립 상한 500, 게인 −40…+12 dB, 트랙 음량 −60…+12 dB, 팬 ±1, 페이드 50 %, 템포 30–300 BPM, 박자 2/3/4/6, 스냅 창 50 ms, 이력 100, 재생 헤드 20 ms, 자동 배치 200 ms, `barLengthMs()` |
| `project.ts` | `TimelineProject` / `TimelineClip` / `TrackSettings` 타입, 검증(`projectViolations`), 겹침 계산(`overlapMs`, `findOverlaps`), 재생 길이(`clipPlayLengthMs`) |
| `equivalence.ts` | **프로젝트 동등 관계** (Req 28.32). 시각·식별자 정확, 게인·트랙 음량 0.1 dB, 팬 0.01. 실패 시 이유 문자열 반환 |
| `project-printer.ts` | `Project_Printer`. 키 순서 고정, 32 트랙 위치 배열 |
| `project-parser.ts` | `Project_Parser`. 모든 결함 반환, 선택적 자산 카탈로그로 Req 28.34 검사 |
| `commands.ts` | **12개 편집 조작**의 Command Pattern. `planX()` → 검증 + 역연산 데이터 포착, `executeCommand` / `undoCommand`, design §6.4 모양의 `commandHandle()` |
| `history.ts` | 되돌리기 이력(100단계, 오래된 것 축출, 새 조작 시 다시 실행 이력 비움), Req 28.38 사유 코드 |
| `snapping.ts` | Req 28.21 스냅 후보(인접 클립 시작/종료, 마디 경계) + 최근접·동거리 시 이른 시각 선택 |
| `render-target.ts` | **Req 28.19/28.20 렌더링 대상 클립 집합** — 음소거가 솔로보다 우선. **4.2 가 이것을 그대로 쓴다** |
| `playhead.ts` | Req 28.35. 단일 재생 헤드이므로 트랙 간 오차는 구조적으로 0 |

### 5.2 서비스 — `musicstudio/services/timeline/`

- `ports.ts` — `TimelineProjectStore`, `TimelineAssetCatalogue`, `TimelineProjectRecord`
  (= project + history + createdAtMs + updatedAtMs).
- `errors.ts` — Req 28.5/28.8/28.11/28.38 이 요구하는 페이로드를 타입으로 강제.
- `timeline-service.ts` — 프로젝트 CRUD, 12개 조작, undo/redo, export/import, `renderTargets`, `seekPlayhead`.

### 5.3 스키마

`db/migrations/0015_timeline_project.sql` — `timeline_project`, `timeline_clip`, `timeline_track`.
CHECK 로 표현 못 하는 셋(클립 상한 500, 겹침 금지, 원본 길이 미러 검증)은 `timeline_clip_bounds` 트리거에 있다.
`btree_gist` 확장을 쓰지 않기 위해 `EXCLUDE USING gist` 대신 트리거를 택했다.

### 5.4 테스트

- `test/property/timeline-project.test.ts` — Property **6, 7**
- `test/property/timeline-undo-redo.test.ts` — Property **16, 17** (12개 조작 각각 개별 `it`, 각 100회)
- `test/unit/timeline/{clip-operations,snapping,history,serialisation,render-target,timeline-service,schema-parity}.test.ts`
- `test/support/timeline-harness.ts` — `validProject` 생성기, 인메모리 스토어, 자산 카탈로그 fake

---

## 6. 4.2 가 남긴 것 (Req 28.24–28.29)

### 6.1 어느 쪽에 무엇이 있는가

**샘플은 Python, 판단은 TypeScript.** 태스크 3.2 의 이펙트와 같은 배치다.

| 파일 | 내용 |
|---|---|
| `dsp/src/musicstudio_dsp/mixdown.py` | design §5.6 클립 체인 + §6.1 합산 + 28.28 피크 정규화. `render_mixdown()`, `peak_normalisation()`, `mixdown_length_ms()`, `EmptyRenderError` |
| `dsp/src/musicstudio_dsp/worker.py` | `musicstudio_dsp.render_mixdown` 태스크 셸 (기존 9개 뒤에 추가). `test_worker.py` 의 `TASK_NAMES` 는 **인덱스로 단정**하므로 끝에 붙였다 |
| `dsp/test/test_mixdown.py` | **Property 12(가환성), 13(재현성)** 각 100회 + 길이·합산·페이드·정규화 단위 테스트 |
| `domain/timeline/mixdown.ts` | 오디오 없이 결정되는 전부: bounds, `planMixdown()`(28.19/28.20/28.25/28.26/28.29), `peakNormalisation()`, `MixAssetMetadata` |
| `services/timeline/mixdown-ports.ts` | `MixdownRenderPort`(워커 seam), `MixdownAssetStore`(mix 자산 + 계보 + 메타데이터를 한 번에 저장) |
| `services/timeline/mixdown-renderer.ts` | `createMixdownRenderer()`. 계획 → 사전 거절 → 렌더 → **불변식 검사** → `mix` Audio_Asset 저장 |
| `test/unit/timeline/mixdown.test.ts` | 도메인 + **mixdown.py 와의 상수 parity** (Python 소스를 텍스트로 읽는다. 프로세스를 띄우지 않는다) |
| `test/unit/timeline/mixdown-renderer.test.ts` | 서비스. 포트는 스텁 — 오디오는 이 seam 을 건너지 않는다 |
| `test/property/timeline-mixdown-plan.test.ts` | 계획 계층 속성. **전부 unnumbered** (Property 12/13 은 Python 에 있다) |
| `test/support/timeline-harness.ts` | `stubMixdownRenderPort()`, `recordingMixAssetStore()`, `mixProvenance()` 추가 |

**마이그레이션을 추가하지 않았다.** `0015` 헤더가 이미 "믹스다운 컬럼은 두지 않는다 — 자산은 0003,
계보는 0005" 라고 못박았고, 자산 메타데이터 테이블은 Library_Service(5.1) 것이다(0012 헤더의
`DialogueRenditionStorePort` 와 같은 상태). 그래서 28.28 의 감쇠량은 `MixdownAssetStore` 를 통해
간다. **다음 빈 마이그레이션 번호는 여전히 `0016`.**

### 6.2 4.2 가 내린 결정 중 4.3 이 알아야 할 것

1. **렌더링 대상은 `renderTargetSet()` 을 그대로 소비한다.** 정렬(클립 ID 오름차순)만 4.2 가 한다.
   워커도 도착 후 다시 정렬한다 — 순서는 Property 12/13 의 전제이고, 어느 한쪽이 혼자 잃을 수 있으면 안 된다.
2. **트랙 음량·팬은 클립 게인 단계에 접어 넣었다.** design §6.1 의 5단계는 합산 *후* 에 적용하라고
   하지만, 합산 후에는 트랙 정보가 남아 있지 않아 문자 그대로는 구현 불가다(§7 결함 9). 상수 스칼라이고
   Req 28.7 이 같은 트랙 클립 겹침을 금지하므로 per-clip 적용은 per-track 버스와 **정확히 같은**
   부동소수점 연산이다. 32개 버스를 만들면 5분 스테레오에서 7 GB 다.
3. **팬 법칙은 balance 법칙**: `left = min(1, 1−pan)`, `right = min(1, 1+pan)`. `pan = 0` 이 정확히 1.0
   이어야 해서다(등파워 법칙은 기본값에서 모든 믹스를 3 dB 줄이고 정규화 발동 조건을 바꾼다).
   모노 렌더에서는 팬을 적용하지 않는다. Req 28.18 이 범위만 정하므로 **열린 질문**(§7 결함 10).
4. **정규화는 단일 광대역 게인.** 리미터가 아니다 — 태스크 3.3 이 Req 30.8 멱등성에서 남긴 논거가
   그대로 적용된다(스케일 등변성이 없으면 재현성이 깨진다).
5. **BLAS 스레드**: 태스크 3.1/3.2/3.3 의 결론을 되풀이하지 않았다. Python 에서 못 박을 수 없고,
   `mixdown.py` 의 배열 연산은 전부 elementwise(`+=`, 슬라이스, 스칼라 곱)이며 `dot`/`@`/`einsum`/
   축 `sum` 이 하나도 없다. 그래서 Property 13 은 스레드 수에 **무관하게** 성립한다. 컨테이너에
   `OMP_NUM_THREADS=1` 을 두는 것은 여전히 design §11.3 의 몫이다.
6. **누산기는 float64, 출력은 float32** (design §6.1 그대로). 이 덕분에 재결합 오차가 float32 마지막
   비트에 도달하지 못한다 — 즉 "샘플 비트 동일" 테스트만으로는 정렬이 사라진 구현을 잡지 못한다.
   그래서 `rendered_clip_ids` / `renderedClipIds` 를 결과에 실어 **순서 자체를 단정**한다.
7. **클립 이펙트 슬롯은 배선만 했다.** `MixdownClip.effect_chain` 과 `effect_processor` 인자가 있고,
   체인이 있는데 프로세서가 없으면 `mixdown_clip_effects_unsupported` 로 **거절**한다(조용히 버리면
   완성된 것처럼 보이는데 사용자 편집이 빠진 믹스가 나온다). `TimelineClip` 에는 아직 체인 필드가 없다.

---

## 6.3 다음 작업: 4.3 클립 이펙트 및 타임라인 통합 검증

`_Requirements: 29.31–29.32, 2.12_`, `_설계: §6.3_`. **조항 소유는 배타적이다** — 28.24–28.29 는 4.2 가
구현했다. 다시 구현하지 않는다.

시작점:

1. **`TimelineClip` 에 `Effect_Chain` 필드를 추가**해야 한다. 지금은 없다. 추가하면
   `TIMELINE_CLIP_FIELDS`, `project-printer.ts`, `project-parser.ts`, `equivalence.ts`(체인 동등 관계는
   `domain/effects/equivalence.ts` 에 이미 있다), `0015` 스키마 + `schema-parity.test.ts` 가 모두 따라온다.
   Req 28.32 의 왕복 속성(Property 6)이 새 필드를 비교하는지 확인해야 한다.
2. **테일 정책이 4.3 의 핵심이다.** design §6.3 + Req 29.32: 믹스 안에서는 **클립 재생 길이로 잘라냄**,
   테일 보존은 독립 Generation_Version 저장 시에만(최대 +10000 ms). 잘라냄 자체는 4.2 가 이미 한다
   (`_clip_signal` 4단계) — 4.3 은 `effect_processor` 를 실제로 공급하면 된다.
   `dsp/src/musicstudio_dsp/effects.py` 의 `apply_chain()` 이 그 프로세서다(패딩·상한 처리 포함).
3. **크레딧 차감(Req 2.12)** 은 4.3 것이다. `renderProject()` 가 `metadata.durationMs` 를 돌려주므로
   단가 × 렌더링 길이의 곱셈 인자는 이미 있다. `services/credit/` 을 쓴다.
4. **재현성 3회 확인**은 이미 있는 Property 13 을 재작성하지 말고 **이펙트 포함 케이스로 확장**한다
   (`dsp/test/test_mixdown.py` 의 `TestProperty13...` 에 `effect_processor` 를 넘기는 예제 추가).
   Property 14(이펙트 재현성)는 태스크 3.2 것이므로 새 번호를 만들지 않는다.
5. 소유 Property: **없다.** §9.2 표에 4.3 항목이 없다. 새로 쓰는 것은 전부 "unnumbered" 라고 적는다.

---

## 7. 명세 결함 / 열린 질문 (4.1 이 발견)

다음 담당자나 스펙 소유자가 판단해야 하는 것들. 코드에는 잠정 결정과 근거가 주석으로 남아 있다.

1. **트랙 음소거를 바꾸는 편집 명령이 없다.** Req 28.20/28.32 는 트랙 음소거 상태를 저장 대상으로 다루지만,
   Req 28.23 의 12개 목록과 design §6.4 의 `EditCommandType` 에는 `track_mute` 가 없다.
   → 12개를 유지했다. 13번째를 추가하면 수용 기준의 "12개 편집 조작"이 틀리게 된다.
2. **프로젝트 이름·설명 길이 제한이 없다.** Req 28.1 은 길이를 말하지 않는다.
   → 이름 1–200자(`domain/audio-asset.ts` 와 동일), 설명 0–2000자로 **유도**했다. 확정이 필요하다.
3. **분할 시 페이드 처리 규칙이 없다.** Req 28.14 는 재생 길이 합만 규정하고, Req 28.17 의 상한은
   재생 길이에 상대적이므로 규칙이 없으면 분할이 불변식을 깰 수 있다.
   → 왼쪽은 원래 페이드 인 유지(새 상한으로 clamp) + 페이드 아웃 0, 오른쪽은 페이드 인 0 + 원래 페이드 아웃 유지.
     DAW 관례이고 절단면에 없던 페이드를 만들지 않는다.
4. **프로젝트 이름 변경이 되돌리기 대상인지 불명.** Req 28.23 목록은 클립·트랙 단위뿐이다.
   → 이력에 넣지 않았고 다시 실행 이력도 비우지 않는다.
5. **Req 28.21 의 "인접 클립"에 트랙 한정이 없다.** → 모든 트랙의 다른 클립을 후보로 삼았다.
   효과음을 음악에 맞추는 것이 이 기능의 주 용도이므로 이 해석이 맞다고 판단했다.
6. **Req 28.15 복제 배치에 트랙 명시가 없다.** → 같은 트랙으로 해석했다(원본 종료 시각 기준 배치는
   그 트랙의 타임라인에 대한 진술이므로). 충돌 시 밀지 않고 Req 28.8 로 거절한다.
7. **태스크 4.1 의 `_Requirements: 28.1–28.39_` 는 4.2 의 28.24–28.29 와 겹친다.**
   → `tasks.md` Notes 의 "한 조항은 정확히 한 태스크가 소유" 원칙에 따라 28.24–28.29 는 4.2 에 남겼다.
     4.1 은 28.1–28.23 과 28.30–28.39 를 구현했다.
8. `Quality_Threshold_Set` 의 `loop_bar_alignment_tolerance_ms`, `sound_pack_export_budget_ms` 가
   Req 34.1 의 서술된 주제(청감 임계값)와 어긋난다는 이전 태스크의 지적이 여전히 열려 있다
   (`domain/quality/threshold-name.ts` 헤더 참고).

### 4.2 가 발견한 것

9. **design §6.1 의 5단계는 문자 그대로 구현 불가다.** `output = apply_track_volumes_and_pans(output, ...)`
   는 모든 클립을 하나의 `output` 에 합산한 *뒤* 트랙 음량·팬을 적용하라고 하지만, 합산 후에는 어떤
   샘플이 어느 트랙에서 왔는지 복구할 수 없다. → "각 클립을 자기 트랙의 음량·팬으로 스케일한다"로 읽고
   게인 단계에 접어 넣었다. Req 28.7(같은 트랙 비중첩) 덕분에 per-track 버스와 부동소수점 연산까지
   동일하다. 근거는 `mixdown.py` 헤더에 있다.
10. **Req 28.18 이 팬 법칙을 정하지 않는다.** 범위(−1…+1)만 있다. → balance 법칙을 택했고 모노 렌더에는
    적용하지 않는다(§6.2 항목 3). 확정이 필요하다.
11. **Req 28.28 이 서로 만족시킬 수 없는 두 가지를 요구한다.** 피크를 0.99–1.0 으로 맞추라 **그리고**
    감쇠량을 40 dB 이하로 보고하라. 40 dB = ×100 이므로 합산 피크가 99.5 를 넘으면 둘을 동시에 만족할 수
    없고, 그 피크는 Req 28 자신의 범위 안에서 도달 가능하다(클립 +12 dB × 트랙 +12 dB = ×15.85, 트랙 32개).
    → 진폭 창을 지키고(오디오에 대한 의무) dB 값은 `within_reportable_range: false` 로 **표시**한다.
    계수를 clamp 해서 피크를 1.0 위에 남기지 않는다. 확정이 필요하다.
12. **Req 19.6(직접 입력 자산 64개)과 Req 28.5(클립 500개)가 충돌한다.** 서로 다른 자산 65개를 참조하는
    프로젝트는 하나의 `mix` 로 저장할 수 없다. → 렌더 *전에* `mixdown_input_limit_exceeded`(409)로
    거절한다. 계보를 잘라내는 것은 Req 33.20 의 라이선스 접기가 바로 그 목록을 읽으므로 더 나쁘다.
13. **Req 19.11(자산 최대 1시간)과 믹스다운 길이가 충돌할 수 있다.** 프로젝트 길이에는 상한이 없다.
    → 역시 렌더 전에 `mixdown_length_unsupported`(409)로 거절한다(1시간을 렌더해서 버리지 않기 위해).
14. **Req 19.12 의 `engine_id`**: 믹스다운은 엔진이 만든 것이 아니다. → `musicstudio-mixdown` 이라는
    표식을 쓴다(`MIXDOWN_RENDERER_ENGINE_ID`). 19.12 의 "업로드 출처 표식" 슬롯을 일반화한 것이다.
15. **Req 33.20 의 상업적 사용 접기는 4.2 가 하지 않는다.** Property 18 / 태스크 6.3 것이므로,
    provenance 와 접힌 플래그는 요청과 함께 들어온다. `validateAudioAsset` 이 국소적으로 확인 가능한
    규칙(자기 provenance 가 허용하지 않는 상업적 사용을 주장할 수 없음)만 강제한다.

---

## 8. 작업 위생

- **`git add -A` / `git add .` 를 쓰지 않는다.** 작업 트리는 공유된다. 파일 경로를 명시해서 스테이징한다.
- 커밋 전에 `git write-tree` + `git archive` 로 스테이지된 트리를 임시 디렉터리에 풀어 빌드/venv 산물이
  섞이지 않았는지 확인한다.
- 커밋하지 않는 것: `dsp/.venv/`, `__pycache__/`, `*.pyc`, `*.egg-info`, `node_modules/`.
- 손대지 않는 것: `acestep/` 전체, 저장소 루트의 `package.json`·`pyproject.toml`·`requirements*.txt`·`uv.lock`,
  `.github/workflows/`(읽기 전용), `.kiro/`(스펙 문서는 스펙 소유자가 관리).
  `musicstudio/package.json` 과 `musicstudio/dsp/pyproject.toml` 은 작업 대상이다.
- 커밋 메시지 형태: `feat(<area>): <요약> (task N.M)`.
