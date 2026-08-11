# MusicStudio 인수인계서 (Handoff)

> **이 문서는 시점 기록입니다.** 아래 상태표는 태스크 4.1 시점의 것이고, 그 뒤로 4.2–9.3이
> 전부 들어왔습니다. 현재 상태와 다음에 할 일은 [`ROADMAP.md`](./ROADMAP.md)와
> [`../README.md`](../README.md)를 보십시오.

작성 시점: 태스크 **4.1 Timeline_Service** 완료 직후.
스펙: `.kiro/specs/ai-music-generation-service/` (requirements.md / design.md / tasks.md).

이 문서는 다음 담당자가 코드베이스를 다시 조사하지 않고 4.2로 넘어갈 수 있도록 하는 데 목적이 있다.

---

## 1. 지금 어디까지 되어 있는가

| Phase | 태스크 | 상태 |
|---|---|---|
| 1 | 1.0–1.5 Foundation (데이터 모델, 인프라, 엔진 추상화) | 완료 |
| 2 | 2.1–2.7 Core Generation (곡, BGM, SFX, 대사, V2A) | 완료 |
| 3 | 3.1–3.4 Audio Processing (DSP, 이펙트, 마스터링, 사운드 팩) | 완료 |
| 4 | **4.1 Timeline_Service** | **완료 (이번 작업)** |
| 4 | 4.2 Mixdown_Renderer | 미착수 — **다음 작업** |
| 4 | 4.3 클립 이펙트 및 타임라인 통합 | 미착수 |
| 5–9 | Library/재생/공유, 안전·라이선스, 프런트엔드, 관측성, 공개 API | 미착수 |
| 6 | 6.1, 6.2 (안전·동의 일부) | 완료 |

### 현재 테스트 기준선 (green)

```
cd musicstudio
export PATH="$HOME/.nvm/versions/node/v22.23.1/bin:$PATH"   # npm 은 기본 PATH 에 없다
npm run lint          # clean
npm run typecheck     # 0 errors
npm test              # 2666 passed | 20 skipped  (~43 s)
python3 dsp/scripts/check_import_boundary.py
dsp/.venv/bin/python -m pytest dsp/test   # 365 passed | 5 skipped  (~38 s)
```

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

## 6. 다음 작업: 4.2 Mixdown_Renderer

`_Requirements: 28.24–28.29_`, `_설계: §6.1–§6.3_`.

시작점:

1. **렌더링 대상은 새로 계산하지 않는다.** `domain/timeline/render-target.ts` 의 `renderTargetSet()` 이
   Req 28.19/28.20 을 이미 구현했다. 4.2 는 이것을 소비한다.
2. 클립별 DSP 체인 순서: 로드 → 트림 → 이펙트 → 잘라냄 → 게인 → 페이드 → 배치 (design §5.6).
3. 합산은 **클립 ID 순으로 정렬**한 뒤 더한다 — Req 28.26 의 가환성(Property 12)이 이것에 달려 있다.
   `render-target.ts` 는 프로젝트 순서를 보존하므로 정렬은 4.2 가 한다.
4. 피크 정규화: `max_abs > 1.0` 이면 단일 감쇠 계수로 0.99–1.0 로 맞추고 감쇠량(dB)을 응답과
   `mix` Audio_Asset 메타데이터에 기록(Req 28.28).
5. 결정성: 단일 스레드 BLAS 강제, 부동소수점 연산 순서 고정 (Req 28.27, Property 13).
6. 빈 대상 거부: Req 28.29 — 프로젝트 상태를 바꾸지 않고 사유 코드 반환.
7. 소유 Property: **12(가환성), 13(재현성)**. 새 번호를 만들지 않는다.
8. 길이 계산 Req 28.25 는 4.2 것이다. 제외된 클립을 길이에 포함하지 않는다.

Python DSP 쪽이 필요하면 `dsp/src/musicstudio_dsp/` 에 있고, `dsp/.venv/bin/python -m pytest dsp/test` 로 돈다.

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
