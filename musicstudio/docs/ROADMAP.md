# MusicStudio 로드맵 — 규칙에서 돌아가는 시스템으로

작성 시점: 2026-08-11, 스펙 태스크 **1.0–9.3 완료** 직후.
스펙: `.kiro/specs/ai-music-generation-service/`.

이 문서가 답하는 질문은 하나입니다: **왜 배포된 데모에서 아무것도 실제로 일어나지 않는가, 그리고 무엇을 해야 일어나는가.**

---

## 1. 관측된 증상

배포본(<https://acestep-musicstudio-demo.vercel.app>)을 브라우저로 조작한 결과입니다. 화면은
전부 그려지고 콘솔 에러는 0건이며, **모든 버튼이 반응합니다**. 그런데 결과물이 없었습니다.

| 조작 | 화면 반응 | 실제 결과 | 트랙 A 이후 |
| --- | --- | --- | --- |
| 생성 요청 | 대기 순번 → 0% → 67% → 완료 (약 8초) | 아무것도 생성되지 않음. 타이머가 돌고 시드 자산을 반환 | 그대로 — 엔진이 붙어야 바뀝니다(트랙 B) |
| 재생 | 재생 시간이 흐르고 가사가 싱크됨 | **완전 무음.** `streamUrl`을 읽지도 않았고 오디오 요소도 없었음 | 실제 `<audio>`가 합성 톤을 재생 |
| 다운로드 MP3 | "준비됨 · 약 35MB" | 파일이 내려오지 않음 (download 이벤트 0건) | 실제 WAV 파일이 저장됨 |
| 다운로드 WAV/FLAC | "무손실은 상위 요금제" 거부 | 거부 규칙은 진짜, 받을 파일은 없음 | 거부는 그대로, 허용되면 파일이 옴 |
| 라이브러리 · 검색 · 공개 · 타임라인 | 전부 반응 | 메모리 안에서만. 새로고침하면 소멸 | 그대로(트랙 B) |

> **정정.** 이 표는 처음에 재생을 "`Math.sin`으로 합성한 톤"이라고 적었습니다. 틀렸습니다 —
> 그것은 `demo-api.ts`의 오래된 주석을 믿은 것이고, `Player.tsx`는 오디오 노드를 만든 적이
> 없습니다. 실제로는 무음이었고, 화면의 모든 표시는 벽시계에서 파생된 것이었습니다. 실제보다
> 후하게 적은 셈이라 남겨 둡니다.

배포 문제가 아닙니다. 배포본의 JS·CSS는 200으로 서빙되고 로컬 빌드와 산출물 해시가 같습니다.

**증상을 한 줄로**: 이 제품은 지금 *규칙*과 *그 규칙의 테스트*이지, 돌아가는 시스템이 아닙니다.

---

## 2. 진단 — 무엇이 있고 무엇이 없는가

있는 것은 진짜입니다. 없는 것은 전부 **바깥 세계와 닿는 지점**입니다.

### 있는 것

| 층 | 상태 |
| --- | --- |
| `domain/` | 순수 규칙. PBT 24개 Property가 설계 문서에서 감사되며 CI가 강제 |
| `services/` | 서비스 로직. 모든 포트가 주입식이라 테스트에서 완전히 구동됨 |
| `api/gateway/routes/` | 라우트 12종이 작성되어 있고 E2E 흐름 7개가 통과 |
| `db/migrations/` | 마이그레이션 18개. PostgreSQL 16에 실제로 적용되는 것을 CI가 확인 |
| `dsp/` | DSP 파이프라인, 워터마크, 라우드니스. pytest + hypothesis 통과 |
| `web/` | 화면 7종, 모션·사운드·a11y 게이트 통과 |

### 없는 것 — 각 항목은 저장소에서 확인 가능합니다

| 없는 것 | 확인 방법 |
| --- | --- |
| **SPA의 HTTP 클라이언트** | `grep -r "fetch(" web/src` → 0건. `StudioApi` 구현체는 `demo-api.ts` 하나뿐 |
| **게이트웨이 합성 루트** | `server.ts`의 `startGateway`가 `accountService` **하나만** 조립. generation·library·publicApi 등은 optional인 채 미주입 |
| **게이트웨이 기동 지점** | `grep -r "startGateway"` → 정의 1건, 호출 0건. `package.json`에 `start` 스크립트 없음 |
| **영속 어댑터** | 마이그레이션 18개를 읽는 코드가 스키마 대조 테스트뿐. `pg`로 만든 리포지토리 구현 0건 |
| **오브젝트 스토어** | 포트만 존재(`services/playback/ports.ts`). 구현 0건. `dsp/worker.py` 주석도 "There is no object store in the product layer yet" |
| **큐 워커 프로세스** | `bullmq-queue.ts`는 있으나 `new Worker(...)` 호출 0건. Celery 앱은 브로커에 연결되지 않은 채 생성 |
| **엔진 연결** | `ACE_Engine_Adapter`는 루트 저장소의 HTTP 라우트를 전사해 두었으나, base URL과 함께 생성하는 코드가 테스트 밖에 0건 |
| **인증 UI** | 게이트웨이는 JWT를 요구하는데 SPA에 로그인 화면이 없음 |

이것은 설계 실수가 아니라 **순서**입니다. 태스크 1–9는 규칙을 먼저 고정하고 어댑터를 뒤로
미루는 순서였고, 그 어댑터들이 아직 오지 않았습니다. 다만 그 결과가 "데모가 아무것도 하지
않는다"이므로, 지금부터의 작업은 규칙이 아니라 **접점**입니다.

---

## 3. 작업 트랙

### A. 데모가 거짓말하지 않게 — **완료**

- **A1. 데모 모드 배너.** 내비게이션 위, 건너뛰기 링크 다음. `api.backend.kind`를 읽으므로
  게이트웨이가 붙으면 저절로 사라지고, 빌드 플래그로 켜 둔 채 배포될 수 없습니다. 플레이어도
  트랜스포트 옆에서 같은 사실을 반복합니다.
- **A2. 다운로드가 실제 파일을 줍니다.** 포트에 `fetchDownload`가 생겼고, 판정(`planDownload`)
  과 분리되어 있습니다 — 거부는 제품의 답이고 전송 실패는 전송이라, 합치면 거부가 빈 `Blob`을
  들고 다니게 됩니다. `bytes`는 이제 추정이 아니라 전달될 파일의 실제 크기입니다.
- **A3. 재생이 소리를 냅니다** (조사 중 발견 — 무음이었습니다). `<audio>`가 붙었고 시계는 벽시계가
  아니라 요소의 `currentTime`을 따릅니다. 미디어를 못 여는 환경에서는 기존 인터벌이 대신 돕니다.

`demo-audio.ts` 하나가 재생과 다운로드 양쪽에 같은 바이트를 공급합니다 — 렌더러가 둘이면
미리듣기와 내려받은 파일이 어긋나고, 그 어긋남은 아무도 안 보는 곳에서 생깁니다. 톤은 자산
길이 전체를 렌더합니다(캡 없음): 캡을 두면 트랜스포트는 3:04인데 소리는 0:30에 끝나고, 그것이
바로 이 작업이 없애려던 종류의 결함입니다.

*검증*: Playwright로 배포 번들을 조작 — 배너 표시, `<audio>`가 blob 소스로 `duration=184`,
2.5초 재생 후 `currentTime=2.43`·`paused=false`, 다운로드가 8,114,444바이트 파일로 저장되고
헤더가 `RIFF`/`WAVE`. 회귀 테스트 12개가 세 가지 거짓 진술 각각에 대응합니다.

### B. 백엔드를 띄운다 (가장 큼)

- **B1. `pg` 리포지토리 구현.** 마이그레이션에 대응하는 저장소를 붙입니다.
  **순서는 §4가 정합니다** — 아래 두 개가 끝난 뒤, 나머지 저장소는 수직 슬라이스(§4.4)가
  먼저이고 그 뒤에 §4.5의 순서로 이어갑니다. 저장소를 수평으로 다 붙여도 곡은 나오지 않습니다.
  - **`account` — 완료.** `services/account/adapters/pg-account-repository.ts`. 이 트리에서 스키마를
    실제로 읽는 첫 어댑터입니다.
    - 붙이는 순간 **포트와 테이블이 다른 모양을 말하고 있었다는 것**이 드러났습니다: `0002`의
      `password_hash`가 `NOT NULL`이라 소셜 전용 계정(Req 1.7, `passwordHash: null`)을 담을 수
      없었고, `email_verified_at` 컬럼이 없었으며, 소셜 신원을 둘 곳이 아예 없었습니다.
      `0019_account_identity.sql`이 그 셋을 채웁니다.
    - **계약 테스트 하나를 두 구현에 돌립니다**(`test/integration/account-repository-contract.test.ts`).
      나머지 스위트 전체가 인메모리 더블에 대고 검증하므로, 더블과 테이블이 어긋나면 테스트는 전부
      통과하고 어긋남은 배포에서 드러납니다. 둘을 한 스위트에서 만나게 하는 것이 그것을 막는
      유일한 방법입니다.
    - `test:db`가 두 DB 파일을 **파일 병렬 없이** 돕니다. 같은 데이터베이스를 공유하므로 병렬로
      돌면 서로의 행을 지웁니다.
  - **`audio_asset` (LibraryAssetStore) — 완료.** `services/library/adapters/pg-asset-store.ts`.
    - 또 하나의 구멍: **`object_key` 컬럼이 없었습니다.** 테이블은 저장된 자산의 모든 것을
      기술하면서 그것을 저장된 것으로 만드는 하나 — 바이트의 주소 — 만 빠뜨리고 있었습니다.
      `0020_audio_asset_object_key.sql`이 채웁니다(11.8이 오디오를 지우고 행은 남기므로 nullable).
    - `stemSourceAssetId`는 컬럼이 아니라 **`lineage`에서 읽습니다**(`derivation_type='stem_split'`).
      파생은 lineage가 사는 곳이고, 컬럼을 두면 같은 질문에 두 답이 생깁니다.
    - **계약 테스트가 실제 버그를 잡았습니다.** 키셋 커서를 행 비교 `(값, id) < ($1, $2)`로 쓰면
      **id까지 내림차순**으로 취급합니다. 도메인은 값 내림차순 + id 오름차순이라, 재생 횟수가 같은
      자산 둘을 넘길 때 두 번째가 아니라 첫 번째가 다시 나왔습니다.
  - 남은 것: `generation_version` · `lineage` · `credit_ledger_entry` · `voice_*` · `timeline_*` ·
    `sound_pack` · `public_api` · `playlist`.
- **B2. 오브젝트 스토어 어댑터.** S3 호환(MinIO로 로컬). 포트에 대한 첫 구현이며, `dsp` 워커의
  base64 전송 스톱갭을 걷어내는 전제입니다.
- **B3. 합성 루트와 `npm start`.** `server.ts`가 전 서비스를 조립하도록 확장. 지금은 auth만.
- **B4. `docker-compose`.** PostgreSQL · Redis · MinIO · 게이트웨이 · BullMQ 워커 · Celery DSP 워커.
- **B5. 엔진 연결.** `ACE_Engine_Adapter`를 루트 저장소의 `run_api_server.sh`가 띄우는 엔진에
  연결. 주소는 `http://127.0.0.1:8001`(`ACESTEP_API_PORT`)이고, 어댑터는 이미 그 서버의 와이어
  계약대로 작성되어 있습니다 — `transport.ts`에 호스트가 없는 것은 누락이 아니라 설계이므로,
  이 작업은 클라이언트를 쓰는 일이 아니라 **base URL과 함께 생성하는 일**입니다.
- **B6. GPU당 동시성 1, 그리고 프리플라이트 VRAM 검사.** 아래 §6 참조. 큐 깊이가 아니라 VRAM이
  실제 제약이므로, 이것 없이는 큐가 GPU가 실행할 수 없는 작업을 받아들이고 실패가 타임아웃으로
  나타납니다 — 원인을 가리는 형태로.
- **B7. 진행률 폴백.** 엔진의 진행률은 Gradio 스타일 콜백이라 도착이 보장되지 않습니다. 이벤트가
  없으면 직전 생성 소요 시간을 기준으로 추정하되 **95%에서 멈추게** 합니다. 100%에 닿는 추정치는
  완료 신호와 구분되지 않습니다.

*검증*: `docker compose up` 후 `curl`로 회원가입 → 로그인 → 생성 요청 → 작업 완료 → 다운로드가
실제 오디오 바이트를 반환.

### C. SPA를 게이트웨이에 연결

- **C1. `StudioApi`의 HTTP 구현.** 이음매는 이미 있으므로 교체 지점은 `main.tsx` 한 줄입니다
  (`context.tsx`가 `api` prop을 받도록 이미 설계됨).
- **C2. 로그인 화면.** 게이트웨이의 JWT 흐름에 대응.
- **C3. 실제 오디오 스트리밍.** `Playback_Service`가 바이트 창을 계산하지만 줄 바이트가
  없습니다. Range 응답을 오브젝트 스토어에 연결.

*검증*: 같은 E2E 흐름 7개를 데모 백엔드가 아니라 HTTP 구현 위에서 통과.

### D. 남은 기능 구멍

- **D1. Requirement 17.10 웹훅 자동 트리거.** `Generation_Job`이 제출 API 키를 기록하지 않아
  오케스트레이터에 보낼 대상이 없습니다. 스키마 한 컬럼과 배선 하나.

### E. 배포

- **E1.** Vercel은 프런트만 담당합니다. 게이트웨이·워커는 컨테이너 호스팅이 별도로 필요합니다.
- **E2.** Vercel을 저장소에 정식 연결(Root Directory `musicstudio/web`)해 push마다 재배포.

---

## 4. 최단 경로 — 수직 슬라이스 (기획 보강, 2026-08-26)

B1을 두 저장소(account, audio_asset)까지 진행한 시점에서 다시 세웠습니다. 두 어댑터는 각각
스키마 구멍을 드러냈고 그 자체로 값어치가 있었지만, **"실제로 쓸 수 있고 기능이 동작하는"**
상태로 가는 순서는 아니었습니다. 저장소를 수평으로 전부 붙여도 곡은 나오지 않습니다 — 곡이
나오려면 **쓰기 경로 하나**가 끝까지 이어져야 하고, 그 경로 위에는 아직 존재하지 않는 조각이
셋 있습니다.

### 4.1 첫 곡 하나가 실제로 밟는 경로

```
가입 → 로그인 → POST /songs → Job_Orchestrator → 큐 → ACE_Engine(HTTP) → 오디오 bytes
  → normalise_for_storage(48kHz + 워터마크, DSP) → 오브젝트 스토어 PUT
  → audio_asset INSERT(+provenance) → 라이브러리 조회 → 재생(Range) / 다운로드
```

lineage는 이 경로 위에 **없습니다.** `audio_asset_require_lineage`(0006)는 `stem`·`mix`에만
걸리고, 새로 생성한 `song`은 lineage 행이 필요 없습니다. lineage·generation_version·voice·
timeline·sound_pack·playlist 어댑터는 슬라이스 **뒤**입니다(§4.5).

### 4.2 경로 위 조각의 현재 상태 — 전부 저장소에서 확인한 것

| 조각 | 상태 | 근거 |
| --- | --- | --- |
| account 영속 | **있음** | `pg-account-repository.ts` (PR #9) |
| 세션·로그인 제한 (Redis) | **있음** | `redis-session-store.ts`, `redis-login-attempt-store.ts` |
| Redis 클라이언트 | 부분 — `get/set/del`만 | `redis-client.ts`. 크레딧 스토어가 쓰는 `eval`이 없음 |
| 크레딧 잔액 (Redis, Lua) | **있음** — 배선만 없음 | `credit/adapters/redis-balance-store.ts` + `atomic-scripts.ts` |
| 크레딧 없이 돌리는 스위치 | **있음** | `freeChargePort` (`generation/ports.ts`) — v0 슬라이스용 |
| 엔진 HTTP 전송 | **있음** | `createAceHttpTransport({ baseUrl })` (`adapters/ace/transport.ts:81`) |
| 엔진 어댑터 | **있음** — 결과 bytes를 직접 내려받음 | `AceEngineAdapter`, `NormalizedGenerationResult.audioBuffer: Buffer` |
| 엔진 출력 샘플레이트 | 48 kHz 기본 | `acestep/inference.py:975` — 그래도 16.6 워터마크 때문에 DSP를 거쳐야 함 |
| 큐 어댑터 | **있음** — 핸들 주입식 | `bullmq-queue.ts`. **그런데 `bullmq`가 의존성에 없음** |
| Job 스토어 | 인메모리만 | `job-store.ts`. 설계 §2.4는 custody를 BullMQ에 둠 → 별도 pg 테이블 불필요 |
| **자산 발행 (`AssetPublicationPort`)** | **있음** (S3) | `generation/adapters/pg-asset-publication.ts`. 그전엔 유일한 구현이 `createRecordingAssetPublication`(테스트 더블) |
| **오브젝트 스토어 쓰기** | **포트 자체가 없음** | `AudioObjectPort`는 `head`/`read`뿐. 어디에도 `put`이 없음 |
| **TS → DSP 호출** | **없음** → S2가 HTTP 쪽을 채움 | Celery 태스크 11개는 있음(`worker.py`), TS 쪽 호출자 0건 — TS 클라이언트는 S3에서 |
| audio_asset INSERT | **있음** (S3) | 발행 포트가 쓴다. `pg-asset-store.ts`는 여전히 읽기·갱신만 — 쓰는 쪽과 읽는 쪽이 다른 포트인 것은 의도 |
| 합성 루트 | 없음 — 단, 템플릿은 있음 | `test/support/gateway-harness.ts`가 `buildGatewayApp`을 전 계층으로 조립 |
| `npm start` | 없음 | |
| SPA → 게이트웨이 | 없음 | `web/src`에 `fetch` 0건 |

### 4.3 새로 드러난 설계 공백 셋

수평 B1로는 절대 드러나지 않았을 것들입니다. 셋 다 "어댑터 하나 더"가 아니라 **없는 이음매**입니다.

**(1) `AssetPublicationPort`의 실제 구현.** 엔진 bytes를 받아 → DSP `normalise_for_storage`
(19.4 48 kHz, 16.6 워터마크, 버전 보고) → 오브젝트 스토어 PUT → `audio_asset` INSERT(33.7/33.14
provenance 필수, `object_key`) → 식별자 반환. 이 한 함수가 제품의 **저장 행위**이고, 워터마크가
"저장되면"에 붙는다는 16.6의 진술이 코드로 존재하는 유일한 장소가 됩니다.

**(2) 오브젝트 스토어 쓰기 포트.** `AudioObjectPort`에 `put(objectKey, bytes, contentType)`을
추가하고 첫 구현은 **로컬 파일시스템**으로 둡니다. 정직하고 작고, 같은 구현이 `head`/`read`도
채우므로 C3(Range 스트리밍)이 공짜로 따라옵니다. S3/MinIO는 배포(E)에서 교체 — 포트가 있으면
교체 지점은 한 곳입니다.

**(3) TS ↔ DSP 브리지.** 선택지 셋:
- (a) Node에서 Celery 프로토콜을 직접 말하기 — 메시지 포맷·결과 백엔드까지 재현해야 하고 깨지기 쉬움.
- (b) **`dsp/`에 얇은 HTTP 사이드카** — 표준 라이브러리 `http.server`(또는 FastAPI)로 같은 11개
  파이프라인 함수를 그대로 노출. `pipeline.py`는 손대지 않고, `worker.py`가 Celery 셸인 것과
  똑같이 HTTP 셸 하나가 더 생김. `claude-music`의 `server.py`가 같은 형태입니다. **권고.**
- (c) 요청마다 서브프로세스 — 임포트 콜드 스타트를 매번 냄.

(b)로 가면 `worker.py` 주석이 스톱갭이라 적어 둔 base64 전송을 **객체 키 전달**로 바꿀 자리도
같이 생깁니다 — 사이드카가 오브젝트 스토어를 직접 읽으면 되므로.

### 4.4 슬라이스 순서 — 각 단계에 "돌려서 확인하는 방법"이 있습니다

| 단계 | 내용 | 확인 |
| --- | --- | --- |
| **S1 — 완료** | `AudioObjectWritePort`(`put`·`remove`, 읽기 포트와 **분리** — 재생 서비스가 쓰기 권한을 들 이유가 없음) + `adapters/filesystem-object-store.ts`(head/read/put/remove, 원자적 쓰기, 사이드카에 content type, 루트 탈출 키 거부) | 계약 테스트 23건이 인메모리 더블과 파일시스템 양쪽에서 동일 통과. `end` 포함 경계, 오프셋을 식별하는 바이트, 범위 밖 거부, `../` 거부 |
| **S2 — 완료** | `dsp/src/musicstudio_dsp/sidecar.py` — 표준 라이브러리 `http.server`, 의존성 추가 0. 태스크별 코드 없이 **`POST /tasks/<이름>` → `celery_app.tasks[이름].run(**body)`** 하나로 11개 전부 디스패치. Celery 태스크 객체 **자체를 호출**하므로 두 셸이 표류할 수 없고, Celery에 등록하면 HTTP에도 저절로 노출. `GET /health`가 태스크 목록 반환(S5 컴포즈 헬스체크용). `python -m musicstudio_dsp.sidecar`, 기본 `127.0.0.1:8002` | 실제 소켓 왕복 13건: 같은 입력에 대해 HTTP 응답 == Celery `.run` 결과(**dict 동일성**), 22.05 kHz 입력 → 48 kHz + `watermark_version` + 선언된 `STORAGE_FORMAT`(FLAC) 헤더, Celery 내장 태스크 404, 인자 누락 400, 태스크 예외 500(예외명 포함), 비객체 본문 400, 256 MiB 초과 413(본문 읽기 전 거부) |
| **S3 — 완료** | `services/generation/adapters/pg-asset-publication.ts` — 결과마다 **정규화(S2) → 도메인 검증 → `put`(S1) → INSERT**. 바이트가 행보다 먼저: 행이 곧 "제품에 존재함"이고, 바이트가 아직 오는 중인 자산은 S1의 원자적 쓰기가 한 층 아래서 막는 그 상태라 한 층 위에서도 막음. INSERT 실패 시 방금 넣은 객체를 `remove` — 행 없는 객체는 11.8 스윕이 모르는 고아. provenance는 세 출처(엔진 라이선스 → `EngineLicensePort`, 33.14 쌍 → `provenanceFieldsFor(사이드카가 보고한 버전)`, 원본 샘플레이트 → DSP 보고)에서 조립해 `validateProvenance`로 전체 검증. 성공 결과만 발행(5.6). lineage는 **쓰지 않음** — `withEditLineage`가 감싼다. `adapters/dsp-http-client.ts`가 S2의 TS 쪽 절반(`createAceHttpTransport`와 같은 관례, 응답 필드 전부 타입 검사 — 33.7의 "한 번 쓰고 수정 없음"이므로 쓰기 전에 맞아야 함) | pg + **실제 파일시스템 스토어** + 스크립트된 DSP로 8건: 행의 `object_key`가 실제 객체(길이 일치)를 가리킴, provenance가 도메인·DB CHECK 모두 통과하고 `watermarkId`가 **보고된 버전**(3)을 기록, 잡 캡션에서 이름 파생·폴백, 실패 결과 건너뜀, 3채널이면 도메인 어휘(`channels_range`)로 거부하며 아무것도 쓰지 않음, INSERT 실패 시 객체 제거. 별도로 **실제 Python 사이드카 왕복 2건**(`MUSICSTUDIO_DSP_URL` 게이트): 22.05 kHz → 48 kHz + 워터마크 버전 + FLAC 헤더, 오류 봉투 → `DspTaskFailed`. **미완**: 사이드카 왕복은 S5 컴포즈 전까지 CI 밖(로컬 검증만) · 레지스트리 → `EngineLicensePort` 어댑터는 S5 · `isLoop`는 아직 항상 `false`(BGM 루프는 슬라이스 밖) |
| **S4 — 완료** | `redis-client.ts`의 `RedisConnection`이 `CreditRedisCommands`(`eval`·`incrby`)까지 포함 — 그 전에는 크레딧 스토어의 Lua 스크립트를 서버로 나를 수 있는 것이 트리에 **없었음**. 연결 하나가 계정 스토어와 크레딧 스토어 둘 다를 만족하므로 합성 루트는 클라이언트 하나만 연다. `freeRefundPort`를 `freeChargePort` 옆에 추가 — v0 슬라이스는 이 **쌍**으로 크레딧 없이 돌고, 실제 `CreditService`는 둘을 한꺼번에 대체. CI `database` 잡에 Redis 서비스 추가, `MUSICSTUDIO_REDIS_URL`로 게이트 | 계약 테스트 8건을 인프로세스 더블과 **실제 Redis 7** 양쪽에서 동일 통과: 최초 잔액 1회, 차감·0 착지·초과 거부, 미지 계정 = 0, 적립, 잡 슬롯 상한·해제·0 미만 없음, 계정 분리. 더블이 만들 수 없는 두 건 — 잔액 25에 동시 차감 40건 → **정확히 25건** 적용·15건 거부·잔액 0, 슬롯 상한 3에 동시 요청 12건 → 정확히 3건 — 가 "음수 불가"(2.3)를 페이크의 성질이 아닌 배포의 성질로 만든다. **미완**: `CreditService` 전체 배선은 `credit_ledger_entry`·`account_plan` pg 어댑터(§4.5 B1)가 있어야 하므로 슬라이스 밖 · Redis 서버 다운 시 `createRedisConnection`이 조용히 재시도하는 문제는 S5 헬스체크에서 다룸 |
| **S5** | 합성 루트 `api/gateway/main.ts` + `npm start` — `gateway-harness.ts`를 실물 어댑터로 치환. `bullmq` 의존성 추가, Worker 프로세스, 엔진 `baseUrl` | 프로세스가 뜨고 `/health` 응답 |
| **S6** | **엔드투엔드**: `docker compose up`(PostgreSQL·Redis·DSP 사이드카·게이트웨이·워커) + 로컬 ACE-Step | curl: 가입 → 로그인 → 생성 → 폴링 완료 → 다운로드가 `RIFF`/`WAVE` 헤더의 실제 오디오 |
| **S7** | C1 — `StudioApi` HTTP 구현, `main.tsx` 스위치. 데모 배너가 **저절로** 사라짐 | 브라우저에서 생성 → 실제 곡 재생 |

S6이 끝나는 순간이 "음악이 생성된다"가 참이 되는 순간입니다. 그 전까지의 모든 것은 준비입니다.

### 4.5 슬라이스 밖 — 순서대로

1. 남은 B1 저장소: `lineage`(편집·스템·믹스다운이 필요로 함) → `generation_version` →
   `credit_ledger_entry` → `voice_*` → `timeline_*` → `sound_pack` → `public_api` → `playlist`.
   각각 계정·자산 때처럼 **계약 테스트를 두 구현에** 돌리는 방식 그대로.
2. C2 로그인 화면, B6 VRAM 프리플라이트·동시성 1, B7 진행률 폴백, D1 웹훅 트리거.
3. E — Vercel git 연동, 백엔드 컨테이너 호스팅, S3 교체.

### 4.6 왜 순서를 바꾸는가 — 한 문단

수평 B1은 "포트와 테이블이 어긋난 곳"을 찾는 데는 최선의 방법이었고 실제로 넷을 찾았습니다.
하지만 저장소 열 개를 다 붙여도 **오브젝트 스토어에 쓰는 포트가 없다는 사실**은 드러나지
않았을 겁니다 — 그것은 저장소가 아니라 경로를 따라가야 보입니다. 이제부터는 경로를 따라갑니다.

---

## 5. 열려 있는 결정

- **데모를 유지할 것인가.** 실제 백엔드가 붙으면 `demo-api`는 두 번째 진실이 됩니다. 스크린샷용
  픽스처로 남길지, 지울지 정해야 합니다.
- **오브젝트 스토어 선택.** v0는 로컬 파일시스템으로 결정(§4.3 (2)) — 포트가 생기면 교체 지점이
  한 곳입니다. 배포 시 S3 / R2 / MinIO 중 선택은 아직 열려 있습니다.
- **DSP 브리지.** §4.3 (3)에서 HTTP 사이드카를 권고했습니다. Celery 워커를 유지할지, 사이드카로
  대체할지는 S2에서 실제로 붙여 본 뒤 결정합니다 — 둘 다 `pipeline.py` 위의 셸이라 파이프라인
  코드는 어느 쪽이든 그대로입니다.
- **엔진 호스팅.** GPU가 필요하므로 게이트웨이와 같은 곳에 둘 수 없습니다.

## 6. 선행 사례에서 가져온 것 — `AgriciDaniel/claude-music`

같은 엔진(ACE-Step 1.5) 위에 지어진 Claude Code 플러그인입니다. 서비스가 아니라 스킬 묶음이고,
단일 사용자·무인증·무DB·프로세스 하나 — 우리와 정반대 형태입니다. 참고 가치는 하나에 있습니다:
**저 프로젝트는 실제로 음악을 만듭니다**(저장소에 완성곡 4개가 들어 있습니다). 우리에게 없는 것이
정확히 그것이므로, 엔진에 닿는 부분만 취합니다.

### 우리 REST 선택을 검증해 줍니다

저쪽 `ARCHITECTURE.md` 첫 절이 Python API와 REST를 비교하고 Python API를 택합니다 — 스킬
사용자에게 서버 수명주기를 떠넘길 수 없다는 이유이고, 대가는 **호출마다 15~30초 콜드 스타트**
입니다. 같은 문서가 REST가 더 나은 경우로 "따뜻한 모델을 공유하는 멀티테넌트 배포"와
"브라우저 기반 대시보드"를 듭니다. 그게 우리입니다. 우리는 그 콜드 스타트를 피합니다.

### 실제 제약은 큐 깊이가 아니라 VRAM입니다 (→ B6)

저쪽 `JobRunner`는 락을 non-blocking으로 잡아 **동시에 한 건만** 돌리고, 여유 VRAM이 모자라면
시작 전에 거부하면서 **GPU를 붙잡고 있는 프로세스 이름까지** 알려줍니다. 우리 설계는 BullMQ 큐와
80% 경보(태스크 8.1)를 전제하는데, 그것은 큐가 길어지는 것을 보는 장치이지 GPU가 한 번에 하나만
할 수 있다는 사실을 아는 장치가 아닙니다.

### 진행률에는 폴백이 필요합니다 (→ B7)

저쪽은 진행률 이벤트가 없으면 직전 소요 시간 기반 추정치를 95% 상한으로 냅니다. 우리 SSE 경로는
엔진이 진행률을 보낸다고 가정합니다.

### 품질 프리셋이 엔진 파라미터로 내려가야 합니다

저쪽의 draft/standard/high/max가 `inference_steps`·`guidance_scale`·모델 선택으로 매핑됩니다.
우리 `Quality_Threshold_Set`(태스크 8.2)은 임계값은 들고 있지만 이 매핑은 아직 없습니다.

### 교차 확인이 찾아낸 것: caption은 512자입니다

저쪽이 caption을 512자에서 자르길래 우리 쪽을 확인했더니, **우리는 caption 길이를 아예 검증하지
않고 있었습니다** — Requirement 4는 길이·BPM·박자·키·배치·시드를 정하고 caption 길이는 말하지
않습니다. `acestep/inference.py`는 caption을 "< 512 characters"로 문서화하고, 초과분은 거부가
아니라 **토크나이저가 조용히 잘라냅니다.** 1,200자 캡션은 요청이 성공하고, 음악이 앞부분에만
답하고, 그 사실을 말해 주는 곳이 없습니다.

`SONG_CAPTION_MAX_LENGTH = 512`를 추가하고 Custom_Mode에서 검증합니다. Requirement 4.1이
가사를 **잘라내지 말라**고 요구하는 것과 같은 약속을, 옆 필드에 대해 유일하게 강제할 수 있는
지점 — 요청을 보내기 전 — 에서 지키는 것입니다.

`SONG_DESCRIPTION_MAX_LENGTH`(2,000)는 **건드리지 않았습니다.** 그것은 Simple_Mode의 설명이고
엔진에는 `sample_query`(LM 입력)로 갑니다 — caption과 다른 필드이며 엔진이 길이를 문서화하지
않습니다. 둘을 섞으면 제한이 없는 쪽을 조이고 제한이 있는 쪽을 열어 두게 됩니다.

### 가져오지 않은 것

단일 사용자·무인증·무DB, `~/.claude/skills` 심볼릭 링크 설치, JSON-over-stdout 계약. 우리 형태와
정반대이고, 저쪽 문서도 그 이유를 적어 두고 있습니다.

---

`HANDOFF.md`는 태스크 4.1 시점에 작성된 문서라 5–9를 "미착수"로 적고 있습니다. 시점 기록으로
남겨 두되 그 사실이 첫 줄에서 보이도록 배너를 달았습니다.
