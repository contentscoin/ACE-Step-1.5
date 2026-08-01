# MusicStudio 인수인계서 (Handoff)

작성 시점: 태스크 **4.3 클립 이펙트 및 타임라인 통합 검증** 완료 직후 — Phase 4 종료 (4.2 시점 문서를 갱신).
스펙: `.kiro/specs/ai-music-generation-service/` (requirements.md / design.md / tasks.md).

이 문서는 다음 담당자가 코드베이스를 다시 조사하지 않고 **5.1 Library_Service** 로 넘어갈 수 있도록 하는 데 목적이 있다.

---

## 1. 지금 어디까지 되어 있는가

| Phase | 태스크 | 상태 |
|---|---|---|
| 1 | 1.0–1.5 Foundation (데이터 모델, 인프라, 엔진 추상화) | 완료 |
| 2 | 2.1–2.7 Core Generation (곡, BGM, SFX, 대사, V2A) | 완료 |
| 3 | 3.1–3.4 Audio Processing (DSP, 이펙트, 마스터링, 사운드 팩) | 완료 |
| 4 | 4.1 Timeline_Service | 완료 |
| 4 | 4.2 Mixdown_Renderer | 완료 |
| 4 | **4.3 클립 이펙트 및 타임라인 통합 검증** | **완료 (이번 작업) — Phase 4 종료** |
| 5 | 5.1 Library_Service | 미착수 — **다음 작업** |
| 5 | 5.2 Playback_Service, 5.3 Sharing_Service | 미착수 |
| 6 | 6.1, 6.2 (안전·동의 일부) | 완료 |
| 6–9 | 6.3 라이선스, 프런트엔드, 관측성, 공개 API, PBT 감사, E2E | 미착수 |

### 현재 테스트 기준선 (green)

```
cd musicstudio
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"   # npm 은 기본 PATH 에 없다
npm run lint          # clean
npm run typecheck     # 0 errors
npm test              # 2806 passed | 20 skipped  (~39 s)
python3 dsp/scripts/check_import_boundary.py
dsp/.venv/bin/python -m pytest dsp/test   # 450 passed | 5 skipped  (~52 s)
```

4.1 시점은 TypeScript 2666 / Python 365, 4.2 시점은 2726 / 410 이었다.
4.3 이 TypeScript **+80**, Python **+40** 을 더했다.

Property 13 에 `effect_processor` 를 넘기는 케이스 2개를 추가했고(각 100 examples × 3 렌더), 그
경로는 `pedalboard` 를 실제로 통과한다. 측정해 보면 Python 전체 시간은 4.2 시점과 사실상 같다
(둘 다 50 s 대). 느려졌다는 인상을 받으면 머신 편차를 먼저 의심할 것. examples 를 낮춰서 시간을
벌지는 않는다 — design §10 의 최소 반복이 100 이다.

- TypeScript 20 skip = `test/integration/db-schema.test.ts` (PostgreSQL 없음). **정상이며 그대로 둔다.**
- Python 5 skip = `pydub`/`ffmpeg` 폴백 경로. **정상이며 그대로 둔다.**
- 이 숫자를 줄이기 위해 테스트를 삭제하거나 `.skip` 하지 않는다.

**단, 위 Python 숫자는 `libatomic.so.1` 이 로더 경로에 있는 호스트의 것이다.** 없으면 5 skip 이
아니라 **53 skip** 이 된다(450 → 402 passed). 실패는 0 이다. 다음 항목을 반드시 읽을 것.

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

### 3.1 `pedalboard` 와 `libatomic.so.1` — 이걸 모르면 스위트가 무너진 것처럼 보인다

`pedalboard` 는 기본 의존성이지만 **네이티브 휠**이고 플랫폼의 `libatomic.so.1` 을 링크한다. 휠은
그것을 번들하지 않는다(`dsp/pyproject.toml` 의 주석이 이 사실을 이미 적어 두었다). CI 의
`ubuntu-latest` 에는 있으므로 CI 는 이펙트 경로를 실제로 실행한다. **이 샌드박스에는 없다** —
`/usr/lib/gcc/x86_64-amazon-linux/11/libatomic.so.1.2.0` 파일은 있지만 `libatomic.so.1` 이라는
이름의 심링크가 없어서 `dlopen` 이 찾지 못한다.

이펙트 경로를 실제로 검증하려면(4.3 을 검증할 때 필요했다):

```bash
mkdir -p /tmp/atomiclib
ln -sf /usr/lib/gcc/x86_64-amazon-linux/11/libatomic.so.1.2.0 /tmp/atomiclib/libatomic.so.1
LD_LIBRARY_PATH=/tmp/atomiclib:$LD_LIBRARY_PATH dsp/.venv/bin/python -m pytest dsp/test
```

`/tmp` 는 도구 호출 사이에 유지되지 않으므로 **심링크 생성과 pytest 실행을 한 명령에 넣어야 한다.**

그리고 규칙: **`pedalboard` 에 도달하는 테스트에는 `requires_pedalboard` 스킵 가드를 붙인다.**
`effects.pedalboard_available()` 위에 만든 마커이며 `test_effects.py` 가 그 형태를 정했다. 가드가
없으면 라이브러리 없는 호스트에서 "이유가 적힌 스킵" 대신 **하드 실패**가 나고, 스위트 전체가
깨진 것처럼 보인다. 4.3 이 처음 작성될 때 새 테스트 23개에 이 가드가 빠져 정확히 그 일이
일어났다. 가드는 **클래스 통째가 아니라 실제로 라이브러리를 쓰는 테스트에만** 붙인다 — 천장
산술, 레지스트리 플래그, 프로세서 없는 체인의 거절, 체인 검증은 모든 호스트에서 계속 돌아야 한다.

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
- `0001`–`0016` 사용 중. **다음 빈 번호는 `0017`.** (`0016` = 4.3 의 `timeline_clip.effect_chain`.)
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
- **기존 Property 를 확장하는 것이 새 번호를 만드는 것보다 항상 낫다.** 4.3 은 "클립 이펙트 포함
  재현성"을 Property 13 의 케이스로 추가했다(§6.3.2 항목 10). 소유 태스크가 없는 속성을 새로 번호
  매기면 §9.2 의 감사가 오집계한다.
- **필드를 추가했으면 그 필드를 비교하는지 변이 테스트로 확인할 것.** 왕복 속성은 조용히 약해진다.
  4.3 의 확인 결과는 §6.3.3 에 표로 있다.

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

**4.2 는 마이그레이션을 추가하지 않았다.** `0015` 헤더가 이미 "믹스다운 컬럼은 두지 않는다 — 자산은
0003, 계보는 0005" 라고 못박았고, 자산 메타데이터 테이블은 Library_Service(5.1) 것이다(0012 헤더의
`DialogueRenditionStorePort` 와 같은 상태). 그래서 28.28 의 감쇠량은 `MixdownAssetStore` 를 통해
간다. **이 상태는 그대로이며 5.1 이 정리할 일이다 — §6.4 참고.**

### 6.2 4.2 가 내린 결정 (여전히 유효)

1. **렌더링 대상은 `renderTargetSet()` 을 그대로 소비한다.** 정렬(클립 ID 오름차순)만 4.2 가 한다.
   워커도 도착 후 다시 정렬한다 — 순서는 Property 12/13 의 전제이고, 어느 한쪽이 혼자 잃을 수 있으면 안 된다.
2. **트랙 음량·팬은 클립 게인 단계에 접어 넣었다.** design §6.1 의 5단계는 합산 *후* 에 적용하라고
   하지만, 합산 후에는 트랙 정보가 남아 있지 않아 문자 그대로는 구현 불가다(§7 결함 9). 상수 스칼라이고
   Req 28.7 이 같은 트랙 클립 겹침을 금지하므로 per-clip 적용은 per-track 버스와 **정확히 같은**
   부동소수점 연산이다. 32개 버스를 만들면 5분 스테레오에서 7 GB 다.
3. **팬 법칙은 balance 법칙**: `left = min(1, 1−pan)`, `right = min(1, 1+pan)`. `pan = 0` 이 정확히 1.0
   이어야 해서다. 모노 렌더에서는 팬을 적용하지 않는다. Req 28.18 이 범위만 정하므로 **열린 질문**(§7 결함 10).
4. **정규화는 단일 광대역 게인.** 리미터가 아니다 — 스케일 등변성이 없으면 재현성이 깨진다.
5. **BLAS 스레드**: Python 에서 못 박을 수 없다. `mixdown.py` 의 배열 연산은 전부 elementwise 이므로
   Property 13 은 스레드 수에 **무관하게** 성립한다. 컨테이너의 `OMP_NUM_THREADS=1` 은 design §11.3 의 몫.
6. **누산기는 float64, 출력은 float32.** 그래서 "샘플 비트 동일" 만으로는 정렬이 사라진 구현을 잡지
   못하고, `rendered_clip_ids` / `renderedClipIds` 로 **순서 자체를 단정**한다.
7. **클립 이펙트 슬롯은 배선만 했다** — 이 항목은 4.3 이 채웠다. 아래 §6.3 참고.

---

## 6.3 4.3 이 남긴 것 (Req 29.31, 29.32, 2.12)

소유 조항은 **29.31, 29.32, 2.12 뿐이다.** 29.1–29.30·29.33–29.35 는 3.2, 28.1–28.23·28.30–28.39 는
4.1, 28.24–28.29 는 4.2 것이고 어느 것도 다시 구현하지 않았다.

### 6.3.1 파일

| 파일 | 내용 |
|---|---|
| `domain/timeline/clip-effects.ts` | **신규.** Req 29.31 의 단계 순서(`CLIP_EFFECT_STAGES`)와 Req 29.32 의 두 천장(`tailCeilingMs`), 믹스다운 정합성 검사(`clipEffectConsistency`), `clipsWithEffectChains` |
| `domain/timeline/project.ts` | `TimelineClip.effectChain: EffectChain \| null` 추가 + `TIMELINE_CLIP_FIELDS` + `clip_effect_chain_invalid` 검증 |
| `domain/timeline/project-printer.ts` | 문서에 `effectChain` (`chainToDocument` 경유, `null` 명시) |
| `domain/timeline/project-parser.ts` | `asChain()` — 없거나 `null` 이면 체인 없음, 잘못된 체인은 `clipViolations` 가 클립 인덱스와 함께 보고 |
| `domain/timeline/equivalence.ts` | `effectChain` 을 **Req 29.26 의 체인 동등 관계로** 비교 (`!==` 는 참조 비교라 틀린다) |
| `domain/timeline/commands.ts` | `AddClipRequest.effectChain`. 분할/복제는 스프레드로 상속 |
| `domain/timeline/mixdown.ts` | `MixdownPlan.effectChainClipIds`, `MixAssetMetadata.effectChainClipIds` |
| `services/timeline/credit-ports.ts` | **신규.** `MixdownCreditPort` — `Credit_Service` 의 좁은 뷰 3개 메서드 |
| `services/timeline/mixdown-renderer.ts` | 체인 전달, 정합성 검증, Req 2.12 크레딧 차감, `quoteProject()` |
| `services/timeline/mixdown-ports.ts` | `MixdownClipRequest.effectChain`(문서 형태), `MixdownRenderResult.clipEffectsApplied` |
| `dsp/src/musicstudio_dsp/clip_effects.py` | **신규.** `clip_effect_processor()` + 두 천장. `effects.apply_chain` 위의 배선일 뿐 |
| `dsp/src/musicstudio_dsp/mixdown.py` | `effect_processor` 를 실제로 호출, `MixdownResult.clip_effects_applied` 추가 |
| `dsp/src/musicstudio_dsp/worker.py` | `effect_chain` 파싱 + `effect_processor` **무조건** 주입 |
| `db/migrations/0016_timeline_clip_effect_chain.sql` | **신규.** `timeline_clip.effect_chain jsonb` + 1–16개 CHECK + 부분 인덱스 |
| `dsp/test/test_clip_effects.py` | **신규.** 테일 절단, 다음 클립 침범 없음, 프로세서 없는 체인 거절 |
| `dsp/test/test_mixdown.py` | **Property 13 에 `effect_processor` 케이스 2개 추가** (새 번호 아님) + 체인 생성기 |
| `dsp/test/test_worker.py` | 태스크 셸의 클립 이펙트 7건 (`effect_chain` 전달, 테일 절단, 3회 재현성) |
| `test/unit/timeline/clip-effects.test.ts` | **신규.** 두 천장, 정합성, 그리고 **Property 6 이 새 필드를 정말 비교하는지** |
| `test/support/timeline-harness.ts` | `validProject` 가 체인을 실제로 생성 (§6.3.3), `fakeMixdownCredit()` |

### 6.3.2 4.3 이 내린 결정 중 5.1 이후가 알아야 할 것

1. **`Effect_Chain` 필드는 `EffectChain | null` 이다. optional (`?`) 이 아니다.**
   `JSON.stringify` 는 `undefined` 값을 **생략**하므로, optional 이면 같은 상태의 클립이 두 가지
   문서로 인쇄될 수 있고 Req 28.33 의 바이트 동일이 경로에 의존하게 된다. `clipViolations` 는
   `undefined` 를 명시적으로 거절한다.
2. **빈 배열은 "체인 없음"이 아니다.** Req 29.13 의 하한이 1 이므로 `{items: []}` 는 거절된다.
   "체인 없음"의 표현은 `null` **하나뿐**이다 — 두 개면 Req 28.33 이 무너진다. 0016 의 CHECK 도 같다.
3. **테일 천장 10000 ms 는 새 숫자가 아니다.** 3.2 가 `domain/effects/registry.ts` 의
   `EFFECT_TAIL_ALLOWANCE_MS` 로 이미 선언했고(`effect_registry.json` 에 미러 + parity 테스트),
   4.3 은 **re-export 만** 한다. 분류는 **bound** 다(threshold 아님): 그 수를 바꾸면 이미 저장된 모든
   `Generation_Version` 의 허용 길이가 소급해서 바뀐다(Req 34.10 이 금지). 따라서
   `QUALITY_THRESHOLD_NAMES` 는 **손대지 않았고** `test/unit/bgm/threshold-set.test.ts` 도 그대로다.
4. **잘라냄은 프로세서가 아니라 `mixdown.py` 4단계가 한다.** 프로세서는 테일을 포함해 그대로 돌려준다.
   이유: 4단계는 체인이 없는 클립에도 돌고, Req 28.25 의 길이 산술이 그 단계에 의존한다. 두 곳에서
   자르면 Req 28.13 의 산술이 두 벌이 된다.
5. **`clip_effects_applied` 는 관측값이다.** `_clip_signal` 이 체인을 적용한 분기 *안에서* 플래그를
   돌려주며, 호출자가 `clip.effect_chain` 을 다시 보고 만들지 않는다. 체인을 흘린 렌더는 길이·형태·
   피크가 모두 그럴듯하므로 **보고된 집합만이 유일한 증거**다. `clipEffectConsistency` 가 양방향으로
   대조하고 불일치면 500 으로 거절한다(저장하지 않는다).
6. **함정: 믹스 버퍼 경계가 클립 절단 누락을 가린다.** `total_frames` 는 `start + play_length` 로
   계산되고 배치 시 `width = min(...)` 로 잘리므로, 맨 끝 클립 하나만 있으면 4단계를 지워도 믹스
   길이는 그대로다. 실제로 이걸 잡는 테스트는 `test_the_tail_does_not_bleed_over_the_next_clip`
   (뒤 클립 구간 침범)과 `test_the_tail_is_cut_before_the_fade_out`(마지막 샘플이 0) 두 개다.
   변이 테스트로 확인했다. 길이만 보는 테스트를 추가해도 이 회귀는 잡히지 않는다.
7. **크레딧은 렌더 *후에* 차감하고, 잔액은 렌더 *전에* 본다.**
   - 차감 길이는 `plan.lengthMs`(Req 28.25 가 정의한 렌더링 길이)이며 `result.durationMs` 가 아니다.
     후자는 프레임 반올림으로 최대 1프레임(48 kHz 에서 0.021 ms) 어긋나므로, 그걸로 값을 매기면
     같은 프로젝트의 두 렌더 가격이 부동소수점에 의존한다. 미리 보여준 견적과 실제 청구액도 같아진다.
   - 순서가 이렇게 된 유일한 이유는 **환급 경로를 새로 만들지 않기 위해서**다. 존재하지 않는 믹스에
     대해 청구된 적이 없으므로 되돌릴 것이 없다. 이 시스템의 환급 경로는 여전히
     `services/sound/job-quality-rejection.ts` **하나뿐**이다. 여기에 두 번째를 만들지 말 것.
   - Req 2.3 의 402 는 렌더 전에 `quote` + `usage` 로 낸다. 402 생성자는 `services/credit/errors.ts`
     의 것을 **import** 한다(같은 코드·같은 상태를 두 번 정의하지 않기 위해).
   - `credit` 은 **optional** 이고, 없으면 `outcome.charge === null` 이다. 조용한 0 이 아니라 `null`
     이므로 `Credit_Service` 배선을 잊은 컴포지션 루트가 결과에 드러난다.
8. **Req 2.12 를 위해 새로 만든 것은 없다.** `chargeMixdown`, `mix:musicstudio-mixdown` 단가 항목,
   `costOf` 는 전부 이미 있었다. 4.3 은 길이와 시점만 정했다.
9. **클립의 체인을 *바꾸는* 편집 명령은 없다.** Req 28.23 이 12개를 열거하고 design §6.4 의
   `EditCommandType` 이 그것을 미러하므로 13번째를 만들면 4.1 의 수용 기준이 거짓이 된다. 체인은
   `planAddClip` 또는 프로젝트 문서 가져오기로만 붙는다. **열린 질문**(§7 결함 16).
10. **소유 Property 는 없다.** §9.2 표에 4.3 행이 없다. 재현성 증거는 **Property 13 을 확장**해서
    만들었다(`dsp/test/test_mixdown.py` 의 `test_three_renders_with_clip_effects_are_sample_identical`
    과 `test_a_fresh_processor_per_render_gives_the_same_result`). 새 번호를 만들지 않았고, 나머지
    새 속성은 전부 `unnumbered` 라고 명시했다(`test/property/timeline-mixdown-plan.test.ts`).
11. **`pedalboard` 를 쓰는 새 테스트에는 모두 `requires_pedalboard` 가드가 붙어 있다**
    (`test_clip_effects.py`, `test_mixdown.py` 의 Property 13 확장 2건, `test_worker.py` 의 클립
    이펙트 4건). 이유와 붙이는 범위는 §3.1 에 있다. Property 13 의 **드라이 케이스는 가드가 없으므로
    속성 자체가 통째로 스킵되는 일은 없다** — 라이브러리가 없는 호스트에서도 28.27 은 계속 검증된다.

### 6.3.3 Property 6/7 이 새 필드를 정말 비교하는가 — 변이 테스트로 확인함

필드를 추가하면 왕복 속성이 **조용히 약해질** 수 있으므로 직접 확인했다.

| 변이 | Property 6 | Property 7 | 키 순서 속성(unnumbered) |
|---|---|---|---|
| 프린터가 체인을 버린다 (`effectChain: null`) | **실패** ✓ | 통과 | 통과 |
| 프린터가 `chainToDocument` 대신 스프레드 (`[...items]`) | 통과 | 통과 | **실패** ✓ |

- Property 6 은 체인 유실을 잡는다. `equivalence.ts` 가 `effectChain` 을 **체인 동등 관계**로 비교하기
  때문이다. `!==` 로 두면(객체 참조 비교) 파싱된 클립이 원본과 절대 같지 않아 **모든** 체인 포함
  프로젝트에서 실패하고, 반대로 필드를 건너뛰면 유실을 통과시킨다. 둘 다 테스트로 못박아 두었다
  (`clip-effects.test.ts` 의 마지막 describe).
- Property 7 은 두 변이 모두 못 잡는다 — 이는 **정상**이다. 7 은 재인쇄 안정성(바이트 동일)에 대한
  진술이고 원본 충실도에 대한 진술이 아니다. 그래서 키 순서 속성이 따로 있고, 4.3 은 그 속성의
  섞인 클립 객체에 **체인과 각 항목의 파라미터 키까지 역순으로** 넣어 강화했다.

---

## 6.4 다음 작업: 5.1 Library_Service

`_Requirements: 11.1–11.13, 13.1–13.2, 13.4–13.9_`, `_설계: §4.1_`.
**조항 소유는 배타적이다** — 위 조항만 구현한다.

### 5.1 이 반드시 알아야 할 것: 두 태스크가 5.1 을 기다리고 있다

**자산 메타데이터 저장 테이블이 아직 없고, 그것은 5.1 의 것이다.** 지금까지 두 곳이 임시로
포트 뒤에서 기다린다:

| 기다리는 것 | 어디에 | 무엇 때문에 |
|---|---|---|
| `MixdownAssetStore` (`services/timeline/mixdown-ports.ts`) | 4.2 + 4.3 | Req 28.28 의 감쇠량, Req 29.31 의 `effectChainClipIds` 등 `MixAssetMetadata` 11개 필드 |
| `DialogueRenditionStorePort` | 2.7 | 대사 행 타이밍 (`db/migrations/0012` 헤더 참고) |

`db/migrations/0015` 헤더가 "믹스다운 컬럼은 두지 않는다 — 자산은 0003, 계보는 0005" 라고 못박았고
`domain/timeline/mixdown.ts` 의 `MixAssetMetadata` 주석도 같은 말을 한다. **5.1 이 자산 메타데이터
테이블을 만들 때 이 두 포트의 구현을 함께 두는 것이 자연스럽다.** 만들지 않기로 한다면 두 헤더 주석을
갱신해 다음 담당자가 다시 기다리지 않게 할 것.

`MIX_METADATA_FIELDS` / `BGM_METADATA_FIELDS` 처럼 필드 목록을 상수로 두는 관례를 따르면
"타입에 필드를 추가하고 writer 에서 빠뜨리는" 사고가 타입 오류가 된다.

### 그 밖의 시작점

- **다음 빈 마이그레이션 번호는 `0017`.** 4.3 이 `0016` 을 썼다. parity 테스트는 존재 + 유일성 +
  gap-free 로만 검증한다(§4.3).
- `mix` 는 이미 `Asset_Kind` 6종 중 하나이고 단가표에도 있다(`services/credit/pricing-table.ts`).
  라이브러리 조회·다운로드가 `mix` 자산을 다루게 될 때 4.2/4.3 이 만든 자산이 그 대상이다.
- Req 13.x 의 다운로드 포맷 변환은 `dsp/src/musicstudio_dsp/pipeline.py` 의 `convert_for_download`
  와 워커의 `musicstudio_dsp.convert_for_download` 태스크가 이미 있다. 새로 만들지 말 것.
- 소프트 삭제(Req 11.x)는 `audio_asset.is_deleted` (0003) 이고, Req 28.36 의
  `timeline_clip_availability` 뷰가 이미 그것을 읽는다 — 타임라인은 삭제된 자산을 참조하는 프로젝트를
  **읽을 수 있어야** 하므로(28.36), 영구 삭제 경로를 만들 때 `timeline_clip.asset_id` 의
  `ON DELETE RESTRICT` 를 확인할 것.

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

### 4.3 이 발견한 것

16. **클립의 `Effect_Chain` 을 바꾸는 편집 조작이 없다.** Req 29.31 은 "Timeline_Clip에 Effect_Chain이
    지정된 경우" 를 전제하지만, 어떻게 지정되는지에 대한 조항이 Req 28 에도 Req 29 에도 없다.
    Req 28.23 의 12개 목록에는 없고, Req 29.14 는 `Audio_Asset` 의 `Generation_Version` 에 대한 것이라
    클립에는 적용되지 않는다.
    → `planAddClip` 의 선택적 필드와 프로젝트 문서 가져오기로만 붙게 했다. 13번째 편집 조작을 만들면
      Req 28.23 과 4.1 의 수용 기준("12개 편집 조작")이 거짓이 되므로 만들지 않았다. **확정이 필요하다** —
      UI 태스크 7.x 에서 "클립에 이펙트 걸기" 를 하려면 조항이 있어야 한다.
17. **Req 29.32 의 주체가 `Effects_Service` 인데 tasks.md 는 이 조항을 4.3 에 할당한다.**
    조항 본문은 `Generation_Version` 의 길이 불변식이고 그것은 3.2 가 이미 `lengthViolationFor` 로
    구현했다. 4.3 이 실제로 채운 것은 design §6.3 의 나머지 절반, 즉 "믹스다운 안에서는 보존하지
    않는다" 는 쪽이다.
    → 3.2 의 구현을 재사용하고 믹스다운 측 정책만 새로 썼다. 조항 문면과 태스크 배정이 어긋나 있으므로
      스펙 소유자의 확인이 있으면 좋다.
18. **Req 2.12 가 "렌더링 길이" 를 정의하지 않는다.** 계획된 길이(Req 28.25)와 산출된 길이는 최대
    1프레임 다르다.
    → Req 28.25 가 정의한 값(`plan.lengthMs`)으로 값을 매겼다. 근거는 §6.3.2 항목 7. **확정이 필요하다.**
19. **Req 2.12 에 실패 시 환급 조항이 없다.** Req 2.4 는 `Generation_Job` 실패에 대한 것이고 믹스다운
    내보내기는 `Generation_Job` 이 아니다.
    → 검증된 믹스가 저장된 *뒤에* 차감하도록 순서를 정해 환급이 필요한 상태를 만들지 않았다. 믹스다운을
      `Generation_Job` 으로 모델링하기로 한다면(9.1 의 비동기 API 가 그럴 수 있다) 그때는 기존 수명주기의
      `engine_failed` 전이를 쓸 것이고, 새 환급 경로는 그때도 만들지 않는다.
20. **분할 시 체인 처리 규칙이 없다** (Req 28.14 는 길이 합만 규정).
    → 양쪽 절반이 원본의 체인을 상속한다. 결과적으로 두 절반이 독립적으로 처리되므로 절단면을 넘던
      딜레이 테일은 더 이상 넘지 않는다. 이는 Req 29.31 의 per-clip 처리에서 따라오는 결과이고 모든
      클립 경계에서 이미 일어나는 일과 같다. **확정이 필요하다.**
21. **Req 19.6(직접 입력 자산 64개)이 이펙트 체인을 세지 않는다.** 클립 이펙트는 새 자산을 참조하지
    않으므로 계보에 영향이 없다 — 확인만 해 둔다. 문제 없음.

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
