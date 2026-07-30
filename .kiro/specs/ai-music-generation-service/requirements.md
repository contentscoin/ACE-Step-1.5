# Requirements Document

## Introduction

Suno AI와 동등한 수준의 AI 음악 생성 서비스에서 출발하여, **곡(song) · 배경음악(BGM) · 효과음(SFX) · 대사(dialogue)** 를 한 제품 안에서 만들고 하나의 타임라인에 올려 완성 오디오로 내보내는 **멀티모달 AI 오디오 스튜디오**(제품 계층)를 구축한다. 이 서비스는 이미 이 저장소에 존재하는 ACE-Step 1.5 생성 엔진(`acestep/api/http/*` HTTP API, `acestep/acestep_v15_pipeline.py` 파이프라인, LoRA 학습 라우트, 작업 큐)을 **재구현하지 않고 곡·BGM 계열의 백엔드 생성 엔진으로 활용**하며, 효과음·대사·전사·음성 변환 계열은 **교체 가능한 외부/로컬 엔진을 어댑터로 연결**한다.

제품 계층이 담당하는 범위는 다음과 같다.

- 다중 사용자 계정, 인증, 크레딧/쿼터 과금
- 텍스트 설명 한 줄만으로 완성곡을 만드는 Simple 모드와, 캡션·가사·음악 메타데이터를 직접 제어하는 Custom 모드
- 커버/리믹스, 부분 리페인트, 곡 확장, 스템 분리, 레이어 추가 등 편집 워크플로
- 가사 작성 보조, 가사 구조 파싱/출력, LRC 타임스탬프 생성
- 장면·분위기 기반 배경음악 생성과 이음이 연결되는 루프 자산 생성
- 텍스트 프롬프트 기반 효과음 생성, 영상 기반 폴리 효과음 생성, UI 사운드 팩 저작
- 스크립트 기반 대사 생성, 보이스 프로필과 음성 복제, 음성 변환, 음성 인식과 타이밍 정렬
- 멀티트랙 타임라인 프로젝트(Scene/Mix 편집기)와 결정적 믹스다운 내보내기
- 비파괴 이펙트 체인과 버전 관리, AI 보조 믹싱·마스터링
- 개인 라이브러리, 재생, 다운로드, 공개 공유 및 탐색 피드
- 개인 스타일 학습(LoRA 기반 페르소나)
- 콘텐츠 안전, AI 생성 표기, 엔진별 라이선스와 상업적 사용 준수, 운영 모니터링, 개발자 공개 API
- Amicro 마이크로 인터랙션 라이브러리를 사용한 디자인·모션 계층과 UI SFX 기반 인터페이스 사운드 계층

엔진과 참조 구현이 이미 제공하는 능력(비동기 작업 큐, `task_type` 6종, 메타데이터 자동 보완, 다국어 보컬, 배치 생성, 품질 스코어링, LoRA 학습, 48kHz 오디오 코덱, 텍스트-오디오 정렬 모델, 증류 모델 등급, JSON 직렬화 이펙트 체인, 밀리초 단위 타임라인 모델, 78개 의미 큐 택소노미, 스프링 모션 프리셋)은 요구사항의 **검증 가능한 상한/하한 값**의 근거로 사용한다. 근거가 없는 수치는 제품 결정으로 확정하고 문서 마지막의 부록에 열거한다.

## Glossary

- **MusicStudio**: 사용자를 향한 AI 오디오 스튜디오 서비스 전체. 아래 하위 시스템의 집합.
- **ACE_Engine**: 이 저장소에 이미 존재하는 ACE-Step 1.5 생성 엔진. `POST /release_task`, `POST /query_result`, `GET /v1/audio`, `POST /format_input`, `GET /v1/models`, `GET /v1/stats`, `POST /v1/training/start` 엔드포인트를 제공한다.
- **Account_Service**: 회원 가입, 로그인, 세션 및 사용자 프로필을 관리하는 하위 시스템.
- **Credit_Service**: 크레딧 잔액, 차감, 환급, 요금제별 월간 쿼터를 관리하는 하위 시스템.
- **Generation_Gateway**: 제품 계층의 생성 요청을 대상 엔진의 요청 파라미터로 변환하고 응답을 정규화하는 어댑터 계층.
- **Job_Orchestrator**: 생성 작업(Generation_Job)의 등록, 상태 폴링, 재시도, 완료 처리를 담당하는 하위 시스템.
- **Generation_Job**: 사용자의 한 번의 생성 요청 단위. 대상 엔진의 작업 식별자 1개와 1:1로 매핑되며 1개 이상의 Audio_Asset을 산출한다.
- **Audio_Asset**: 생성 또는 업로드가 완료된 오디오 1개와 그 메타데이터(캡션, 가사, BPM, 키, 박자, 길이, 시드, 사용 엔진, 출처 정보)를 묶은 저장 단위.
- **Asset_Kind**: Audio_Asset의 종류. `song`, `bgm`, `sfx`, `dialogue`, `stem`, `mix` 중 정확히 하나.
- **Track**: Asset_Kind가 `song`인 Audio_Asset을 가리키는 기존 명칭. 이 문서에서 Track에 대한 모든 요구사항은 동일한 Audio_Asset 저장 단위에 적용된다.
- **Simple_Mode**: 자연어 설명 1건만 입력받아 캡션·가사·메타데이터를 ACE_Engine의 LM이 생성하도록 하는 생성 모드(`sample_mode=true`).
- **Custom_Mode**: 사용자가 캡션, 가사, 음악 메타데이터를 직접 지정하는 생성 모드.
- **Edit_Task**: 원본 오디오를 입력으로 하는 편집 작업. `cover`, `repaint`, `extract`, `lego`, `complete` 중 하나의 `task_type`에 대응한다.
- **Lyrics_Assistant**: 사용자 입력 가사와 캡션을 LM으로 보강·정형화하는 하위 시스템. ACE_Engine의 `POST /format_input`을 사용한다.
- **Lyrics_Parser**: `[Verse]`, `[Chorus]` 등 구조 태그가 포함된 가사 평문을 Lyrics_Document 구조체로 변환하는 구성요소.
- **Lyrics_Printer**: Lyrics_Document를 구조 태그가 포함된 가사 평문으로 변환하는 구성요소.
- **Lyrics_Document**: 순서가 있는 섹션 목록. 각 섹션은 섹션 종류(예: Verse, Chorus, Bridge, Instrumental)와 행 목록을 가진다.
- **LRC_Parser**: LRC 형식 텍스트를 Timed_Lyrics 구조체로 변환하는 구성요소.
- **LRC_Printer**: Timed_Lyrics를 LRC 형식 텍스트로 변환하는 구성요소.
- **Timed_Lyrics**: 밀리초 단위 타임스탬프와 가사 행의 쌍을 시간 오름차순으로 담은 구조체.
- **Library_Service**: 사용자별 Audio_Asset 목록의 조회, 검색, 정렬, 이름 변경, 삭제, 복원을 담당하는 하위 시스템.
- **Playback_Service**: Audio_Asset 오디오의 스트리밍 재생과 재생 위치 제어를 담당하는 하위 시스템.
- **Sharing_Service**: Audio_Asset의 공개 여부, 공개 링크, 탐색 피드, 좋아요를 담당하는 하위 시스템.
- **Persona_Service**: 사용자가 업로드한 참조 곡으로 LoRA 어댑터를 학습하고 생성 시 적용하는 하위 시스템. ACE_Engine의 학습 API를 사용한다.
- **Moderation_Service**: 입력 텍스트, 스크립트, 업로드 오디오와 영상에 대한 콘텐츠 정책 검사 및 차단을 담당하는 하위 시스템.
- **Public_API**: 외부 개발자가 API 키로 호출하는 MusicStudio의 HTTP 인터페이스.
- **Admin_Console**: 운영자가 큐 상태, 작업 통계, 사용량, 엔진 상태를 조회하는 관리 인터페이스.
- **Audit_Log**: 크레딧 변동, 공개 상태 변경, 삭제, 정책 차단, 동의 기록, 라이선스 변경 사건을 기록하는 추가 전용(append-only) 기록.
- **Provider_Registry**: 사용 가능한 생성 엔진의 목록과 능력 기술서, 상태, 쿼터, 라이선스를 관리하는 하위 시스템.
- **Engine_Descriptor**: 하나의 생성 엔진에 대한 능력 기술서. 엔진 식별자, 지원 Asset_Kind, 지원 입력 양식, 최대 출력 길이, 샘플레이트, 실행 위치, License_Descriptor를 포함한다.
- **Engine_Adapter**: 정규화된 MusicStudio 생성 요청을 특정 엔진의 호출 규약으로 변환하고 응답을 Audio_Asset 형식으로 되돌리는 구성요소.
- **License_Descriptor**: 하나의 엔진 또는 자산 출처에 대한 라이선스 기술서. 코드 라이선스 식별자, 가중치 라이선스 식별자, 상업적 사용 허용 여부, 요구 저작자 표시 문구, 라이선스 원문 링크를 포함한다.
- **BGM_Service**: 분위기·장면·악기 구성 프롬프트로 Asset_Kind가 `bgm`인 Audio_Asset을 생성하는 하위 시스템.
- **SFX_Service**: 텍스트 프롬프트로 Asset_Kind가 `sfx`인 Audio_Asset을 생성하는 하위 시스템.
- **V2A_Service**: 업로드된 영상의 시각 이벤트에 정렬된 효과음과 앰비언스를 생성하는 하위 시스템.
- **Visual_Event_Timeline**: 검출된 시각 이벤트의 시각·신뢰도·범주를 시각 오름차순으로 담은 구조체.
- **Sound_Pack_Service**: Semantic_Cue 택소노미 전체를 채우는 Sound_Pack을 생성·검증·내보내는 하위 시스템.
- **Semantic_Cue**: 상호작용 결과를 뜻으로 지칭하는 사운드 큐 이름(예: `success`, `drop`, `loading`). 13개 범주에 걸쳐 78개가 정의된다.
- **Sound_Pack**: 78개 Semantic_Cue 전체에 대한 오디오를 하나의 음향 성격으로 갖춘 묶음.
- **Cue_Pack_Manifest**: Sound_Pack의 각 큐에 대한 파일 경로, 바이트 크기, 오디오 길이, 채널 수, 루프 여부, 기본 음량, 큐 이름, 범주 이름, 팩 이름을 담은 기계 판독 가능 문서.
- **Manifest_Parser**: Cue_Pack_Manifest 파일을 Cue_Pack_Manifest 구조체로 변환하는 구성요소.
- **Manifest_Printer**: Cue_Pack_Manifest 구조체를 Cue_Pack_Manifest 파일로 변환하는 구성요소.
- **Speech_Service**: 스크립트 텍스트와 Voice_Profile로 Asset_Kind가 `dialogue`인 Audio_Asset을 생성하는 하위 시스템.
- **Voice_Service**: Voice_Profile의 등록, 복제, 카탈로그 제공, 공유, 삭제, 음성 변환을 담당하는 하위 시스템.
- **Voice_Profile**: 저장된 음성 1개. 참조 샘플로 복제한 `cloned` 유형과 엔진 내장 음성을 가리키는 `preset` 유형을 가진다. 화자의 동의 철회가 접수된 프로필은 **사용 중지 상태**로 전환되며, 이 상태에서는 프로필 자체와 참조 샘플이 보존되지만 대사 생성과 음성 변환의 입력으로 사용할 수 없다.
- **Voice_Consent_Record**: 복제 대상 음성에 대한 권리 보유와 금지 용도 미사용을 확약한 동의 기록.
- **Transcription_Service**: 오디오를 텍스트와 행 단위 타이밍으로 변환하는 하위 시스템.
- **Timeline_Service**: Timeline_Project와 Timeline_Clip의 생성, 이동, 트리밍, 분할, 되돌리기를 담당하는 하위 시스템.
- **Timeline_Project**: 여러 Audio_Asset을 트랙과 시각에 배치한 편집 프로젝트.
- **Timeline_Clip**: Timeline_Project 안에서 하나의 Audio_Asset을 참조하는 배치 단위. `start_time_ms`, `track`, `trim_start_ms`, `trim_end_ms`, 게인, 페이드, 음소거 여부를 가진다.
- **Mixdown_Renderer**: Timeline_Project의 모든 Timeline_Clip을 합산하여 단일 오디오를 산출하는 구성요소.
- **렌더링 대상 클립 집합**: 솔로 상태와 음소거 상태를 적용한 후 Mixdown_Renderer가 실제로 합산하는 Timeline_Clip의 집합.
- **프로젝트 동등 관계**: Requirement 28에 정의된, 두 Timeline_Project가 동등한지 판정하는 비교 규칙.
- **Project_Parser**: JSON 프로젝트 문서를 Timeline_Project로 변환하는 구성요소.
- **Project_Printer**: Timeline_Project를 JSON 프로젝트 문서로 변환하는 구성요소.
- **Effects_Service**: Effect_Chain의 검증, 적용, 버전 관리, 프리셋 관리를 담당하는 하위 시스템.
- **Effect_Chain**: 순서가 있는 이펙트 구성 목록. JSON 배열로 직렬화된다.
- **Chain_Parser**: JSON 문서를 Effect_Chain으로 변환하는 구성요소.
- **Chain_Printer**: Effect_Chain을 JSON 문서로 변환하는 구성요소.
- **체인 동등 관계**: Requirement 29에 정의된, 두 Effect_Chain이 동등한지 판정하는 비교 규칙.
- **Effect_Preset**: 재사용을 위해 저장된 Effect_Chain. 내장 프리셋과 사용자 프리셋으로 구분된다.
- **Generation_Version**: 하나의 Audio_Asset에 대해 특정 Effect_Chain이 적용된 산출 버전. 이펙트가 적용되지 않은 원본 버전을 항상 포함한다.
- **Mastering_Assistant**: 오디오를 분석하여 사용자가 조회·수정할 수 있는 이펙트 파라미터를 제안하고, 라우드니스 정규화·대사 정리·자동 감쇠를 수행하는 하위 시스템.
- **라우드니스 측정 규약**: Requirement 30에 정의된, 통합 라우드니스와 트루 피크의 측정 방법.
- **발화 구간**: Requirement 30에 정의된 RMS 임계 기준으로 판정된 대사 오디오의 구간.
- **UI_Sound_Layer**: MusicStudio 자체 인터페이스의 사운드 재생을 담당하는 클라이언트 구성요소.
- **Amicro_Motion_Preset**: Amicro 라이브러리가 정의한 스프링 전환 프리셋. `snappy`, `bouncy`, `smooth`, `gentle`, `stiff` 5개.
- **Motion_Classification_Table**: 모션이 적용된 각 구성요소의 애니메이션을 상태 전달 목적과 장식 목적 중 하나로 분류한 표.
- **사용 목적**: 다운로드 또는 내보내기 요청에 기록되는 `commercial` 또는 `non_commercial` 값.
- **조상 자산**: 어떤 Audio_Asset의 계보 정보를 따라 거슬러 올라가 도달하는 모든 입력 Audio_Asset.

## Requirements

### Requirement 1: 계정 및 인증

**User Story:** 사용자로서 나는 계정을 만들고 로그인하고 싶다. 그래서 내가 만든 곡과 크레딧이 내 것으로 유지되기를 원한다.

#### Acceptance Criteria

1. WHEN 사용자가 이메일과 비밀번호로 가입을 요청하면, THE Account_Service SHALL 해당 이메일의 계정을 생성하고 이메일 인증 링크를 발송한다
2. IF 가입 요청의 이메일이 이미 등록된 계정과 일치하면, THEN THE Account_Service SHALL HTTP 409 상태 코드와 중복 사유를 반환한다
3. WHEN 사용자가 올바른 자격 증명으로 로그인하면, THE Account_Service SHALL 유효 기간 24시간의 액세스 토큰과 유효 기간 30일의 갱신 토큰을 발급한다
4. IF 로그인 요청의 비밀번호가 저장된 자격 증명과 일치하지 않으면, THEN THE Account_Service SHALL HTTP 401 상태 코드를 반환하고 실패 횟수를 1 증가시킨다
5. WHILE 동일 계정의 연속 로그인 실패 횟수가 5회 이상인 상태에서, THE Account_Service SHALL 해당 계정의 로그인 시도를 15분간 거부한다
6. THE Account_Service SHALL 비밀번호를 작업 인수 12 이상의 단방향 해시 형태로만 저장한다
7. WHERE 소셜 로그인 제공자(Google, Apple)가 설정된 경우, THE Account_Service SHALL 해당 제공자의 OAuth 2.0 인증 코드 플로로 로그인을 처리한다
8. WHEN 액세스 토큰의 유효 기간이 만료된 후 API 요청이 도착하면, THE Account_Service SHALL HTTP 401 상태 코드와 토큰 만료 사유 코드를 반환한다

### Requirement 2: 크레딧 및 사용량 쿼터

**User Story:** 서비스 운영자로서 나는 생성 요청마다 크레딧을 차감하고 싶다. 그래서 GPU 비용을 사용량과 연동해 관리할 수 있다.

#### Acceptance Criteria

1. WHEN 계정이 신규 생성되면, THE Credit_Service SHALL 해당 계정에 무료 요금제의 초기 크레딧을 부여한다
2. WHEN 사용자가 Generation_Job 생성을 요청하면, THE Credit_Service SHALL 요청된 `batch_size`와 생성 길이에 대응하는 크레딧을 잔액에서 차감하고 Audit_Log에 차감 기록을 추가한다
3. IF 요청 시점의 크레딧 잔액이 필요 크레딧보다 적으면, THEN THE Credit_Service SHALL 요청을 거부하고 HTTP 402 상태 코드와 부족 크레딧 수량을 반환한다
4. WHEN Generation_Job이 실패 상태로 종료되면, THE Credit_Service SHALL 해당 작업에 차감된 크레딧 전액을 잔액에 환급하고 Audit_Log에 환급 기록을 추가한다
5. THE Credit_Service SHALL 각 요금제에 대해 월간 최대 Generation_Job 수와 동시 진행 Generation_Job 수의 상한을 적용한다
6. IF 사용자의 진행 중 Generation_Job 수가 요금제의 동시 진행 상한과 같으면, THEN THE Credit_Service SHALL 신규 요청을 거부하고 HTTP 429 상태 코드와 현재 진행 중 작업 수를 반환한다
7. WHEN 사용자가 사용량 조회를 요청하면, THE Credit_Service SHALL 현재 잔액, 당월 사용 크레딧, 당월 남은 Generation_Job 수를 반환한다
8. WHEN 요금제의 결제 주기가 갱신되면, THE Credit_Service SHALL 해당 요금제의 월간 크레딧을 잔액에 추가하고 월간 사용량 집계를 0으로 초기화한다
9. THE Credit_Service SHALL Asset_Kind 6종과 Engine_Descriptor 조합별 크레딧 단가 항목을 담은 단가표를 보유한다
10. WHEN 사용자가 특정 Asset_Kind의 Generation_Job을 요청하면, THE Credit_Service SHALL 해당 Asset_Kind와 선택된 엔진의 단가 항목에 요청 길이와 산출 개수를 반영한 크레딧을 차감한다
11. IF 요청된 Asset_Kind와 엔진 조합이 단가표에 존재하지 않으면, THEN THE Credit_Service SHALL 요청을 거부하고 HTTP 400 상태 코드와 미등록 조합 식별자를 반환한다
12. WHEN 사용자가 Timeline_Project의 믹스다운 내보내기를 요청하면, THE Credit_Service SHALL 믹스다운 단가 항목에 렌더링 길이를 반영한 크레딧을 차감한다
13. WHEN 사용자가 Sound_Pack 생성을 요청하면, THE Credit_Service SHALL 78개 큐 생성에 대응하는 크레딧을 단일 차감 기록으로 차감한다
14. THE Credit_Service SHALL 각 요금제에 대해 Asset_Kind별 월간 최대 생성 개수 상한을 적용한다

### Requirement 3: Simple 모드 곡 생성

**User Story:** 음악 지식이 없는 사용자로서 나는 한 줄 설명만으로 완성곡을 얻고 싶다. 그래서 별도 학습 없이 바로 음악을 만들 수 있다.

#### Acceptance Criteria

1. WHEN 사용자가 자연어 설명과 함께 Simple_Mode 생성을 요청하면, THE Generation_Gateway SHALL ACE_Engine에 `sample_mode=true`와 해당 설명을 `sample_query`로 전달한다
2. THE Generation_Gateway SHALL Simple_Mode 요청에 대해 `thinking=true`를 기본값으로 전달한다
3. WHEN Simple_Mode 요청에 곡 길이가 지정되지 않으면, THE Generation_Gateway SHALL 길이 필드를 비워 전달하여 ACE_Engine이 길이를 결정하도록 한다
4. WHEN Simple_Mode Generation_Job이 성공 상태로 종료되면, THE Job_Orchestrator SHALL ACE_Engine이 최종 사용한 캡션, 가사, BPM, 키, 박자, 길이를 Track 메타데이터로 저장한다
5. IF Simple_Mode 요청의 설명 길이가 1자 미만 또는 2000자 초과이면, THEN THE Generation_Gateway SHALL 요청을 거부하고 허용 길이 범위를 포함한 오류를 반환한다
6. WHERE 사용자가 무작위 생성을 선택한 경우, THE Generation_Gateway SHALL 설명 없이 무작위 샘플 파라미터로 Generation_Job을 생성한다
7. WHEN 사용자가 보컬 언어를 지정하면, THE Generation_Gateway SHALL ACE_Engine이 지원하는 50개 언어 코드 중 해당 코드를 `vocal_language`로 전달한다
8. IF 요청된 보컬 언어 코드가 ACE_Engine 지원 언어 목록에 없으면, THEN THE Generation_Gateway SHALL 요청을 거부하고 지원 언어 목록을 반환한다

### Requirement 4: Custom 모드 곡 생성

**User Story:** 창작자로서 나는 캡션, 가사, BPM, 키, 박자, 길이를 직접 지정하고 싶다. 그래서 의도한 편곡에 가까운 결과를 얻을 수 있다.

#### Acceptance Criteria

1. WHEN 사용자가 캡션과 가사를 지정하여 Custom_Mode 생성을 요청하면, THE Generation_Gateway SHALL 입력된 가사 전문을 잘라내지 않고 ACE_Engine의 `lyrics` 파라미터로 전달한다
2. THE Generation_Gateway SHALL 곡 길이 입력을 10초 이상 600초 이하 범위로 검증한다
3. THE Generation_Gateway SHALL BPM 입력을 30 이상 300 이하 정수 범위로 검증한다
4. THE Generation_Gateway SHALL 박자 입력을 2, 3, 4, 6 중 하나로 검증한다
5. THE Generation_Gateway SHALL 키 입력을 ACE_Engine이 허용하는 70개 키·스케일 조합 중 하나로 검증한다
6. IF 곡 길이, BPM, 박자, 키 중 하나가 허용 범위를 벗어나면, THEN THE Generation_Gateway SHALL 요청을 거부하고 위반된 필드 이름과 허용 범위를 반환한다
7. WHEN Custom_Mode 요청에서 BPM, 키, 박자, 길이 중 일부가 비어 있으면, THE Generation_Gateway SHALL 비어 있는 필드만 ACE_Engine의 메타데이터 자동 보완으로 채우고 사용자가 입력한 값은 그대로 유지한다
8. WHEN 사용자가 한 요청에서 생성할 곡 수를 지정하면, THE Generation_Gateway SHALL 1 이상 8 이하 범위로 검증한 후 `batch_size`로 전달한다
9. WHERE 사용자가 인스트루멘털 곡을 선택한 경우, THE Generation_Gateway SHALL 가사 필드에 인스트루멘털 지시자를 전달한다
10. WHEN 사용자가 시드 값을 지정하면, THE Generation_Gateway SHALL `use_random_seed=false`와 해당 시드를 전달하여 동일 입력에 대해 동일 오디오가 재현되도록 한다

### Requirement 5: 생성 작업 수명주기 및 진행 상태

**User Story:** 사용자로서 나는 생성 진행 상황을 실시간으로 보고 싶다. 그래서 얼마나 기다려야 하는지 알 수 있다.

#### Acceptance Criteria

1. WHEN Generation_Job 요청이 접수되면, THE Job_Orchestrator SHALL 대상 엔진에서 반환된 작업 식별자를 저장하고 사용자에게 작업 식별자와 큐 대기 순번을 반환한다
2. WHILE Generation_Job이 대기 또는 진행 상태인 동안, THE Job_Orchestrator SHALL 대상 엔진의 작업 상태를 5초 이하 간격으로 조회하여 진행 상태를 갱신한다
3. THE Job_Orchestrator SHALL ACE_Engine의 상태 코드 0을 진행 중, 1을 성공, 2를 실패로 변환하여 사용자에게 제공한다
4. WHEN Generation_Job의 상태가 변경되면, THE Job_Orchestrator SHALL 해당 사용자의 열린 클라이언트 연결로 변경된 상태를 1초 이내에 전송한다
5. WHILE Generation_Job이 대기 상태인 동안, THE Job_Orchestrator SHALL 큐 대기 순번과 대상 엔진이 보고한 평균 작업 소요 시간을 근거로 계산한 예상 완료 시간을 제공한다
6. WHEN Generation_Job이 성공 상태로 종료되면, THE Job_Orchestrator SHALL 결과 오디오 개수만큼 Audio_Asset을 생성하여 요청자의 라이브러리에 저장한다
7. WHEN 사용자가 대기 상태의 Generation_Job 취소를 요청하면, THE Job_Orchestrator SHALL 해당 작업을 취소 상태로 전환하고 차감된 크레딧을 환급한다
8. IF Generation_Job이 접수 후 900초 이내에 성공 또는 실패로 종료되지 않으면, THEN THE Job_Orchestrator SHALL 해당 작업을 시간 초과 실패로 전환하고 크레딧을 환급한다

### Requirement 6: 생성 실패 처리 및 재시도

**User Story:** 사용자로서 나는 생성이 실패했을 때 이유를 알고 다시 시도하고 싶다. 그래서 크레딧을 잃지 않고 결과를 얻을 수 있다.

#### Acceptance Criteria

1. IF 대상 엔진이 Generation_Job에 대해 실패 상태를 반환하면, THEN THE Job_Orchestrator SHALL 사용자에게 실패 사유 분류(입력 오류, 엔진 오류, 자원 부족)와 재시도 가능 여부를 반환한다
2. IF 대상 엔진이 큐 포화로 HTTP 429를 반환하면, THEN THE Job_Orchestrator SHALL 지수 백오프로 최대 3회까지 재요청하고 각 시도 간 대기 시간을 2초 이상으로 유지한다
3. IF 대상 엔진에 대한 3회 재요청이 모두 실패하면, THEN THE Job_Orchestrator SHALL 작업을 실패로 확정하고 크레딧을 환급하며 실패 사건을 Audit_Log에 기록한다
4. WHEN 사용자가 실패한 Generation_Job의 재시도를 요청하면, THE Job_Orchestrator SHALL 원본 요청과 동일한 입력 파라미터로 새 Generation_Job을 생성한다
5. IF 대상 엔진에 대한 연결이 실패하면, THEN THE Job_Orchestrator SHALL 해당 작업을 대기 상태로 유지하고 60초 이내에 상태 조회를 재개한다
6. WHILE 요청된 Asset_Kind를 지원하는 모든 엔진의 상태 점검 응답이 정상이 아닌 동안, THE MusicStudio SHALL 해당 Asset_Kind의 신규 Generation_Job 접수를 거부하고 서비스 점검 안내를 반환한다

### Requirement 7: 편집 작업(커버, 리페인트, 확장, 스템 추출, 레이어 추가)

**User Story:** 창작자로서 나는 기존 오디오를 리믹스하고 특정 구간만 다시 만들고 싶다. 그래서 완성곡을 처음부터 다시 만들지 않고 다듬을 수 있다.

#### Acceptance Criteria

1. WHEN 사용자가 원본 오디오와 새 스타일을 지정하여 커버 생성을 요청하면, THE Generation_Gateway SHALL `task_type=cover`와 해당 오디오를 ACE_Engine에 전달한다
2. WHEN 사용자가 커버 강도를 지정하면, THE Generation_Gateway SHALL 해당 값을 0.0 이상 1.0 이하 범위로 검증한 후 `audio_cover_strength`로 전달한다
3. WHEN 사용자가 구간 시작 시각과 종료 시각을 지정하여 리페인트를 요청하면, THE Generation_Gateway SHALL `task_type=repaint`와 해당 시각을 `repainting_start` 및 `repainting_end`로 전달한다
4. IF 리페인트 구간의 시작 시각이 종료 시각보다 크거나 같으면, THEN THE Generation_Gateway SHALL 요청을 거부하고 구간 순서 위반 사유를 반환한다
5. IF 리페인트 구간의 종료 시각이 원본 오디오 길이를 초과하면, THEN THE Generation_Gateway SHALL 종료 시각을 원본 오디오 길이로 조정하고 조정 사실을 응답에 포함한다
6. WHEN 사용자가 스템 추출을 요청하면, THE Generation_Gateway SHALL `task_type=extract`와 ACE_Engine이 지원하는 12개 트랙 종류 중 선택된 트랙 이름을 전달한다
7. WHEN 사용자가 레이어 추가를 요청하면, THE Generation_Gateway SHALL `task_type=lego`와 추가할 트랙 이름을 전달한다
8. WHEN 사용자가 부분 오디오의 곡 확장을 요청하면, THE Generation_Gateway SHALL `task_type=complete`와 해당 오디오를 전달한다
9. IF 요청된 Edit_Task가 현재 선택된 DiT 모델이 지원하지 않는 종류이면, THEN THE Generation_Gateway SHALL 해당 작업을 지원하는 모델 목록을 포함한 오류를 반환한다
10. THE Generation_Gateway SHALL 업로드된 원본 오디오의 형식을 mp3, wav, flac 중 하나로, 길이를 600초 이하로, 파일 크기를 50MB 이하로 검증한다
11. IF 업로드된 원본 오디오가 형식, 길이, 크기 검증 중 하나를 통과하지 못하면, THEN THE Generation_Gateway SHALL 업로드를 거부하고 위반된 제약과 허용값을 반환한다
12. WHEN Edit_Task로 생성된 Audio_Asset이 저장되면, THE Library_Service SHALL 해당 자산에 원본 자산 식별자와 편집 종류를 계보 정보로 함께 저장한다

### Requirement 8: 가사 작성 보조

**User Story:** 작사에 익숙하지 않은 사용자로서 나는 초안 가사를 정형화하고 보강받고 싶다. 그래서 구조가 갖춰진 가사로 곡을 만들 수 있다.

#### Acceptance Criteria

1. WHEN 사용자가 초안 캡션과 초안 가사에 대해 보강을 요청하면, THE Lyrics_Assistant SHALL ACE_Engine의 형식화 엔드포인트를 호출하여 보강된 캡션, 보강된 가사, BPM, 키, 박자, 길이, 보컬 언어를 반환한다
2. WHEN 보강 결과가 반환되면, THE Lyrics_Assistant SHALL 원본 입력과 보강 결과를 함께 제시하고 사용자가 어느 쪽을 생성에 사용할지 선택하도록 요구한다
3. WHERE 사용자가 주제어만 제공한 경우, THE Lyrics_Assistant SHALL 구조 태그가 포함된 가사 초안을 생성한다
4. THE Lyrics_Assistant SHALL 생성한 가사 초안에 Verse 섹션과 Chorus 섹션을 각각 1개 이상 포함한다
5. IF 보강 요청이 ACE_Engine 오류로 실패하면, THEN THE Lyrics_Assistant SHALL 사용자의 원본 입력을 변경 없이 유지하고 보강 실패 사유를 반환한다
6. WHEN 가사 보강 요청이 처리되면, THE Credit_Service SHALL 요청자의 크레딧 잔액을 변경 없이 유지한다

### Requirement 9: 가사 구조 파서 및 프린터

**User Story:** 개발자로서 나는 가사 구조 태그를 안정적으로 파싱하고 다시 출력하고 싶다. 그래서 섹션 단위 편집과 표시가 데이터 손실 없이 동작한다.

#### Acceptance Criteria

1. WHEN 구조 태그가 포함된 가사 평문이 입력되면, THE Lyrics_Parser SHALL 해당 평문을 순서가 보존된 Lyrics_Document로 변환한다
2. THE Lyrics_Parser SHALL Verse, Pre-Chorus, Chorus, Bridge, Intro, Outro, Instrumental 섹션 종류를 인식한다
3. WHEN 첫 구조 태그보다 앞에 가사 행이 존재하면, THE Lyrics_Parser SHALL 해당 행들을 종류가 지정되지 않은 선행 섹션으로 보존한다
4. IF 입력 가사에 인식되지 않는 대괄호 태그가 포함되면, THEN THE Lyrics_Parser SHALL 해당 태그를 사용자 정의 섹션 종류로 보존하고 경고 메시지를 반환한다
5. THE Lyrics_Printer SHALL Lyrics_Document를 구조 태그가 포함된 가사 평문으로 변환한다
6. FOR ALL 유효한 Lyrics_Document에 대해, THE MusicStudio SHALL 출력 후 재파싱한 결과가 원본 Lyrics_Document와 동등함을 보장한다(왕복 속성)
7. FOR ALL 파싱에 성공한 가사 평문에 대해, THE MusicStudio SHALL 파싱 후 출력한 평문을 다시 파싱한 결과가 첫 파싱 결과와 동등함을 보장한다(멱등 속성)
8. THE Lyrics_Parser SHALL 파싱 결과 Lyrics_Document의 전체 가사 행 개수를 입력 평문의 비어 있지 않은 비태그 행 개수와 동일하게 유지한다(불변식)

### Requirement 10: LRC 타임스탬프 가사 생성 및 직렬화

**User Story:** 사용자로서 나는 생성된 곡의 가사 타임스탬프를 얻고 싶다. 그래서 가사 싱크 재생과 영상 제작에 사용할 수 있다.

#### Acceptance Criteria

1. WHEN 보컬이 포함된 Track의 생성이 완료되면, THE MusicStudio SHALL 해당 Track의 Timed_Lyrics를 생성하여 Track과 함께 저장한다
2. THE LRC_Printer SHALL Timed_Lyrics를 `[mm:ss.xx]` 형식의 타임스탬프를 가진 LRC 텍스트로 변환한다
3. THE LRC_Parser SHALL LRC 텍스트를 Timed_Lyrics로 변환한다
4. FOR ALL 유효한 Timed_Lyrics에 대해, THE MusicStudio SHALL LRC로 출력한 후 재파싱한 결과가 원본 Timed_Lyrics와 10밀리초 이내의 오차로 동등함을 보장한다(왕복 속성)
5. THE LRC_Parser SHALL 파싱 결과의 타임스탬프를 시간 오름차순으로 정렬된 상태로 유지한다(불변식)
6. IF LRC 텍스트에 형식이 올바르지 않은 타임스탬프 행이 포함되면, THEN THE LRC_Parser SHALL 해당 행의 줄 번호와 위반 내용을 포함한 오류를 반환한다
7. THE MusicStudio SHALL 모든 Timed_Lyrics 타임스탬프를 0 이상 해당 Track 길이 이하 범위로 유지한다(불변식)
8. WHEN 사용자가 Timed_Lyrics 다운로드를 요청하면, THE MusicStudio SHALL LRC 형식 파일을 반환한다
9. WHERE 뮤직비디오 생성 기능이 활성화된 경우, THE MusicStudio SHALL Track 오디오와 Timed_Lyrics를 사용하여 가사가 동기화된 영상 파일을 생성한다

### Requirement 11: 라이브러리 관리

**User Story:** 사용자로서 나는 내가 만든 곡을 찾고 정리하고 싶다. 그래서 결과물이 늘어나도 원하는 곡을 다시 찾을 수 있다.

#### Acceptance Criteria

1. WHEN 사용자가 라이브러리 조회를 요청하면, THE Library_Service SHALL 요청자가 소유한 Audio_Asset만 생성 시각 내림차순으로 반환한다
2. THE Library_Service SHALL 라이브러리 조회 응답을 페이지당 최대 50건으로 분할하고 다음 페이지 커서를 함께 반환한다
3. WHEN 사용자가 검색어를 입력하면, THE Library_Service SHALL 제목, 캡션, 가사, 태그에 해당 검색어가 포함된 Audio_Asset을 반환한다
4. WHEN 사용자가 정렬 기준을 지정하면, THE Library_Service SHALL 생성 시각, 제목, 재생 횟수 중 지정된 기준으로 정렬한 결과를 반환한다
5. WHEN 사용자가 Audio_Asset의 제목 변경을 요청하면, THE Library_Service SHALL 해당 자산의 제목을 갱신하고 갱신된 자산을 반환한다
6. WHEN 사용자가 Audio_Asset 삭제를 요청하면, THE Library_Service SHALL 해당 자산을 삭제 표시 상태로 전환하고 삭제 사건을 Audit_Log에 기록한다
7. WHILE Audio_Asset이 삭제 표시 상태인 동안, THE Library_Service SHALL 해당 자산을 라이브러리 조회 결과와 공개 피드에서 제외한다
8. WHEN 삭제 표시 상태의 Audio_Asset이 30일을 경과하면, THE Library_Service SHALL 해당 자산의 오디오 파일과 메타데이터를 영구 삭제한다
9. IF 사용자가 자신이 소유하지 않은 Audio_Asset에 대해 변경 또는 삭제를 요청하면, THEN THE Library_Service SHALL HTTP 403 상태 코드를 반환한다
10. WHEN 사용자가 플레이리스트 생성과 Audio_Asset 추가를 요청하면, THE Library_Service SHALL 사용자가 지정한 순서를 보존한 플레이리스트를 저장한다
11. THE Library_Service SHALL Asset_Kind가 `song`, `bgm`, `sfx`, `dialogue`, `stem`, `mix` 중 어느 값이든 동일한 조회, 검색, 정렬, 이름 변경, 삭제, 복원 동작을 제공한다
12. WHEN 사용자가 Asset_Kind로 라이브러리 필터링을 요청하면, THE Library_Service SHALL 지정된 Asset_Kind의 Audio_Asset만 반환한다
13. WHEN 사용자가 Sound_Pack 단위 조회를 요청하면, THE Library_Service SHALL 해당 Sound_Pack에 속한 Audio_Asset을 큐 이름 오름차순으로 반환한다

### Requirement 12: 재생 및 스트리밍

**User Story:** 사용자로서 나는 생성된 곡을 바로 들어보고 싶다. 그래서 다운로드하지 않고도 결과를 확인할 수 있다.

#### Acceptance Criteria

1. WHEN 사용자가 Audio_Asset 재생을 요청하면, THE Playback_Service SHALL 해당 자산의 오디오 스트림을 반환한다
2. THE Playback_Service SHALL 오디오 스트리밍 요청에 대해 HTTP Range 요청을 지원하여 임의 위치부터의 재생을 허용한다
3. WHEN 사용자가 재생 위치를 이동하면, THE Playback_Service SHALL 해당 위치부터의 오디오 데이터를 1초 이내에 전송 시작한다
4. WHEN Audio_Asset 재생이 시작되면, THE Playback_Service SHALL 해당 자산의 재생 횟수를 1 증가시킨다
5. WHILE Timed_Lyrics가 존재하는 Audio_Asset이 재생되는 동안, THE Playback_Service SHALL 현재 재생 위치에 대응하는 가사 행을 표시한다
6. THE Playback_Service SHALL 비공개 Audio_Asset의 오디오 스트림 접근을 소유자의 유효한 세션에만 허용한다
7. WHEN 사용자가 Audio_Asset의 파형 표시를 요청하면, THE Playback_Service SHALL 해당 자산의 파형 데이터를 반환한다
8. THE Playback_Service SHALL Asset_Kind 6종 모두에 대해 스트리밍, 구간 이동, 파형 데이터 제공을 동일하게 지원한다
9. WHERE Audio_Asset이 루프 자산으로 표시된 경우, THE Playback_Service SHALL 재생 종료 지점에서 시작 지점으로 이어지는 반복 재생을 제공한다

### Requirement 13: 다운로드 및 오디오 포맷

**User Story:** 사용자로서 나는 완성곡을 원하는 포맷으로 내려받고 싶다. 그래서 다른 편집 도구나 배포 채널에서 사용할 수 있다.

#### Acceptance Criteria

1. WHEN 사용자가 Audio_Asset 다운로드를 요청하면, THE Library_Service SHALL 해당 자산의 오디오 파일을 첨부 파일로 반환한다
2. THE Library_Service SHALL 다운로드 포맷으로 mp3, wav, flac을 제공한다
3. WHEN 사용자가 생성 시 저장된 포맷과 다른 다운로드 포맷을 요청하면, THE Library_Service SHALL 요청된 포맷으로 변환한 파일을 반환한다
4. WHERE 요금제가 무손실 다운로드를 포함하지 않는 경우, THE Library_Service SHALL wav 및 flac 다운로드 요청을 거부하고 필요한 요금제를 반환한다
5. WHEN 사용자가 스템 추출로 생성된 Audio_Asset들의 일괄 다운로드를 요청하면, THE Library_Service SHALL 해당 자산들을 하나의 압축 파일로 묶어 반환한다
6. THE Library_Service SHALL 다운로드 파일 이름에 자산 제목과 자산 식별자를 포함한다
7. THE Library_Service SHALL 다운로드되는 오디오 파일의 메타데이터 태그에 AI 생성 표기를 포함한다
8. THE Library_Service SHALL Asset_Kind 6종 모두에 대해 동일한 다운로드 및 포맷 변환 동작을 제공한다
9. THE Library_Service SHALL Asset_Kind가 `sfx`인 Audio_Asset의 다운로드 포맷으로 mp3, wav, flac, ogg를 제공한다
10. THE Library_Service SHALL 모든 다운로드 오디오 파일을 48000Hz 샘플레이트로 반환한다

### Requirement 14: 공유 및 탐색

**User Story:** 사용자로서 나는 만든 곡을 다른 사람에게 공개하고 다른 사람의 곡을 둘러보고 싶다. 그래서 창작물이 확산되고 영감을 얻을 수 있다.

#### Acceptance Criteria

1. THE Sharing_Service SHALL 새로 생성된 모든 Audio_Asset의 공개 상태를 비공개로 설정한다
2. WHEN 사용자가 Audio_Asset의 공개를 요청하면, THE Sharing_Service SHALL 해당 자산에 추측이 어려운 공개 링크를 발급하고 공개 상태 변경을 Audit_Log에 기록한다
3. WHEN 인증되지 않은 방문자가 유효한 공개 링크에 접근하면, THE Sharing_Service SHALL 자산 제목, 캡션, 오디오 재생, AI 생성 표기를 제공한다
4. WHEN 사용자가 Audio_Asset의 공개 철회를 요청하면, THE Sharing_Service SHALL 해당 공개 링크의 접근에 대해 HTTP 404 상태 코드를 반환한다
5. WHEN 방문자가 탐색 피드를 요청하면, THE Sharing_Service SHALL 공개 상태이며 삭제 표시되지 않은 Audio_Asset만 반환한다
6. WHEN 사용자가 장르, 태그, 또는 Asset_Kind로 탐색 피드를 필터링하면, THE Sharing_Service SHALL 해당 조건을 만족하는 공개 Audio_Asset만 반환한다
7. WHEN 인증된 사용자가 공개 Audio_Asset에 좋아요를 표시하면, THE Sharing_Service SHALL 사용자와 자산 조합에 대해 좋아요를 1건만 유지한다(멱등 속성)
8. WHEN 사용자가 이미 좋아요를 표시한 Audio_Asset에 좋아요를 다시 요청하면, THE Sharing_Service SHALL 좋아요 수를 변경하지 않고 현재 상태를 반환한다
9. WHERE 원격 리믹스가 허용된 공개 Audio_Asset인 경우, THE Sharing_Service SHALL 다른 사용자가 해당 자산을 원본으로 하는 Edit_Task를 생성하도록 허용한다
10. THE Sharing_Service SHALL Asset_Kind 6종 모두에 대해 동일한 공개, 공개 철회, 탐색 피드 노출, 좋아요 동작을 제공한다
11. WHERE 소유자가 Sound_Pack 공개를 허용한 경우, THE Sharing_Service SHALL 해당 Sound_Pack의 78개 큐를 하나의 공개 항목으로 노출한다

### Requirement 15: 개인 스타일 페르소나

**User Story:** 창작자로서 나는 내 목소리와 스타일을 학습시켜 재사용하고 싶다. 그래서 일관된 스타일의 곡을 계속 만들 수 있다.

#### Acceptance Criteria

1. WHEN 사용자가 참조 곡 8개 이상을 업로드하고 페르소나 학습을 요청하면, THE Persona_Service SHALL ACE_Engine의 학습 API로 LoRA 학습 작업을 시작하고 학습 작업 식별자를 반환한다
2. IF 페르소나 학습 요청의 참조 곡 개수가 8개 미만이면, THEN THE Persona_Service SHALL 요청을 거부하고 최소 필요 개수를 반환한다
3. WHILE 페르소나 학습이 진행 중인 동안, THE Persona_Service SHALL 현재 학습 단계와 진행률을 사용자에게 제공한다
4. WHEN 페르소나 학습이 성공적으로 완료되면, THE Persona_Service SHALL 학습된 어댑터를 요청자 전용 페르소나로 등록한다
5. WHEN 사용자가 생성 요청에 페르소나를 지정하면, THE Generation_Gateway SHALL 해당 페르소나의 어댑터를 적용하여 ACE_Engine에 요청한다
6. IF 사용자가 자신이 소유하지 않은 페르소나를 지정하면, THEN THE Generation_Gateway SHALL 요청을 거부하고 HTTP 403 상태 코드를 반환한다
7. WHEN 사용자가 페르소나 삭제를 요청하면, THE Persona_Service SHALL 해당 어댑터를 삭제하고 이후 생성 요청에서 해당 페르소나를 선택 불가로 처리한다
8. THE Persona_Service SHALL 페르소나 학습에 사용된 참조 곡에 대해 업로더가 권리를 보유함을 확인하는 동의 기록을 저장한다

### Requirement 16: 콘텐츠 안전 및 AI 생성 표기

**User Story:** 서비스 운영자로서 나는 정책 위반 콘텐츠 생성을 차단하고 AI 생성물을 명시하고 싶다. 그래서 법적·윤리적 위험을 줄일 수 있다.

#### Acceptance Criteria

1. WHEN 생성 요청이 접수되면, THE Moderation_Service SHALL 캡션, 가사, 자연어 설명을 콘텐츠 정책 기준으로 검사한다
2. IF 입력 텍스트가 콘텐츠 정책을 위반하면, THEN THE Moderation_Service SHALL 생성 요청을 차단하고 위반 분류를 반환하며 크레딧을 차감하지 않는다
3. IF 입력 텍스트에 실존 아티스트의 이름이 스타일 지정 목적으로 포함되면, THEN THE Moderation_Service SHALL 해당 이름을 스타일 서술 표현으로 대체하고 대체 사실을 사용자에게 알린다
4. WHEN 사용자가 편집용 오디오를 업로드하면, THE Moderation_Service SHALL 업로더가 해당 오디오에 대한 권리를 보유함을 확인하는 동의를 요구한다
5. THE MusicStudio SHALL 모든 Audio_Asset의 상세 화면과 공개 페이지에 AI 생성 표기를 표시한다
6. WHEN Audio_Asset 오디오가 저장되면, THE MusicStudio SHALL 해당 오디오에 AI 생성 여부를 식별할 수 있는 워터마크 정보를 포함한다
7. WHEN 정책 위반으로 요청이 차단되면, THE Moderation_Service SHALL 차단 사건을 Audit_Log에 기록한다
8. WHEN 방문자가 공개 Audio_Asset에 대해 신고를 제출하면, THE Moderation_Service SHALL 신고를 접수하고 해당 자산을 검토 대기 상태로 표시한다
9. WHILE Audio_Asset이 검토 대기 상태인 동안, THE Sharing_Service SHALL 해당 자산을 탐색 피드에서 제외한다
10. WHEN 사용자가 대사 생성용 스크립트를 제출하면, THE Moderation_Service SHALL 해당 스크립트를 콘텐츠 정책 기준으로 검사한다
11. IF 대사 스크립트가 실존 인물을 사칭하는 발화를 포함하면, THEN THE Moderation_Service SHALL 생성 요청을 차단하고 사칭 금지 분류를 반환하며 크레딧을 차감하지 않는다
12. WHEN 보이스 클로닝용 참조 샘플이 업로드되면, THE Moderation_Service SHALL 해당 요청에 대응하는 Voice_Consent_Record의 존재를 확인한다
13. THE MusicStudio SHALL Asset_Kind가 `dialogue`인 Audio_Asset의 상세 화면과 공개 페이지에 합성 음성임을 명시하는 표기를 표시한다
14. WHEN 사용자가 폴리 생성용 영상을 업로드하면, THE Moderation_Service SHALL 업로더가 해당 영상에 대한 권리를 보유함을 확인하는 동의를 요구한다

### Requirement 17: 개발자 공개 API

**User Story:** 외부 개발자로서 나는 API로 곡 생성을 호출하고 싶다. 그래서 내 애플리케이션에 음악 생성을 통합할 수 있다.

#### Acceptance Criteria

1. WHEN 사용자가 API 키 발급을 요청하면, THE Public_API SHALL 새 API 키를 발급하고 발급 시점에 한 번만 평문으로 노출한다
2. THE Public_API SHALL 발급된 API 키를 단방향 해시 형태로만 저장한다
3. WHEN Public_API 요청이 도착하면, THE Public_API SHALL Authorization 헤더의 Bearer 토큰으로 API 키를 검증한다
4. IF Public_API 요청의 API 키가 유효하지 않거나 누락되면, THEN THE Public_API SHALL HTTP 401 상태 코드를 반환한다
5. WHEN 유효한 Public_API 생성 요청이 접수되면, THE Public_API SHALL 작업 식별자를 즉시 반환하고 생성을 비동기로 처리한다
6. THE Public_API SHALL 작업 상태 조회, 결과 오디오 다운로드, 잔여 크레딧 조회 엔드포인트를 제공한다
7. THE Public_API SHALL API 키별 분당 요청 수 상한을 적용한다
8. IF API 키별 분당 요청 수 상한을 초과하면, THEN THE Public_API SHALL HTTP 429 상태 코드와 재시도 가능 시각을 반환한다
9. WHEN 사용자가 API 키 폐기를 요청하면, THE Public_API SHALL 해당 키의 이후 요청을 HTTP 401로 거부한다
10. WHERE 웹훅 URL이 등록된 경우, THE Public_API SHALL Generation_Job이 종료될 때 해당 URL로 작업 결과를 전송한다
11. THE Public_API SHALL `song`, `bgm`, `sfx`, `dialogue` 생성과 Timeline_Project 믹스다운 내보내기에 대해 각각 별도의 생성 엔드포인트를 제공한다
12. WHEN Public_API 생성 요청에 엔진 식별자가 포함되면, THE Public_API SHALL 해당 엔진 식별자를 Generation_Gateway로 전달한다
13. THE Public_API SHALL 사용 가능한 Engine_Descriptor 목록과 각 엔진의 License_Descriptor를 조회하는 엔드포인트를 제공한다
14. WHERE 웹훅 URL이 등록된 경우, THE Public_API SHALL 믹스다운 내보내기 작업이 종료될 때 해당 URL로 Asset_Kind와 작업 결과를 전송한다
15. THE Public_API SHALL Timeline_Project 조회, 생성, Timeline_Clip 배치, 믹스다운 내보내기 엔드포인트를 제공한다
16. THE Public_API SHALL 전사 요청과 전사 결과 조회 엔드포인트를 제공한다

### Requirement 18: 운영 모니터링 및 감사

**User Story:** 운영자로서 나는 큐 적체와 사용량을 관찰하고 싶다. 그래서 GPU 자원을 적시에 늘리고 장애에 대응할 수 있다.

#### Acceptance Criteria

1. WHEN 운영자가 운영 현황 조회를 요청하면, THE Admin_Console SHALL 대기 작업 수, 진행 작업 수, 성공 작업 수, 실패 작업 수, 평균 작업 소요 시간을 반환한다
2. THE Admin_Console SHALL ACE_Engine의 큐 사용률과 큐 최대 크기를 함께 표시한다
3. IF ACE_Engine의 큐 사용률이 최대 크기의 80% 이상이면, THEN THE MusicStudio SHALL 운영자에게 경보를 발송한다
4. IF 최근 15분간 Generation_Job 실패율이 10%를 초과하면, THEN THE MusicStudio SHALL 운영자에게 경보를 발송한다
5. THE MusicStudio SHALL 모든 Generation_Job에 대해 요청 식별자, 사용자 식별자, 엔진 식별자, 엔진 작업 식별자, 사용 모델, 소요 시간을 구조화된 로그로 기록한다
6. THE Audit_Log SHALL 크레딧 변동, 공개 상태 변경, Audio_Asset 삭제, 정책 차단, API 키 발급 및 폐기 사건을 추가 전용으로 보관한다
7. THE MusicStudio SHALL Audit_Log 기록을 최소 365일간 보관한다
8. THE MusicStudio SHALL 로그와 경보 메시지에 기록되는 사용자 이메일과 API 키를 마스킹된 형태로 기록한다
9. WHEN 운영자가 특정 Generation_Job의 진단 정보를 요청하면, THE Admin_Console SHALL 해당 작업의 상태 전이 이력과 실패 사유를 반환한다
10. WHEN 운영자가 엔진 현황 조회를 요청하면, THE Admin_Console SHALL 등록된 각 Engine_Descriptor에 대해 대기 작업 수, 최근 15분 실패율, 일일 쿼터 잔량, 최근 상태 점검 시각과 결과를 반환한다
11. IF 특정 엔진의 최근 15분 실패율이 10%를 초과하면, THEN THE MusicStudio SHALL 운영자에게 해당 엔진 식별자를 포함한 경보를 발송한다
12. IF 특정 엔진의 일일 쿼터 잔량이 일일 배정량의 10% 이하이면, THEN THE MusicStudio SHALL 운영자에게 쿼터 소진 임박 경보를 발송한다
13. THE Admin_Console SHALL Asset_Kind별 최근 24시간 생성 개수와 평균 소요 시간을 반환한다
14. IF 원격 엔진 호출의 최근 15분 평균 응답 시간이 60초를 초과하면, THEN THE MusicStudio SHALL 운영자에게 해당 엔진 식별자를 포함한 경보를 발송한다


### Requirement 19: 통합 오디오 자산 모델

**User Story:** 창작자로서 나는 곡뿐 아니라 배경음악, 효과음, 대사를 같은 라이브러리에서 다루고 싶다. 그래서 하나의 작업 공간에서 오디오 제작을 끝낼 수 있다.

#### Acceptance Criteria

1. THE MusicStudio SHALL 모든 생성 및 업로드 오디오를 Audio_Asset으로 저장하고 각 Audio_Asset에 `song`, `bgm`, `sfx`, `dialogue`, `stem`, `mix` 중 정확히 하나의 Asset_Kind를 부여한다
2. THE MusicStudio SHALL Asset_Kind가 `song`인 Audio_Asset을 Track과 동일한 저장 단위로 취급한다
3. THE MusicStudio SHALL 모든 Audio_Asset에 자산 식별자, 소유자 계정 식별자, 자산 이름(1자 이상 200자 이하), Asset_Kind, 길이(밀리초), 샘플레이트, 채널 수(1 또는 2), 엔진 식별자, 시드, 생성 시각(UTC 밀리초)을 저장하고, 엔진이 시드를 제공하지 않는 경우 시드 없음을 나타내는 고정 값을 저장한다
4. THE MusicStudio SHALL 모든 Audio_Asset을 48000Hz 샘플레이트로 저장한다
5. IF 엔진이 48000Hz가 아닌 샘플레이트의 오디오를 반환하면, THEN THE Generation_Gateway SHALL 해당 오디오를 48000Hz로 리샘플링하여 저장하고, 원본 샘플레이트 값을 출처 정보에 기록하며, 저장된 길이를 원본 길이의 ±10밀리초 이내로 유지한다
6. WHEN Audio_Asset이 1개 이상의 다른 Audio_Asset을 입력으로 하여 생성되면, THE MusicStudio SHALL 입력 자산 식별자 전체(최대 64개)와 파생 종류를 `cover`, `repaint`, `extract`, `lego`, `complete`, 스템 분리, 믹스다운, 이펙트 적용, 음성 변환 중 정확히 하나로 계보 정보에 저장한다
7. THE MusicStudio SHALL Audio_Asset 계보 그래프를 순환이 없는 상태로 유지하고, 계보 경로 깊이를 1 이상 32 이하로 유지하며, Asset_Kind가 `stem` 또는 `mix`인 모든 Audio_Asset의 입력 자산 식별자 개수를 1개 이상으로 유지한다(불변식)
8. WHEN 사용자가 Audio_Asset에 태그 부여를 요청하면, THE Library_Service SHALL 각 태그를 1자 이상 30자 이하 문자열로 저장하고, 자산당 최대 20개까지 저장하며, 대소문자를 구분하지 않고 동일한 태그를 1개로 저장한다
9. IF 저장 요청의 Asset_Kind가 정의된 6개 값 중 하나가 아니면, THEN THE MusicStudio SHALL 저장 요청을 거부하고 허용된 Asset_Kind 목록을 반환한다
10. THE MusicStudio SHALL Asset_Kind가 `bgm` 또는 `sfx`인 Audio_Asset에 대해 루프 자산 여부를 참 또는 거짓 값으로 저장하고, 저장 요청에 해당 값이 지정되지 않은 경우 거짓으로 저장한다
11. THE MusicStudio SHALL 모든 Audio_Asset의 길이를 1밀리초 이상 3600000밀리초 이하 범위로 유지한다(불변식)
12. WHEN 사용자가 외부 오디오 파일을 라이브러리에 업로드하면, THE Library_Service SHALL 해당 파일의 형식이 mp3, wav, flac 중 하나이고 파일 크기가 50MB 이하이고 오디오 길이가 1밀리초 이상 3600000밀리초 이하임을 검증한 후, 사용자 지정 Asset_Kind의 Audio_Asset으로 저장하고 엔진 식별자를 업로드 출처를 나타내는 값으로 기록한다
13. IF 계보 정보 저장 요청이 Audio_Asset 계보 그래프에 순환을 만들거나 계보 경로 깊이를 32 초과로 만들면, THEN THE MusicStudio SHALL 해당 요청을 거부하고 위반된 불변식과 순환에 포함된 자산 식별자 목록을 반환하며 기존 계보 정보를 변경 없이 유지한다
14. IF 태그 부여 요청의 태그 개수가 21개 이상이거나 태그 길이가 31자 이상이면, THEN THE Library_Service SHALL 해당 요청을 거부하고 태그 개수 상한 20개와 태그 길이 상한 30자를 반환하며 기존 태그 목록을 변경 없이 유지한다
15. IF Audio_Asset 저장 요청의 오디오 길이가 1밀리초 미만이거나 3600000밀리초를 초과하거나, 업로드 파일 형식이 mp3, wav, flac 중 하나가 아니거나, 파일 크기가 50MB를 초과하면, THEN THE MusicStudio SHALL 저장 요청을 거부하고 위반된 제약과 허용값을 반환하며 Audio_Asset을 생성하지 않는다

### Requirement 20: 모델 제공자 레지스트리 및 라우팅

**User Story:** 서비스 운영자로서 나는 여러 생성 엔진을 하나의 제품 표면 뒤에서 교체하고 싶다. 그래서 특정 모델의 장애나 정책 변경이 제품 전체를 멈추지 않는다.

#### Acceptance Criteria

1. THE Provider_Registry SHALL 등록된 각 엔진에 대해 엔진 식별자(1자 이상 64자 이하), 지원 Asset_Kind 목록(1개 이상 6개 이하), 지원 입력 양식 목록(`text`, `audio`, `video` 중 1개 이상 3개 이하), 최대 출력 길이(1000밀리초 이상 3600000밀리초 이하), 샘플레이트(16000Hz 이상 48000Hz 이하), 실행 위치(`local` 또는 `remote` 중 정확히 하나), License_Descriptor 1개를 모두 채운 Engine_Descriptor를 보유한다
2. THE Provider_Registry SHALL Asset_Kind 6종 각각에 대해 기본 엔진을 정확히 1개 지정하며, 지정된 기본 엔진은 해당 Asset_Kind를 지원 Asset_Kind 목록에 포함하고 활성 상태를 유지한다(불변식)
3. WHILE 지정된 엔진이 사용 가능 상태인 동안, WHEN 사용자가 생성 요청에 엔진 식별자를 지정하면, THE Generation_Gateway SHALL 해당 엔진의 Engine_Adapter로 요청을 라우팅하고 사용된 엔진 식별자를 응답에 포함한다
4. WHEN 사용자가 생성 요청에 엔진 식별자를 지정하지 않으면, THE Generation_Gateway SHALL 해당 Asset_Kind의 기본 엔진으로 요청을 라우팅하고 사용된 엔진 식별자를 응답에 포함한다
5. IF 지정된 엔진의 지원 Asset_Kind 목록에 요청된 Asset_Kind가 없으면, THEN THE Generation_Gateway SHALL 요청을 거부하고 해당 Asset_Kind를 지원하는 엔진 식별자 목록을 반환한다
6. IF 요청된 출력 길이가 지정된 엔진의 최대 출력 길이를 초과하면, THEN THE Generation_Gateway SHALL 요청을 거부하고 해당 엔진의 최대 출력 길이를 반환한다
7. THE Provider_Registry SHALL 등록된 각 엔진의 상태를 60초 ± 5초 간격으로 점검하고, 각 점검의 응답 대기 시간을 10초로 제한하며, 각 엔진별로 최근 100건 이상의 점검 시각(밀리초)과 점검 결과(성공 또는 실패)를 24시간 이상 보관한다
8. IF 엔진의 연속 상태 점검 실패 횟수가 3회 이상이면, THEN THE Provider_Registry SHALL 해당 엔진을 사용 불가 상태로 전환한다
9. WHILE 엔진이 사용 불가 상태인 동안, THE Generation_Gateway SHALL 해당 엔진을 사용자 선택 목록에서 사용 불가로 표시하고 동일 Asset_Kind를 지원하는 대체 엔진 후보를 함께 제시한다
10. WHERE 요청된 Asset_Kind에 대체 엔진이 지정된 경우, WHILE 기본 엔진이 사용 불가 상태인 동안, WHEN 엔진 식별자를 지정하지 않은 생성 요청이 도착하면, THE Generation_Gateway SHALL 대체 엔진 1개로 요청을 1회 재라우팅하고 실제 사용 엔진 식별자와 대체 사유를 응답에 포함한다
11. IF 요청된 Asset_Kind를 지원하는 사용 가능 엔진이 0개이면, THEN THE Generation_Gateway SHALL 요청을 거부하고, 해당 Asset_Kind를 지원하는 각 엔진의 최근 상태 점검 시각과 결과를 반환하며, 요청 계정의 크레딧 잔액을 요청 이전 값과 동일하게 유지한다
12. THE Provider_Registry SHALL 각 엔진에 대해 일일 최대 요청 수(1 이상 1000000 이하 정수)와 일일 최대 GPU 초(1 이상 1000000 이하 정수)를 쿼터로 관리하고, 두 쿼터의 사용량 집계를 매일 00:00 UTC에 0으로 초기화한다
13. IF 엔진의 일일 쿼터 잔량이 요청 처리에 필요한 양보다 적으면, THEN THE Generation_Gateway SHALL 해당 엔진 요청을 거부하고, 다음 쿼터 초기화 시각과 동일 Asset_Kind를 지원하는 사용 가능 엔진 식별자 목록을 반환하며, 요청 계정의 크레딧 잔액을 요청 이전 값과 동일하게 유지한다
14. WHEN Engine_Adapter가 원격 엔진을 호출하면, THE Generation_Gateway SHALL 응답 대기 시간을 300초로 제한한다
15. IF 원격 엔진 호출이 300초 이내에 응답하지 않으면, THEN THE Job_Orchestrator SHALL 해당 Generation_Job을 시간 초과 실패 상태로 전환하고, 차감된 크레딧 전액을 60초 이내에 환급하며, 호출된 엔진 식별자와 시간 초과 사유를 작업 기록에 포함한다
16. WHEN 새 엔진이 등록되면, THE Provider_Registry SHALL Credit_Service 단가표에 해당 엔진의 항목이 존재함을 확인한다
17. IF 새로 등록된 엔진의 단가표 항목이 존재하지 않으면, THEN THE Provider_Registry SHALL 해당 엔진을 비활성 상태로 등록하고 누락된 단가표 항목 이름을 반환한다
18. THE Generation_Gateway SHALL 모든 엔진의 응답을 Asset_Kind, 오디오 길이(밀리초), 샘플레이트, 시드, 사용 엔진 식별자, 작업 상태 값이 모두 채워진 단일 정규화 형식으로 변환한다
19. WHEN 사용자가 사용 가능 엔진 목록 조회를 요청하면, THE Provider_Registry SHALL 각 엔진의 엔진 식별자, 지원 Asset_Kind 목록, 최대 출력 길이, 상업적 사용 허용 여부, 요구 저작자 표시 문구, 현재 사용 가능 여부, 최근 상태 점검 시각을 5초 이내에 반환한다
20. THE Provider_Registry SHALL 엔진 등록, 비활성화, 사용 불가 상태 전환, 사용 가능 상태 복귀, 기본 엔진 변경 사건 각각에 대해 사건 시각(밀리초), 행위자 계정 식별자, 대상 엔진 식별자, 변경 전 값, 변경 후 값을 Audit_Log에 기록한다
21. WHILE 엔진이 사용 불가 상태인 동안, WHEN 해당 엔진의 상태 점검이 연속 2회 성공하면, THE Provider_Registry SHALL 해당 엔진을 사용 가능 상태로 전환하고 사용자 선택 목록에서 선택 가능으로 표시한다
22. IF 생성 요청이 명시적으로 지정한 엔진이 사용 불가 상태이거나 비활성 상태이면, THEN THE Generation_Gateway SHALL 요청을 거부하고 동일 Asset_Kind를 지원하는 사용 가능 엔진 식별자 목록을 반환하며, 요청 계정의 크레딧 잔액을 요청 이전 값과 동일하게 유지한다
23. IF 엔진 등록 요청의 Engine_Descriptor에 20.1이 요구하는 필드 중 1개 이상이 비어 있거나 지정된 값 범위를 벗어나면, THEN THE Provider_Registry SHALL 등록을 거부하고 누락 또는 범위 위반 필드 이름 목록을 반환한다

### Requirement 21: 배경음악 생성

**User Story:** 영상 제작자로서 나는 장면 분위기에 맞는 배경음악과 끊김 없이 반복되는 루프를 얻고 싶다. 그래서 영상이나 게임에 바로 얹을 수 있다.

#### Acceptance Criteria

1. WHEN 사용자가 분위기, 장면 설명, 악기 구성, 목표 길이를 지정하여 배경음악 생성을 요청하면, THE BGM_Service SHALL Asset_Kind가 `bgm`인 Audio_Asset을 산출하는 Generation_Job을 생성한다
2. THE BGM_Service SHALL 배경음악 목표 길이 입력을 5초 이상 600초 이하 범위로 검증한다
3. IF 배경음악 목표 길이가 5초 미만 또는 600초 초과이거나, 장면 설명 길이가 1자 미만 또는 2000자 초과이면, THEN THE BGM_Service SHALL 요청을 거부하고 위반 항목 이름과 해당 항목의 허용 최소값 및 최대값을 반환한다
4. THE BGM_Service SHALL 모든 `bgm` 생성 요청을 가사 입력 없이 인스트루멘털 파라미터로 고정하여 처리하고, 산출된 `bgm` Audio_Asset의 가사 메타데이터를 빈 값으로 기록한다
5. THE BGM_Service SHALL 장면 설명 입력 길이를 1자 이상 2000자 이하로 검증한다
6. WHERE 사용자가 루프 배경음악을 선택한 경우, THE BGM_Service SHALL 루프 이음 연속성 기준(RMS 차이, 샘플 단차, 양 끝 구간 에너지, 마디 정합)을 모두 충족하는 루프 자산을 산출하고 해당 자산의 루프 자산 여부를 참으로 기록한다
7. WHERE 사용자가 루프 배경음악을 선택한 경우, THE BGM_Service SHALL 루프 이음점을 자산의 마지막 샘플과 첫 샘플이 접하는 지점으로 정의하고, 저장된 샘플레이트에서 채널별로 측정한 마지막 10밀리초 구간 RMS와 첫 10밀리초 구간 RMS의 차이를 모든 채널에서 1.0데시벨 이하로 유지한다(불변식)
8. WHERE 사용자가 루프 배경음악을 선택한 경우, THE BGM_Service SHALL 각 채널에서 마지막 샘플 값과 첫 샘플 값의 차이의 절대값을 해당 채널 최대 절대 진폭의 5% 이하로 유지한다(불변식)
9. WHEN 사용자가 동일 배경음악 큐의 강도 변형 생성을 요청하면, THE BGM_Service SHALL 지정된 개수(1 이상 4 이하)의 변형을 동일한 BPM, 키, 목표 길이로 산출한다
10. THE BGM_Service SHALL 동일 큐에서 산출된 강도 변형 자산들의 길이 차이를 10밀리초 이하로 유지한다(불변식)
11. THE BGM_Service SHALL 동일 큐에서 산출된 각 강도 변형 자산에 1 이상 4 이하의 서로 다른 강도 단계 값을 기록하고, 강도 단계 값이 1 큰 자산의 통합 라우드니스를 한 단계 낮은 자산보다 1.0LUFS 이상 6.0LUFS 이하 크게 유지한다(불변식)
12. WHERE 사용자가 기준 Audio_Asset을 지정한 경우, THE BGM_Service SHALL 해당 자산의 BPM과 키를 배경음악 생성 파라미터로 고정한다
13. WHERE 사용자가 기준 Audio_Asset을 지정한 경우, THE BGM_Service SHALL 산출된 배경음악의 BPM 메타데이터를 기준 자산 BPM ±1BPM 이내로 기록하고 키 메타데이터를 기준 자산 키와 동일한 값으로 기록한다
14. WHEN 사용자가 `bgm` Audio_Asset의 스템 분리를 요청하면, THE Generation_Gateway SHALL `task_type=extract`로 요청하고 산출물을 Asset_Kind가 `stem`인 Audio_Asset으로 저장한다
15. WHEN 배경음악 생성이 완료되면, THE BGM_Service SHALL 산출 자산의 BPM, 키, 박자, 강도 단계, 루프 자산 여부, 샘플레이트, 채널 수, 재생 길이(밀리초), 마디 수, 통합 라우드니스(LUFS)를 메타데이터로 저장한다
16. WHERE 사용자가 루프 배경음악을 선택한 경우, THE BGM_Service SHALL 루프 자산의 첫 100밀리초 구간과 마지막 100밀리초 구간의 채널별 RMS를 각각 해당 자산 전체 구간 RMS 대비 -6데시벨 이상으로 유지한다(불변식)
17. WHERE 사용자가 루프 배경음악을 선택한 경우, THE BGM_Service SHALL 루프 자산의 재생 길이를 기록된 BPM과 박자로 계산한 1마디 길이의 1배 이상 64배 이하 정수배로 산출하고, 계산값과의 오차를 ±25밀리초 이내로 유지한다
18. WHERE 사용자가 루프 배경음악을 선택한 경우, IF 산출된 루프 자산이 21.7, 21.8, 21.16, 21.17 중 하나 이상을 충족하지 않으면, THEN THE BGM_Service SHALL 서로 다른 시드로 최대 2회까지 재생성하고, 3회 시도 모두 충족하지 않으면 해당 Generation_Job을 실패로 종료하며 차감된 크레딧 전액을 환급하고 미충족 기준 이름 목록을 반환한다

### Requirement 22: 효과음 생성(텍스트 기반)

**User Story:** 게임 개발자로서 나는 짧은 설명으로 효과음을 여러 후보와 함께 얻고 싶다. 그래서 원하는 소리를 빠르게 골라 쓸 수 있다.

#### Acceptance Criteria

1. WHEN 사용자가 텍스트 프롬프트를 지정하여 효과음 생성을 요청하면, THE SFX_Service SHALL Asset_Kind가 `sfx`인 Audio_Asset을 산출하는 Generation_Job을 생성하고 각 산출 자산에 사용된 프롬프트, 목표 길이, 루프 자산 여부, 모델 등급을 메타데이터로 기록한다
2. THE SFX_Service SHALL 효과음 프롬프트를 1자 이상이며 토큰화 후 77토큰 이하로 검증한다
3. IF 효과음 프롬프트가 앞뒤 공백 제거 후 1자 미만이거나 토큰화 후 77토큰을 초과하면, THEN THE SFX_Service SHALL 요청을 거부하고 위반된 제약 이름, 입력 문자 수, 입력 토큰 수, 허용 범위를 반환하며 크레딧 잔액을 요청 이전 값으로 유지한다
4. THE SFX_Service SHALL 효과음 목표 길이 입력을 0.1초 이상 10.0초 이하 범위로 검증한다
5. WHEN 사용자가 변형 개수를 지정하면, THE SFX_Service SHALL 1 이상 8 이하 범위로 검증한 후 해당 개수의 효과음을 서로 다른 시드로 산출한다
6. WHEN 효과음 변형이 1개 이상 산출되면, THE SFX_Service SHALL 각 산출물에 대해 프롬프트와 오디오의 정렬 점수를 계산하고 점수 내림차순으로 정렬한 목록을 반환하며, 두 산출물의 점수 차이가 0.001 이하인 경우 시드 오름차순으로 정렬한다
7. THE SFX_Service SHALL 정렬 점수를 0.0 이상 1.0 이하 값으로 정규화하여 Audio_Asset 메타데이터에 저장한다
8. WHEN 사용자가 프롬프트, 엔진, 시드, 목표 길이, 변형 개수, 샘플링 단계 수, 안내 척도를 이전 요청과 동일하게 지정하여 효과음 생성을 재요청하면, THE SFX_Service SHALL 이전 산출물과 샘플 단위로 동일한 오디오를 산출한다(재현성 불변식)
9. THE SFX_Service SHALL 고속 등급과 고품질 등급 2개의 모델 등급을 제공한다
10. WHEN 사용자가 고속 등급을 선택하면, THE SFX_Service SHALL 증류 모델을 사용하고 샘플링 단계 수 입력을 1 이상 8 이하 범위로 검증하며 미지정 시 기본값 8을 적용한다
11. WHEN 사용자가 고품질 등급을 선택하면, THE SFX_Service SHALL 비증류 모델을 사용하고 샘플링 단계 수 입력을 8 이상 100 이하 범위로 검증하며 미지정 시 기본값 30을 적용한다
12. THE SFX_Service SHALL 안내 척도 입력을 1.0 이상 15.0 이하 범위로 검증하고 기본값 7.5를 적용한다
13. WHEN 사용자가 시드를 지정하지 않으면, THE SFX_Service SHALL 0 이상 2147483647 이하 범위의 시드를 생성하여 Audio_Asset 메타데이터에 기록한다
14. WHERE 사용자가 루프 효과음을 선택한 경우, THE SFX_Service SHALL 루프 자산의 마지막 10밀리초 구간과 첫 10밀리초 구간의 RMS 차이를 1.0데시벨 이하로 유지한다(불변식)
15. WHERE 사용자가 루프 효과음을 선택하지 않은 경우, THE SFX_Service SHALL 산출된 각 효과음 오디오의 마지막 50밀리초 구간의 최대 절대 진폭을 해당 자산 최대 절대 진폭의 5% 이하로 유지한다(불변식)
16. THE SFX_Service SHALL 효과음 생성 요청당 최대 8개의 Audio_Asset을 산출한다
17. WHEN 사용자가 목표 길이, 변형 개수, 모델 등급 중 하나 이상을 지정하지 않고 효과음 생성을 요청하면, THE SFX_Service SHALL 지정되지 않은 항목에 각각 목표 길이 2.0초, 변형 개수 4, 고속 등급을 적용하고 적용된 값을 응답에 포함한다
18. IF 요청된 목표 길이가 0.1초 미만 또는 10.0초 초과이거나 변형 개수가 1 미만 또는 8 초과이면, THEN THE SFX_Service SHALL 요청을 거부하고 위반된 제약 이름, 입력값, 허용 범위를 반환하며 크레딧 잔액을 요청 이전 값으로 유지한다
19. IF 한 효과음 생성 요청의 변형 중 1개 이상이 실패하고 1개 이상이 성공하면, THEN THE SFX_Service SHALL 성공한 변형만 Audio_Asset으로 저장하고 실패한 변형 개수에 해당하는 크레딧을 환급하며 실패 개수와 실패 사유 구분값을 응답에 포함한다

### Requirement 23: 영상 기반 폴리 효과음 생성

**User Story:** 영상 편집자로서 나는 영상에 맞춰 타이밍이 정렬된 효과음을 자동으로 얻고 싶다. 그래서 폴리 작업 시간을 줄일 수 있다.

#### Acceptance Criteria

1. WHEN 사용자가 영상 파일을 업로드하여 폴리 생성을 요청하면, THE V2A_Service SHALL Asset_Kind가 `sfx`인 Audio_Asset을 1개 이상 4개 이하 산출하는 Generation_Job을 생성한다
2. THE V2A_Service SHALL 업로드 영상의 컨테이너 형식을 mp4, mov, webm 중 하나로, 비디오 스트림 수를 1개 이상으로, 프레임률을 초당 8프레임 이상 120프레임 이하로, 짧은 변 해상도를 128픽셀 이상으로 검증한다
3. THE V2A_Service SHALL 업로드 영상 길이를 0.5초 이상 60초 이하로, 파일 크기를 200MB 이하로 검증한다
4. IF 업로드 영상이 23.2 또는 23.3의 검증 항목 중 하나 이상을 통과하지 못하면, THEN THE V2A_Service SHALL 업로드를 거부하고 위반된 제약 이름, 측정값, 허용 범위를 반환하며 해당 업로드 파일을 저장하지 않는다
5. WHERE 사용자가 텍스트 프롬프트를 함께 제공한 경우, THE V2A_Service SHALL 해당 프롬프트를 영상과 함께 생성 조건으로 전달한다
6. THE V2A_Service SHALL 영상을 초당 24프레임으로 표본화하여 엔진에 전달하고, 원본 프레임률이 초당 24프레임 미만인 경우 직전 프레임을 복제하여 초당 24프레임을 채운다
7. WHEN 입력 영상 길이가 엔진의 최대 처리 구간 8초를 초과하는 폴리 생성이 시작되면, THE V2A_Service SHALL 영상을 인접 구간이 50밀리초씩 겹치는 8초 이하 구간으로 분할하여 순차 생성하고, 인접 구간의 산출 오디오를 그 50밀리초 겹침 구간에서 교차 페이드로 연결하여 합산 길이가 입력 영상 길이와 같아지도록 한다
8. THE V2A_Service SHALL 23.15가 산출한 Visual_Event_Timeline의 항목 중 신뢰도가 0.50 이상인 각 시각 이벤트에 대해, 해당 이벤트 시각 기준 ±80밀리초 구간 안에 산출 오디오의 온셋이 1개 이상 존재하는 이벤트의 비율을 90% 이상으로 유지한다. 여기서 산출 오디오의 온셋은 5밀리초 프레임 단위 단기 RMS가 직전 50밀리초 평균 RMS보다 6.0데시벨 이상 큰 최초 프레임의 시작 시각으로 측정한다
9. THE V2A_Service SHALL 산출 오디오 길이를 입력 영상 길이 기준 ±40밀리초 이내로 유지한다(불변식)
10. WHEN 폴리 생성이 완료되면, THE V2A_Service SHALL 원본 영상 파일 식별자와 사용된 프롬프트를 Audio_Asset 계보 정보로 저장한다
11. IF 업로드 영상에 대한 권리 보유 확인 동의가 기록되지 않은 상태에서 폴리 생성이 요청되면, THEN THE Moderation_Service SHALL 해당 요청을 거부하고 누락된 동의 항목을 반환한다
12. WHEN 폴리 생성이 완료되면, THE V2A_Service SHALL 원본 영상과 산출 오디오를 합성한 미리보기 영상 파일을 산출 오디오 시작 시각과 영상 시작 시각의 차이가 ±20밀리초 이내가 되도록 제공하고, 해당 미리보기 파일을 생성 완료 시각으로부터 168시간 이상 조회 가능하게 유지한다
13. THE V2A_Service SHALL 업로드된 원본 영상 파일을 미리보기 영상 파일 생성이 완료된 이후, 폴리 생성 완료 시각으로부터 168시간이 지나기 전에 삭제한다
14. WHEN 사용자가 시드를 이전 요청과 동일하게 지정하여 동일 영상과 동일 프롬프트로 폴리 생성을 재요청하면, THE V2A_Service SHALL 이전 산출물과 샘플 단위로 동일한 오디오를 산출한다(재현성 불변식)
15. WHEN 폴리 생성이 완료되면, THE V2A_Service SHALL 검출된 각 시각 이벤트의 밀리초 단위 시각, 0.00 이상 1.00 이하 신뢰도, 범주 이름을 시각 오름차순으로 담은 Visual_Event_Timeline을 Audio_Asset 메타데이터로 저장하고 사용자에게 반환한다
16. IF 폴리 생성 중 신뢰도 0.50 이상인 시각 이벤트가 0개 검출되면, THEN THE V2A_Service SHALL 온셋 정렬 없이 영상 길이와 같은 길이의 앰비언스 오디오를 산출하고 시각 이벤트가 검출되지 않았음을 나타내는 상태 값을 Visual_Event_Timeline과 함께 반환한다
17. IF 폴리 생성 Generation_Job이 시작 시각으로부터 900초 이내에 완료 상태에 도달하지 않으면, THEN THE V2A_Service SHALL 해당 Generation_Job을 실패 상태로 전이시키고 실패 사유와 생성이 완료된 구간 수를 반환하며 부분 산출 오디오를 Audio_Asset으로 저장하지 않는다

### Requirement 24: UI 사운드 팩 저작

**User Story:** 제품 디자이너로서 나는 우리 제품 성격에 맞는 인터페이스 사운드 세트를 한 번에 만들고 싶다. 그래서 큐마다 소리를 따로 찾지 않아도 된다.

#### Acceptance Criteria

1. WHEN 사용자가 1자 이상 60자 이하의 팩 이름과 1자 이상 200자 이하의 음향 성격 설명을 지정하여 사운드 팩 생성을 요청하면, THE Sound_Pack_Service SHALL 13개 상호작용 범주에 걸친 78개 Semantic_Cue 전체에 대한 오디오를 산출하는 Generation_Job을 생성한다
2. WHEN 사운드 팩 생성 작업이 종료되면, THE Sound_Pack_Service SHALL 산출된 Sound_Pack의 큐 개수가 78이고 큐 이름 집합이 Semantic_Cue 택소노미의 78개 이름 집합과 정확히 일치함을 검증한다(불변식)
3. IF 생성된 Sound_Pack에 누락된 Semantic_Cue가 존재하면, THEN THE Sound_Pack_Service SHALL 해당 팩을 미완성 상태로 표시하고 누락된 큐 이름 목록을 반환한다
4. THE Sound_Pack_Service SHALL 72개 원샷 큐의 각 오디오 길이를 0.05초 이상 1.5초 이하로 유지한다(불변식)
5. THE Sound_Pack_Service SHALL `loading`, `processing`, `recording`, `connecting`, `scanning`, `streaming` 6개 큐를 각 오디오 길이가 0.5초 이상 4.0초 이하인 루프 자산으로 산출한다
6. THE Sound_Pack_Service SHALL 각 루프 큐의 마지막 10밀리초 구간 RMS와 첫 10밀리초 구간 RMS의 차이를 1.0데시벨 이하로 유지하고, 마지막 샘플 값과 첫 샘플 값의 차이의 절대값을 해당 큐 최대 절대 진폭의 5% 이하로 유지한다(불변식)
7. THE Sound_Pack_Service SHALL 동일 Sound_Pack 내 모든 큐 오디오의 라우드니스를 400밀리초 창·100밀리초 간격으로 측정한 창별 라우드니스의 최대값으로 산출하고(오디오 길이가 400밀리초 미만인 큐는 전체 구간을 1개 창으로 측정), 그 값을 -25LUFS 이상 -21LUFS 이하로 유지한다(불변식)
8. THE Sound_Pack_Service SHALL 동일 Sound_Pack 내 모든 원샷 큐의 끝 50밀리초 구간의 최대 절대 진폭을 해당 큐 최대 절대 진폭의 5% 이하로 유지한다
9. THE Sound_Pack_Service SHALL 동일 Sound_Pack 내 서로 다른 모든 큐 쌍 3003개에 대하여, 두 큐 오디오를 각각 48000Hz 모노로 변환하고 -23LUFS로 라우드니스 정규화한 뒤 25밀리초 창·10밀리초 간격·멜 밴드 40개의 로그 멜 스펙트로그램에서 산출한 켑스트럼 계수 중 1차부터 13차까지를 전체 창에 대해 시간 평균한 13차원 벡터를 구하고, 두 벡터 사이의 코사인 유사도를 -1.0 이상 1.0 이하 값으로 계산하여 0.95 이하로 유지한다(불변식)
10. WHEN 사용자가 Sound_Pack 내보내기를 요청하면, THE Sound_Pack_Service SHALL 78개 큐 각각에 대한 mp3 파일 1개와 ogg 파일 1개, 합계 156개 오디오 파일을 48000Hz 샘플레이트로 담은 단일 압축 파일을 60초 이내에 반환한다
11. WHEN Sound_Pack이 내보내지면, THE Sound_Pack_Service SHALL 각 큐의 파일 경로, 바이트 크기, 오디오 길이, 채널 수, 루프 여부, 기본 음량, 큐 이름, 범주 이름, 팩 이름을 담은 Cue_Pack_Manifest를 압축 파일에 포함한다
12. THE Manifest_Parser SHALL Cue_Pack_Manifest 파일을 Cue_Pack_Manifest 구조체로 변환한다
13. THE Manifest_Printer SHALL Cue_Pack_Manifest 구조체를 Cue_Pack_Manifest 파일로 변환한다
14. FOR ALL 유효한 Cue_Pack_Manifest 구조체에 대해, THE MusicStudio SHALL 출력 후 재파싱한 결과가 원본 구조체와 동등함을 보장한다(왕복 속성)
15. FOR ALL 파싱에 성공한 Cue_Pack_Manifest 파일에 대해, THE MusicStudio SHALL 파싱 후 출력한 파일을 다시 파싱한 결과가 첫 파싱 결과와 동등함을 보장한다(멱등 속성)
16. IF Cue_Pack_Manifest의 큐 항목 개수가 78이 아니면, THEN THE Manifest_Parser SHALL 항목 개수와 요구 개수를 포함한 오류를 반환한다
17. WHEN 사용자가 특정 큐의 재생성을 요청하면, THE Sound_Pack_Service SHALL 해당 큐만 재생성하고 나머지 77개 큐의 오디오를 변경 없이 유지하며, 재생성된 큐에 대해 24.4 또는 24.5의 길이 제약, 24.6의 이음점 제약, 24.7의 라우드니스 제약, 24.9의 큐 쌍 유사도 제약을 다시 검증한다
18. THE Sound_Pack_Service SHALL 생성된 각 Sound_Pack의 큐 오디오를 Asset_Kind가 `sfx`인 Audio_Asset으로 저장하고 각 자산에 큐 이름, 범주 이름, 팩 식별자를 기록한다
19. WHEN 사용자가 Sound_Pack 상세 정보를 조회하면, THE Sound_Pack_Service SHALL 78개 Semantic_Cue 각각에 대해 큐 이름, 범주 이름, 의도 설명 1건, 오용 경계 1건 이상을 담은 큐 계약 문서를 반환한다
20. IF 팩 이름 또는 음향 성격 설명이 24.1의 길이 범위를 벗어나면, THEN THE Sound_Pack_Service SHALL 사운드 팩 생성 요청을 거부하고 위반된 필드 이름, 입력 길이, 허용 범위를 반환하며 기존 Sound_Pack 자산을 변경 없이 유지한다
21. IF 개별 Semantic_Cue의 오디오 생성이 실패하면, THEN THE Sound_Pack_Service SHALL 해당 큐 생성을 최대 2회 재시도하고, 재시도 후에도 실패하면 이미 성공한 큐의 오디오를 유지한 채 해당 팩을 미완성 상태로 표시하고 실패한 큐 이름 목록과 실패 원인 구분을 반환한다
22. IF 24.9의 코사인 유사도가 0.95를 초과하는 큐 쌍이 존재하면, THEN THE Sound_Pack_Service SHALL 해당 쌍 중 나중에 생성된 큐를 서로 다른 시드로 최대 3회 재생성하고, 재생성 후에도 0.95를 초과하면 해당 팩을 검토 필요 상태로 표시하고 초과한 큐 쌍 이름 목록과 각 쌍의 측정된 유사도 값을 반환한다

### Requirement 25: 대사 및 음성 생성

**User Story:** 콘텐츠 제작자로서 나는 대본을 음성으로 만들고 특정 대사만 다시 뽑고 싶다. 그래서 전체를 재생성하지 않고 수정할 수 있다.

#### Acceptance Criteria

1. WHEN 사용자가 스크립트 텍스트와 Voice_Profile을 지정하여 대사 생성을 요청하면, THE Speech_Service SHALL Asset_Kind가 `dialogue`인 Audio_Asset을 산출하는 Generation_Job을 생성한다
2. THE Speech_Service SHALL 사용자가 선택할 수 있는 음성 합성 엔진을 2개 이상 제공하고 각 엔진의 지원 언어 목록을 함께 제시한다
3. IF 요청된 언어 코드가 선택된 엔진의 지원 언어 목록에 없으면, THEN THE Speech_Service SHALL 요청을 거부하고 해당 언어를 지원하는 엔진 식별자 목록을 반환한다
4. THE Speech_Service SHALL 스크립트 전체 길이를 1자 이상 20000자 이하로 검증한다
5. THE Speech_Service SHALL 발화 속도 입력을 0.5배 이상 2.0배 이하 범위로 검증하고 기본값 1.0배를 적용한다
6. THE Speech_Service SHALL 음높이 조정 입력을 -12반음 이상 +12반음 이하 범위로 검증하고 기본값 0반음을 적용한다
7. WHERE 선택된 엔진이 자연어 연기 지시를 지원하는 경우, THE Speech_Service SHALL 사용자가 입력한 연기 지시 문구를 200자 이하로 검증한 후 엔진에 전달한다
8. WHERE 선택된 엔진이 준언어 태그를 지원하는 경우, THE Speech_Service SHALL `[laugh]`, `[sigh]`, `[gasp]` 형식의 태그를 스크립트 내 위치에 대응하는 발화로 합성한다
9. IF 선택된 엔진이 스크립트에 포함된 준언어 태그를 지원하지 않으면, THEN THE Speech_Service SHALL 해당 태그를 합성 입력에서 제거하고 제거된 태그 이름 목록을 응답에 포함한다
10. THE Speech_Service SHALL 분할 기준 문자 수 입력을 100자 이상 5000자 이하 범위로 검증하고 기본값 800자를 적용한다
11. WHEN 스크립트의 문자 수가 분할 기준 문자 수를 초과하면, THE Speech_Service SHALL 행 경계 또는 문장 종결 부호(`.`, `?`, `!`, `。`) 직후 위치에서만 스크립트를 분할하고, 각 조각을 순차 합성한 후 인접 조각을 50밀리초 교차 페이드로 연결한다
12. THE Speech_Service SHALL 분할 합성 결과 조각의 순서를 원본 스크립트의 문장 순서와 동일하게 유지한다(불변식)
13. THE Speech_Service SHALL 분할 합성 결과의 조각 개수 합이 원본 스크립트 문장 개수 이하임을 유지한다(불변식)
14. THE Speech_Service SHALL 스크립트를 줄바꿈 문자로 구분된 행 단위로 저장하고, 각 행에 0부터 시작하는 연속 정수 행 인덱스와 대응 오디오 구간의 시작 시각 및 종료 시각을 밀리초 단위 정수로 기록하며, 행 개수를 1개 이상 1000개 이하로, 행당 문자 수를 1자 이상 1000자 이하로 유지한다
15. WHEN 사용자가 특정 행 인덱스의 재생성을 요청하면, THE Speech_Service SHALL 해당 행만 최초 합성에 사용된 Voice_Profile과 엔진과 발화 속도와 음높이 조정 값으로 재합성하고, 재합성된 구간을 인접 행과 50밀리초 교차 페이드로 접합하며, 재생성 대상 행을 제외한 모든 행의 오디오 표본 값을 접합 경계 전후 각 50밀리초 구간을 제외하고 재생성 이전 값과 동일하게 유지한다
16. WHEN 재합성된 행의 오디오 길이가 재생성 이전 해당 행의 길이와 1밀리초 이상 차이가 나면, THE Speech_Service SHALL 길이 변화량(재합성 길이 − 재생성 이전 길이)을 재생성 대상 행보다 뒤에 오는 모든 행의 시작 시각과 종료 시각에 동일하게 가산하고, 인접 행 사이의 간격 길이를 재생성 이전 값과 동일하게 유지하며, 전체 오디오 길이를 재생성 이전 전체 길이와 길이 변화량의 합과 동일한 값으로 갱신한다
17. THE Speech_Service SHALL 합성 결과의 모든 행에 대해 시작 시각이 0 이상이고 시작 시각이 종료 시각보다 작으며 종료 시각이 전체 오디오 길이 이하임을 유지하고, 행들을 시작 시각 오름차순으로 정렬되고 재생 구간이 서로 겹치지 않는 상태로 유지한다(불변식)
18. WHEN 사용자가 시드와 스크립트와 Voice_Profile과 엔진과 발화 속도와 음높이 조정 값을 이전 요청과 동일하게 지정하여 대사 생성을 재요청하면, THE Speech_Service SHALL 이전 산출물과 샘플 단위로 동일한 오디오를 산출한다(재현성 불변식)
19. THE Speech_Service SHALL 합성된 오디오의 마지막 표본부터 역방향으로 측정한 -60dBFS 이하 연속 구간의 길이를 50밀리초 이상 200밀리초 이하 범위로 조정한다
20. THE Speech_Service SHALL 행 재생성 후 재생성 대상 행보다 앞에 오는 모든 행의 시작 시각과 종료 시각을 재생성 이전 값과 동일하게 유지한다(불변식)
21. IF 행 재생성 요청의 행 인덱스가 0 이상 저장된 행 개수 미만 범위에 포함되지 않으면, THEN THE Speech_Service SHALL 요청을 거부하고 유효 행 인덱스 범위를 반환하며 기존 오디오와 모든 행의 타이밍을 변경 없이 유지하고 크레딧을 차감하지 않는다
22. IF 스크립트 문자 수, 발화 속도, 음높이 조정, 연기 지시 문구 길이, 분할 기준 문자 수 중 하나가 25.4부터 25.10에 정의된 허용 범위를 벗어나면, THEN THE Speech_Service SHALL 요청을 거부하고 위반된 제약 이름과 허용 범위를 반환하며 크레딧을 차감하지 않는다
23. WHEN Asset_Kind가 `dialogue`인 Audio_Asset이 저장되면, THE Speech_Service SHALL 생성에 사용된 Voice_Profile 식별자를 해당 자산의 출처 정보로 저장한다

### Requirement 26: 보이스 프로필, 음성 복제 및 동의

**User Story:** 제작자로서 나는 허가받은 목소리를 프로필로 저장해 재사용하고 싶다. 그래서 캐릭터 목소리를 일관되게 유지하면서도 타인의 음성을 오용하지 않는다.

#### Acceptance Criteria

1. WHEN 사용자가 참조 음성 샘플과 프로필 이름을 제출하면, THE Voice_Service SHALL 프로필 이름을 1자 이상 64자 이하로 검증한 후 `cloned` 유형의 Voice_Profile을 생성한다
2. THE Voice_Service SHALL 참조 음성 샘플의 길이를 6초 이상 120초 이하 범위로 검증한다
3. THE Voice_Service SHALL 참조 음성 샘플의 형식을 wav, mp3, flac 중 하나로, 샘플레이트를 16000Hz 이상으로 검증한다
4. IF 참조 음성 샘플이 길이, 형식, 샘플레이트 검증 중 하나를 통과하지 못하면, THEN THE Voice_Service SHALL 등록을 거부하고 위반된 제약 이름과 허용값을 반환한다
5. IF 참조 음성 샘플의 발화 구간 길이 비율이 전체 길이의 60% 미만이면, THEN THE Voice_Service SHALL 등록을 거부하고 측정된 비율과 최소 요구 비율을 반환한다
6. WHEN 참조 음성 샘플이 등록되면, THE Transcription_Service SHALL 해당 샘플의 참조 텍스트를 생성하여 Voice_Profile에 저장한다
7. THE Voice_Service SHALL Voice_Profile당 참조 샘플을 1개 이상 10개 이하로 저장한다
8. WHEN Voice_Profile에 참조 샘플이 2개 이상 존재하면, THE Voice_Service SHALL 해당 샘플들을 결합한 단일 음성 프롬프트를 생성한다
9. THE Voice_Service SHALL 사전 정의 음성 카탈로그를 제공하고 각 항목에 엔진 식별자, 음성 식별자, 언어 코드를 표시한다
10. THE Voice_Service SHALL `preset` 유형 Voice_Profile의 사용 엔진을 카탈로그 출처 엔진으로 고정한다
11. IF 사용자가 `preset` 유형 Voice_Profile을 고정 엔진이 아닌 엔진으로 사용하도록 요청하면, THEN THE Speech_Service SHALL 요청을 거부하고 고정 엔진 식별자를 반환한다
12. WHEN 사용자가 `cloned` 유형 Voice_Profile 생성을 요청하면, THE Voice_Service SHALL 화자 본인 여부, 화자의 명시적 허가 보유 여부, 금지 용도 미사용 확약, 화자 관계 구분(`본인` 또는 `제3자_허가보유`) 4개 항목을 담은 Voice_Consent_Record를 참조 샘플 영구 저장 이전 단계에서 요구한다
13. IF `cloned` 유형 Voice_Profile 생성 요청에 Voice_Consent_Record가 첨부되지 않았거나, 화자 본인 여부와 화자의 명시적 허가 보유 여부가 모두 부정이거나, 금지 용도 미사용 확약이 부정이면, THEN THE Voice_Service SHALL 생성을 거부하고 충족되지 않은 동의 항목 이름 목록을 반환하며 업로드된 참조 샘플을 영구 저장 없이 폐기한다
14. THE Voice_Service SHALL Voice_Consent_Record에 제출자 식별자, 제출 시각, 각 동의 항목 값, 화자 관계 구분, 대상 Voice_Profile 식별자를 저장하고, 화자 관계 구분이 `제3자_허가보유`인 경우 화자 식별 정보와 화자 측 동의 철회 접수 연락 수단을 추가로 저장하며, 저장된 항목 값을 수정 불가 상태로 유지하고 대상 Voice_Profile 삭제 시각으로부터 5년간 보관한다
15. WHEN Voice_Consent_Record가 저장되면, THE MusicStudio SHALL 해당 동의 기록 사건을 Audit_Log에 기록한다
16. THE Moderation_Service SHALL 사칭, 음성 인증 우회, 사기, 괴롭힘, 비동의 성적 콘텐츠, 오해를 유발하는 정치·법률·금융·의료·긴급 상황 안내 6개 분류를 금지 용도 목록으로 유지하고, 대사 스크립트 텍스트와 참조 음성 샘플의 참조 텍스트와 음성 변환 요청의 프로필 지정 정보를 이 6개 분류 기준으로 검사한다
17. IF 대사 생성 요청, 음성 복제 요청, 또는 음성 변환 요청이 6개 금지 용도 분류 중 하나 이상에 해당하면, THEN THE Moderation_Service SHALL 해당 요청을 차단하고 판정된 금지 용도 분류 이름을 반환하며 크레딧을 차감하지 않고 차단 사건을 Audit_Log에 기록한다
18. THE Voice_Service SHALL Voice_Profile의 사용 권한을 소유자에게 부여한다
19. WHERE 소유자가 Voice_Profile 공유를 허용한 경우, THE Voice_Service SHALL 소유자가 지정한 1명 이상 50명 이하의 사용자 목록에만 해당 프로필의 사용을 허용하고 공유 대상 변경 사건을 Audit_Log에 기록한다
20. IF 공유 목록에 포함되지 않은 사용자가 Voice_Profile을 지정하여 대사 생성을 요청하면, THEN THE Speech_Service SHALL 요청을 거부하고 HTTP 403 상태 코드를 반환한다
21. WHEN 사용자가 Voice_Profile 삭제를 요청하면, THE Voice_Service SHALL 요청 접수 시각으로부터 24시간 이내에 해당 프로필의 참조 샘플 파일과 음성 임베딩과 캐시된 음성 프롬프트를 삭제하고 삭제 완료 시각을 기록한다
22. WHILE Voice_Profile이 삭제된 상태인 동안, THE Speech_Service SHALL 해당 프로필 식별자를 지정한 생성 요청에 대해 HTTP 404 상태 코드를 반환한다
23. WHEN 소유자의 요청으로 Voice_Profile이 삭제되면, THE MusicStudio SHALL 삭제 사건을 Audit_Log에 기록하고 해당 프로필로 이미 생성된 Audio_Asset을 변경 없이 유지한다
24. WHEN 사용자가 원본 음성과 대상 Voice_Profile을 지정하여 음성 변환을 요청하면, THE Voice_Service SHALL 원본 발화 내용을 유지하고 음색을 대상 프로필로 변환한 Asset_Kind가 `dialogue`인 Audio_Asset을 산출한다
25. THE Voice_Service SHALL 음성 변환 결과의 길이를 원본 음성 길이 기준 ±100밀리초 이내로 유지한다(불변식)
26. WHEN 사용자가 음성 변환을 요청하면, THE Voice_Service SHALL 원본 음성 권리 보유 확약과 금지 용도 미사용 확약 2개 항목을 담은 Voice_Consent_Record의 저장을 변환 Generation_Job 생성의 선행 조건으로 적용하고, 두 확약 항목 중 하나 이상이 누락되거나 부정인 요청을 거부하며 크레딧을 차감하지 않는다
27. THE MusicStudio SHALL 6개 금지 용도 분류와 동의 철회 절차를 포함한 책임 있는 사용 지침 문서를 `cloned` 유형 Voice_Profile 생성 화면과 음성 변환 요청 화면에서 1회 조작으로 열리는 링크로 제공한다
28. WHEN 화자 또는 화자의 대리인이 Voice_Consent_Record에 기록된 연락 수단 또는 제품 내 철회 접수 창구를 통해 특정 Voice_Profile에 대한 동의 철회를 제출하면, THE Voice_Service SHALL 접수 시각으로부터 24시간 이내에 해당 Voice_Profile을 사용 중지 상태로 전환하고 철회 접수 사건과 상태 전환 사건을 Audit_Log에 기록한다
29. WHILE Voice_Profile이 동의 철회로 사용 중지 상태인 동안, THE Speech_Service SHALL 해당 프로필 식별자를 지정한 대사 생성 요청과 음성 변환 요청을 거부하고 HTTP 403 상태 코드와 동의 철회 사유 코드를 반환하며 크레딧을 차감하지 않는다
30. WHEN Voice_Profile이 동의 철회로 사용 중지 상태로 전환되면, THE Sharing_Service SHALL 해당 프로필로 생성된 공개 상태 Audio_Asset 전체를 24시간 이내에 비공개 상태로 전환하고 소유자에게 전환 사유와 대상 자산 목록을 통지한다

### Requirement 27: 음성 인식 및 타이밍 정렬

**User Story:** 사용자로서 나는 오디오에서 대사와 타이밍을 추출하고 싶다. 그래서 자막, LRC 가사, 타임라인 정렬에 재사용할 수 있다.

#### Acceptance Criteria

1. WHEN 사용자가 Audio_Asset 또는 업로드 오디오에 대한 전사를 요청하면, THE Transcription_Service SHALL 전사 텍스트와 각 행의 시작 시각 및 종료 시각을 밀리초 단위 정수로 담은 1개 이상 2000개 이하의 행 목록을, 요청 접수 시점부터 대상 오디오 길이(초)와 선택된 등급의 1초당 최대 처리 시간(초)의 곱에 60초를 더한 시간 이내에 반환한다
2. THE Transcription_Service SHALL 전사 모델 등급을 2개 이상 5개 이하로 제공하고, 각 등급에 대해 모델 식별자와 오디오 길이 1초당 최대 처리 시간을 0.01초 이상 5.00초 이하의 초 단위 수치로 표시한다
3. WHERE 전사 요청에 ISO 639-1 2문자 언어 코드가 지정된 경우, THE Transcription_Service SHALL 해당 언어 코드를 전사 힌트로 대상 엔진에 전달하고 응답의 언어 코드 항목에 동일한 값을 포함한다
4. WHEN 언어 코드가 지정되지 않은 전사 요청이 접수되면, THE Transcription_Service SHALL 언어를 자동 판별하여 ISO 639-1 2문자 언어 코드와 0.00 이상 1.00 이하의 판별 신뢰도를 응답에 포함하고, 판별 신뢰도가 0.50 미만인 경우 언어 미확정 표시를 응답에 함께 포함한다
5. THE Transcription_Service SHALL 전사 요청 오디오가 길이 0.5초 이상 3600초 이하, 파일 크기 500메가바이트 이하, 샘플레이트 8000헤르츠 이상 48000헤르츠 이하 조건을 모두 충족함을 검증한다
6. THE Transcription_Service SHALL 전사 결과의 모든 시작 시각과 종료 시각을 0 이상 대상 오디오 길이 이하 범위로 유지한다(불변식)
7. THE Transcription_Service SHALL 전사 결과의 각 행에 대해 시작 시각이 종료 시각보다 작음을 유지한다(불변식)
8. THE Transcription_Service SHALL 전사 결과 행들을 시작 시각 오름차순으로 정렬된 상태로 유지한다(불변식)
9. WHEN Requirement 10에 정의된 Timed_Lyrics 생성이 시작되면, THE MusicStudio SHALL Transcription_Service의 행 단위 시작 시각을 유일한 타이밍 원천으로 사용하고, 행 텍스트로는 대상 Track에 Lyrics_Document 원문이 존재하면 해당 원문의 행을, 존재하지 않으면 전사 텍스트의 행을 사용한다
10. THE MusicStudio SHALL Requirement 10에 정의된 LRC_Printer와 LRC_Parser를 Transcription_Service 결과의 유일한 LRC 직렬화 및 역직렬화 경로로 사용하고, Requirement 10의 왕복 오차 상한 10밀리초를 전사 결과의 왕복 변환에도 동일하게 적용한다
11. WHEN 사용자가 전사 결과의 특정 행 텍스트를 1자 이상 500자 이하의 값으로 수정하면, THE Transcription_Service SHALL 수정된 텍스트를 저장하고 해당 행의 시작 시각과 종료 시각을 수정 이전 값과 동일하게 유지한다
12. IF 전사 대상 오디오에서 검출된 발화 구간의 총 길이가 200밀리초 미만이면, THEN THE Transcription_Service SHALL 빈 행 목록과 발화 미검출 사유 코드를 반환하고 대상 오디오 파일을 변경 없이 유지한다
13. WHEN 사용자가 전사 결과 다운로드를 요청하면, THE Transcription_Service SHALL Requirement 10의 LRC_Printer로 생성한 LRC 형식 파일과, 행 순서가 전사 결과와 동일한 평문 텍스트 파일을 제공한다
14. WHEN Asset_Kind가 `dialogue`인 Audio_Asset의 생성이 완료되면, THE Speech_Service SHALL 합성 과정에서 확정된 스크립트 행 경계를 밀리초 단위 정수 시작 시각 및 종료 시각으로 저장하고, 해당 자산의 타이밍 원천으로 이 저장값을 사용한다
15. IF 전사 요청 오디오가 길이, 파일 크기, 샘플레이트 검증 중 하나 이상을 통과하지 못하면, THEN THE Transcription_Service SHALL 요청을 거부하고 위반된 제약 이름, 측정값, 허용 범위를 반환하며 대상 오디오 파일을 변경 없이 유지한다
16. IF 대상 엔진이 전사 실패를 반환하거나 27.1에 정의된 응답 시간 상한이 경과하면, THEN THE Transcription_Service SHALL 해당 전사를 실패 상태로 종료하고 실패 사유 코드를 반환하며 기존에 저장된 전사 결과를 변경 없이 유지한다
17. IF 사용자의 행 시각 수정 요청 결과가 27.6, 27.7, 27.8 불변식 중 하나 이상을 위반하면, THEN THE Transcription_Service SHALL 해당 요청을 거부하고 위반된 불변식 이름과 허용 시각 범위를 반환하며 해당 행의 수정 이전 시작 시각과 종료 시각을 유지한다

### Requirement 28: 멀티트랙 타임라인 프로젝트

**User Story:** 창작자로서 나는 배경음악, 효과음, 대사를 한 타임라인에 배치하고 하나의 파일로 내보내고 싶다. 그래서 완성된 장면 오디오를 만들 수 있다.

#### Acceptance Criteria

1. WHEN 사용자가 프로젝트 생성을 요청하면, THE Timeline_Service SHALL 이름, 설명, 빈 Timeline_Clip 목록을 가진 Timeline_Project를 생성한다
2. THE Timeline_Service SHALL 각 Timeline_Clip에 대해 자산 식별자, `start_time_ms`, `track`, `trim_start_ms`, `trim_end_ms`, 게인, 페이드 인 길이, 페이드 아웃 길이, 음소거 여부를 저장한다
3. THE Timeline_Service SHALL Timeline_Project의 모든 시각 값을 밀리초 단위 정수로 저장한다
4. THE Timeline_Service SHALL `track` 값을 0 이상 31 이하 정수 범위로 검증한다
5. THE Timeline_Service SHALL Timeline_Project당 Timeline_Clip 개수를 500개 이하로 유지하며, 501번째 클립 추가 요청을 거부하고 현재 클립 개수와 상한 500을 포함한 오류를 반환한다
6. WHEN 사용자가 시작 시각을 지정하지 않고 Audio_Asset을 프로젝트에 추가하면, THE Timeline_Service SHALL 기존 클립이 0개인 경우 `start_time_ms`를 0으로 설정하고, 기존 클립이 1개 이상인 경우 기존 클립들의 최대 종료 시각에 200밀리초를 더한 값으로 설정한다
7. THE Timeline_Service SHALL 동일 `track` 값을 가진 두 Timeline_Clip의 재생 구간이 겹치지 않는 상태를 유지한다(불변식)
8. IF 클립 추가 또는 이동 결과로 동일 `track`의 재생 구간이 겹치면, THEN THE Timeline_Service SHALL 해당 요청을 거부하고 충돌한 클립 식별자와 겹침 길이를 반환한다
9. THE Mixdown_Renderer SHALL 서로 다른 `track` 값을 가진 Timeline_Clip들을 동시에 재생되는 오디오로 합산한다
10. THE Timeline_Service SHALL 각 Timeline_Clip에 대해 `trim_start_ms`가 0 이상이며 `trim_start_ms`와 `trim_end_ms`의 합이 원본 자산 길이보다 작음을 유지한다(불변식)
11. IF 트리밍 요청의 `trim_start_ms`와 `trim_end_ms`의 합이 원본 자산 길이 이상이면, THEN THE Timeline_Service SHALL 요청을 거부하고 허용 최대 트림 값을 반환한다
12. THE Timeline_Service SHALL 트리밍을 원본 Audio_Asset 파일을 변경하지 않는 방식으로 적용한다
13. THE Timeline_Service SHALL 각 Timeline_Clip의 재생 길이를 `원본 자산 길이 - trim_start_ms - trim_end_ms`와 동일하게 유지한다(불변식)
14. WHEN 사용자가 특정 시각에서 Timeline_Clip 분할을 요청하면, THE Timeline_Service SHALL 동일 자산을 참조하는 두 클립을 생성하고 두 클립의 재생 길이 합을 분할 이전 클립의 재생 길이와 동일하게 유지한다(불변식)
15. WHEN 사용자가 Timeline_Clip 복제를 요청하면, THE Timeline_Service SHALL 원본 클립의 트림 값과 게인과 페이드 값을 보존한 클립을 원본 클립 종료 시각에서 200밀리초 뒤에 배치한다
16. THE Timeline_Service SHALL 클립 게인 입력을 -40데시벨 이상 +12데시벨 이하 범위로 검증한다
17. THE Timeline_Service SHALL 클립 페이드 인 길이와 페이드 아웃 길이를 각각 0밀리초 이상이며 해당 클립 재생 길이의 50% 이하로 검증한다
18. THE Timeline_Service SHALL 트랙 음량 입력을 -60데시벨 이상 +12데시벨 이하로, 트랙 팬 입력을 -1.0 이상 +1.0 이하로 검증한다
19. WHILE 하나 이상의 트랙이 솔로 상태인 동안, THE Mixdown_Renderer SHALL 솔로 상태인 트랙에 속하고 음소거 상태가 아닌 클립만 렌더링 대상 클립 집합에 포함한다
20. WHILE 트랙 또는 클립이 음소거 상태인 동안, THE Mixdown_Renderer SHALL 해당 트랙 또는 클립의 클립을 렌더링 대상 클립 집합에서 제외하고, 동일 트랙이 솔로 상태이면서 음소거 상태인 경우 음소거를 우선 적용하여 제외한다
21. WHERE 스냅 기능이 활성화된 경우, WHEN 사용자가 클립 이동을 요청하면, THE Timeline_Service SHALL 요청된 시작 시각으로부터 50밀리초 이내에 있는 스냅 후보(인접 클립의 시작 시각, 인접 클립의 종료 시각, 프로젝트 템포와 박자 설정으로 산출한 마디 경계) 중 거리가 가장 가까운 후보로 시작 시각을 정렬하고, 거리가 같은 후보가 2개 이상이면 시각이 더 작은 후보를 선택하며, 후보가 0개이면 요청된 시작 시각을 그대로 적용하고, 프로젝트에 템포 값이 설정되지 않은 경우 마디 경계 후보를 0개로 취급한다
22. THE Timeline_Service SHALL 프로젝트당 최근 100회의 편집 조작을 되돌리기 이력으로 보관하고, 101번째 조작이 기록되면 가장 오래된 1건을 제거하며, 되돌리기 이후 새 편집 조작이 기록되면 다시 실행 이력을 0건으로 비운다
23. WHEN 편집 조작(클립 추가, 클립 이동, 트리밍, 분할, 복제, 삭제, 클립 게인 변경, 페이드 변경, 클립 음소거 전환, 트랙 음량 변경, 트랙 팬 변경, 트랙 솔로 전환) 1건이 성공한 직후 되돌리기 1회와 다시 실행 1회가 순서대로 수행되면, THE Timeline_Service SHALL 조작 직후 상태와 프로젝트 동등 관계로 동등한 Timeline_Project 상태를 산출한다(왕복 속성)
24. WHEN 사용자가 믹스다운 내보내기를 요청하면, THE Mixdown_Renderer SHALL 렌더링 대상 클립을 각 `start_time_ms`에 배치하여 합산한 단일 오디오를 시각 0에서 시작하도록 산출하고, 합산 결과의 최대 절대 진폭이 1.0 이하이면 샘플 값을 변경하지 않고 감쇠량 0데시벨로 기록하여 Asset_Kind가 `mix`인 Audio_Asset으로 저장한다
25. THE Mixdown_Renderer SHALL 믹스다운 길이를 시각 0부터 렌더링 대상 클립의 `start_time_ms`와 재생 길이의 합 중 최대값까지의 구간 길이와 10밀리초 이내의 오차로 동일하게 유지하고, 렌더링 대상에서 제외된 클립을 길이 계산에 포함하지 않는다(불변식)
26. WHEN 모든 클립의 `start_time_ms`가 명시적으로 지정된 동일한 클립 집합에 대해 클립 추가 순서만 다르게 구성된 두 Timeline_Project의 믹스다운이 동일한 렌더링 파라미터로 각각 요청되면, THE Mixdown_Renderer SHALL 두 결과의 샘플 개수를 동일하게 산출하고 대응하는 모든 샘플 값의 차이 절대값을 0.0001 이하로 유지한다(가환 속성)
27. WHEN 동일한 Timeline_Project와 동일한 렌더링 파라미터(출력 샘플레이트, 출력 채널 수, 트랙별 음량·팬·음소거·솔로 상태, 클립별 게인·페이드·트림 값, 클립별 Effect_Chain, 피크 정규화 활성 여부)로 믹스다운이 3회 요청되면, THE Mixdown_Renderer SHALL 3회 결과의 샘플 개수와 대응하는 모든 샘플 값을 정확히 동일하게 산출하며, 3회 중 1회 이상이 다른 렌더링 작업자에서 처리되는 경우에도 동일하게 산출한다(재현성 불변식)
28. IF 합산 결과의 최대 절대 진폭이 1.0을 초과하면, THEN THE Mixdown_Renderer SHALL 모든 샘플에 동일한 단일 감쇠 계수를 적용하여 결과의 최대 절대 진폭을 0.99 이상 1.0 이하로 조정하고, 적용된 감쇠량을 0데시벨 초과 40데시벨 이하의 데시벨 값으로 응답과 `mix` Audio_Asset 메타데이터에 포함한다
29. IF 믹스다운 요청 시점에 Timeline_Clip이 0개이거나 음소거·솔로 상태 적용 후 렌더링 대상 클립이 0개이면, THEN THE Mixdown_Renderer SHALL 요청을 거부하고 렌더링 대상 부재 사유 코드를 반환하며 Timeline_Project 상태를 변경하지 않는다
30. THE Project_Printer SHALL Timeline_Project를 JSON 프로젝트 문서로 변환한다
31. THE Project_Parser SHALL JSON 프로젝트 문서를 Timeline_Project로 변환한다
32. WHEN 유효한 Timeline_Project가 Project_Printer로 직렬화된 후 Project_Parser로 역직렬화되면, THE MusicStudio SHALL 프로젝트 이름, 설명, 클립 목록의 순서, 각 클립의 클립 식별자·자산 식별자·`start_time_ms`·`track`·`trim_start_ms`·`trim_end_ms`·게인·페이드 인 길이·페이드 아웃 길이·음소거 여부, 각 트랙의 음량·팬·음소거 상태·솔로 상태가 원본과 일치하는 Timeline_Project를 산출하며, 이때 시각 값과 식별자는 정확히 일치하고 게인과 트랙 음량은 0.1데시벨 이내로 일치하고 팬은 0.01 이내로 일치하며, 되돌리기 이력과 생성·수정 시각은 비교 대상에서 제외한다(왕복 속성, 프로젝트 동등 관계 정의)
33. WHEN 파싱에 성공한 JSON 프로젝트 문서가 Project_Parser로 파싱된 후 Project_Printer로 출력되고 다시 Project_Parser로 파싱되면, THE MusicStudio SHALL 1회차 파싱 결과와 2회차 파싱 결과를 프로젝트 동등 관계로 동등하게 산출하고, 2회차 출력 문서와 1회차 출력 문서의 바이트 열을 동일하게 유지한다(멱등 속성)
34. IF JSON 프로젝트 문서가 존재하지 않는 자산 식별자를 참조하면, THEN THE Project_Parser SHALL 해당 참조 위치와 누락된 자산 식별자를 포함한 오류를 반환한다
35. WHEN 사용자가 재생 위치를 이동하면, THE Timeline_Service SHALL 모든 트랙의 재생 위치를 요청된 시각과 20밀리초 이내의 오차로 동일하게 유지한다
36. WHEN Timeline_Project에서 참조된 Audio_Asset이 삭제 표시 상태로 전환되면, THE Timeline_Service SHALL 해당 클립을 참조 불가 상태로 표시하고 프로젝트 조회 응답에 참조 불가 클립 식별자 목록을 포함한다
37. WHEN 편집 조작 1건이 성공한 직후 되돌리기 1회가 수행되면, THE Timeline_Service SHALL 해당 조작 직전 상태와 프로젝트 동등 관계로 동등한 Timeline_Project 상태를 산출한다(역연산 속성)
38. IF 되돌리기 이력이 0건인 상태에서 되돌리기가 요청되거나 다시 실행 이력이 0건인 상태에서 다시 실행이 요청되면, THEN THE Timeline_Service SHALL 요청을 거부하고 이력 부재 사유 코드를 반환하며 Timeline_Project 상태를 변경하지 않는다
39. THE Timeline_Service SHALL Timeline_Project에 템포 값을 30 이상 300 이하 정수 BPM으로, 박자 값을 2, 3, 4, 6 중 하나로 저장하고, 두 값이 지정되지 않은 프로젝트에서 마디 경계 스냅을 적용하지 않는다

### Requirement 29: 이펙트 체인 및 버전 관리

**User Story:** 창작자로서 나는 원본을 훼손하지 않고 여러 이펙트 버전을 만들어 비교하고 싶다. 그래서 마음에 드는 버전만 남길 수 있다.

#### Acceptance Criteria

1. THE Effects_Service SHALL 코러스/플랜저, 리버브, 딜레이, 컴프레서, 게인, 하이패스 필터, 로우패스 필터, 피치 시프트 8종의 이펙트 종류를 제공한다
2. THE Effects_Service SHALL 코러스/플랜저 파라미터를 `rate_hz` 0.01 이상 20 이하, `depth` 0.0 이상 1.0 이하, `feedback` 0.0 이상 0.95 이하, `centre_delay_ms` 0.5 이상 50 이하, `mix` 0.0 이상 1.0 이하 범위로 검증한다
3. THE Effects_Service SHALL 리버브 파라미터 `room_size`, `damping`, `wet_level`, `dry_level`, `width`를 각각 0.0 이상 1.0 이하 범위로 검증한다
4. THE Effects_Service SHALL 딜레이 파라미터를 `delay_seconds` 0.01 이상 2.0 이하, `feedback` 0.0 이상 0.95 이하, `mix` 0.0 이상 1.0 이하 범위로 검증한다
5. THE Effects_Service SHALL 컴프레서 파라미터를 `threshold_db` -60 이상 0 이하, `ratio` 1.0 이상 20.0 이하, `attack_ms` 0.1 이상 100 이하, `release_ms` 10 이상 1000 이하 범위로 검증한다
6. THE Effects_Service SHALL 게인 파라미터 `gain_db`를 -40 이상 40 이하 범위로 검증한다
7. THE Effects_Service SHALL 하이패스 필터 `cutoff_frequency_hz`를 20 이상 8000 이하 범위로, 로우패스 필터 `cutoff_frequency_hz`를 200 이상 20000 이하 범위로 검증한다
8. THE Effects_Service SHALL 피치 시프트 파라미터 `semitones`를 -12 이상 12 이하 범위로 검증하고, 피치 시프트를 재생 속도를 변경하지 않고 시간축 길이를 보존하는 방식으로 적용한다
9. IF Effect_Chain에 등록되지 않은 이펙트 종류 이름 또는 등록되지 않은 파라미터 이름이 포함되면, THEN THE Effects_Service SHALL 적용을 거부하고 위반된 이름을 반환한다
10. IF Effect_Chain의 파라미터 값이 허용 범위를 벗어나면, THEN THE Effects_Service SHALL 적용을 거부하고 위반된 파라미터 이름과 허용 범위를 반환한다
11. THE Effects_Service SHALL Effect_Chain을 순서가 보존된 JSON 배열로 저장한다
12. THE Effects_Service SHALL Effect_Chain의 이펙트를 배열 순서대로 순차 적용한다
13. THE Effects_Service SHALL Effect_Chain당 이펙트 항목 개수를 1개 이상 16개 이하로 검증한다
14. WHEN Effect_Chain이 Audio_Asset의 한 Generation_Version에 적용되면, THE Effects_Service SHALL 입력 버전의 오디오 데이터와 원본 오디오 파일을 변경하지 않고, 입력 버전 식별자를 파생 원본 버전 식별자로 기록한 새 Generation_Version 1개를 생성하며 기존 기본 버전 지정을 변경하지 않는다
15. THE Effects_Service SHALL 각 Audio_Asset에 대해 Effect_Chain이 지정되지 않은 원본 버전을 정확히 1개 보존하고 그 오디오 데이터를 수정하거나 대체하지 않는다(불변식)
16. THE Effects_Service SHALL 각 Audio_Asset의 Generation_Version 중 기본 버전 여부가 참인 버전의 개수를 항상 정확히 1개로 유지한다(불변식)
17. WHEN 기본 버전인 Generation_Version이 삭제되면, THE Effects_Service SHALL 남은 Generation_Version 중 생성 시각이 가장 늦은 버전을 기본 버전으로 승격하고, 생성 시각이 동일한 버전이 2개 이상이면 그중 버전 식별자 오름차순 첫 번째 버전을 승격한다
18. IF 사용자가 Audio_Asset의 원본 버전 삭제를 요청하면, THEN THE Effects_Service SHALL 요청을 거부하고 원본 버전 보존 사유 코드를 반환한다
19. IF Audio_Asset의 Generation_Version 개수가 원본 버전을 포함하여 16개인 상태에서 새 Generation_Version 생성이 요청되면, THEN THE Effects_Service SHALL 요청을 거부하고 현재 버전 개수와 상한 16을 반환하며 기존 버전 목록과 기본 버전 지정을 변경하지 않는다
20. THE Effects_Service SHALL 각 Generation_Version에 대해 버전 식별자, 1자 이상 60자 이하의 사용자 지정 이름, 적용된 Effect_Chain, 파생 원본 버전 식별자, 기본 버전 여부, 원본 버전 여부, 밀리초 단위 생성 시각, 밀리초 단위 오디오 길이를 저장한다
21. THE Effects_Service SHALL 내장 Effect_Preset을 4개 이상 제공한다
22. WHEN 사용자가 Effect_Preset 생성을 요청하면, THE Effects_Service SHALL 1자 이상 60자 이하 이름과 1개 이상 16개 이하 이펙트 항목을 가진 해당 Effect_Chain을 요청자 소유 프리셋으로 저장한다
23. IF 사용자가 내장 Effect_Preset의 수정 또는 삭제를 요청하면, THEN THE Effects_Service SHALL 요청을 거부하고 내장 프리셋 변경 불가 사유를 반환하며 해당 프리셋의 이름과 Effect_Chain을 변경하지 않는다
24. THE Chain_Printer SHALL Effect_Chain을 JSON 문서로 변환한다
25. THE Chain_Parser SHALL JSON 문서를 Effect_Chain으로 변환한다
26. FOR ALL 유효한 Effect_Chain에 대해, THE MusicStudio SHALL JSON으로 출력한 후 재파싱한 결과가 원본 Effect_Chain과 체인 동등 관계로 동등함을 보장한다(왕복 속성). 체인 동등 관계는 이펙트 항목 개수가 같고, 동일 인덱스의 이펙트 종류 이름이 문자 단위로 같고, 동일 인덱스의 파라미터 이름 집합이 같으며, 대응하는 모든 수치 파라미터 값의 절대 차이가 0.000001 이하인 상태로 정의한다
27. FOR ALL 파싱에 성공한 Effect_Chain JSON 문서에 대해, THE MusicStudio SHALL 파싱 후 출력한 문서를 다시 파싱한 결과가 첫 파싱 결과와 체인 동등 관계를 만족함을 보장하고, 1회 출력 문서와 2회 출력 문서를 바이트 단위로 동일하게 산출한다(멱등 속성)
28. WHEN 사용자가 Effect_Chain 미리듣기를 요청하면, THE Effects_Service SHALL 처리된 오디오를 새 Generation_Version으로 저장하지 않고 스트림으로 반환한다
29. WHEN 동일한 원본 버전 오디오와 체인 동등 관계를 만족하는 Effect_Chain으로 처리가 2회 이상 요청되면, THE Effects_Service SHALL 매 회 동일한 샘플레이트와 동일한 채널 수와 동일한 샘플 개수의 오디오를 산출하고 대응하는 모든 샘플 값의 차이를 0으로 유지한다(재현성 불변식)
30. WHEN 딜레이 이펙트와 리버브 이펙트를 모두 포함하지 않은 Effect_Chain이 적용되면, THE Effects_Service SHALL 처리된 Generation_Version의 오디오 길이를 원본 버전 길이와 10밀리초 이내의 오차로 동일하게 유지한다(불변식)
31. WHERE Timeline_Clip에 Effect_Chain이 지정된 경우, THE Mixdown_Renderer SHALL 트림이 적용된 클립 오디오에 지정된 Effect_Chain을 적용하고 그 결과를 해당 클립의 재생 길이로 잘라낸 뒤 클립 게인과 페이드를 적용한 오디오를 합산한다
32. WHEN 딜레이 이펙트 또는 리버브 이펙트를 포함한 Effect_Chain이 적용되면, THE Effects_Service SHALL 원본 버전 길이에 10000밀리초를 더한 값을 초과하는 테일 구간을 제거하여 처리된 Generation_Version의 오디오 길이를 원본 버전 길이 이상이며 원본 버전 길이에 10000밀리초를 더한 값 이하로 유지한다(불변식)
33. IF Effect_Chain JSON 문서가 JSON 배열이 아니거나, 이펙트 항목 개수가 1개 미만 또는 16개 초과이거나, 등록되지 않은 이펙트 종류 이름 또는 등록되지 않은 파라미터 이름을 포함하거나, 파라미터 값이 29.2부터 29.8에 정의된 허용 범위를 벗어나면, THEN THE Chain_Parser SHALL 변환을 거부하고 첫 위반 항목의 배열 인덱스와 위반 사유를 반환하며 Effect_Chain을 산출하지 않는다
34. WHEN 사용자가 특정 Generation_Version을 기본 버전으로 지정하면, THE Effects_Service SHALL 해당 버전의 기본 버전 여부를 참으로 설정하고 동일 Audio_Asset의 다른 모든 Generation_Version의 기본 버전 여부를 거짓으로 설정한다
35. THE Effects_Service SHALL 사용자당 Effect_Preset 개수를 100개 이하로 유지하며, 101번째 프리셋 생성 요청을 거부하고 현재 개수와 상한 100을 반환한다

### Requirement 30: AI 보조 믹싱 및 마스터링

**User Story:** 창작자로서 나는 믹싱과 마스터링 파라미터를 자동으로 제안받고 직접 손볼 수 있기를 원한다. 그래서 전문 지식 없이도 결과를 다듬고 최종 판단은 내가 한다.

#### Acceptance Criteria

1. WHEN 사용자가 Audio_Asset 또는 믹스다운 결과에 대해 마스터링 제안을 요청하면, THE Mastering_Assistant SHALL 제안된 Effect_Chain과 각 파라미터 값을 사용자가 조회할 수 있는 형태로 반환한다
2. THE Mastering_Assistant SHALL 제안된 Effect_Chain의 모든 파라미터 값을 Requirement 29에 정의된 허용 범위 안의 값으로 산출한다(불변식)
3. WHEN 사용자가 제안된 파라미터 값을 수정하면, THE Effects_Service SHALL 수정된 값으로 처리를 수행하고 원래 제안 값을 함께 보관한다
4. WHEN 마스터링 제안이 반환되면, THE Mastering_Assistant SHALL 제안 적용 이전 오디오와 제안 적용 이후 오디오를 모두 재생 가능한 상태로 제공한다
5. THE Mastering_Assistant SHALL 라우드니스 목표값 입력을 -30.0LUFS 이상 -6.0LUFS 이하 범위에서 0.1LUFS 단위 값으로 검증하고, 목표값이 지정되지 않은 요청에는 -14.0LUFS를 목표값으로 적용한다
6. WHERE 입력 오디오에 -70.0LUFS 절대 게이트를 초과하는 게이팅 블록이 1개 이상 존재하고 목표값 도달에 필요한 게인을 적용한 결과의 트루 피크가 -1.0dBTP 이하인 경우, WHEN 사용자가 라우드니스 정규화를 요청하면, THE Mastering_Assistant SHALL 결과 오디오의 통합 라우드니스를 목표값 기준 ±0.5LUFS 이내로 조정한다
7. THE Mastering_Assistant SHALL 라우드니스 정규화 결과 오디오의 트루 피크를 -1.0dBTP 이하로 유지하고, 트루 피크 상한 준수를 목표 라우드니스 도달보다 우선하여 적용한다(불변식)
8. WHEN 통합 라우드니스가 목표값 기준 ±0.5LUFS 이내인 오디오에 동일 목표값의 라우드니스 정규화가 다시 적용되면, THE Mastering_Assistant SHALL 적용 게인 변화량을 0.1데시벨 이하로 유지하고, 결과 오디오의 통합 라우드니스를 재적용 이전 값 기준 ±0.1LUFS 이내로, 트루 피크를 재적용 이전 값 기준 ±0.1데시벨 이내로 유지한다(멱등 속성)
9. WHEN 사용자가 대사 정리를 요청하면, THE Mastering_Assistant SHALL 발화 구간이 아닌 구간의 평균 RMS 레벨을 입력 오디오 대비 10.0데시벨 이상 낮추고 발화 구간의 통합 라우드니스를 입력 오디오 대비 ±1.0LUFS 이내로 유지한 오디오를 새 Generation_Version으로 산출한다
10. THE Mastering_Assistant SHALL 대사 정리 결과의 오디오 길이를 입력 오디오 길이와 10밀리초 이내의 오차로 동일하게 유지한다(불변식)
11. WHEN 사용자가 음성 향상을 요청하면, THE Mastering_Assistant SHALL 향상 처리된 오디오를 새 Generation_Version으로 산출하고 원본 버전을 보존한다
12. WHEN 사용자가 대사 트랙과 배경음악 트랙을 지정하여 자동 감쇠를 요청하면, THE Mastering_Assistant SHALL 대사 트랙에서 100밀리초 창의 RMS 레벨이 -45.0데시벨 이상인 200밀리초 이상 연속 구간을 발화 구간으로 판정하고, 해당 구간에서 배경음악 트랙의 음량을 지정된 감쇠 깊이 기준 ±1.0데시벨 이내로 감쇠한다
13. THE Mastering_Assistant SHALL 감쇠 깊이 입력을 -24데시벨 이상 -3데시벨 이하 범위로 검증하고 기본값 -12데시벨을 적용한다
14. THE Mastering_Assistant SHALL 감쇠 어택 시간 입력을 10밀리초 이상 500밀리초 이하 범위로 검증하고 기본값 50밀리초를 적용한다
15. THE Mastering_Assistant SHALL 감쇠 릴리즈 시간 입력을 50밀리초 이상 2000밀리초 이하 범위로 검증하고 기본값 300밀리초를 적용한다
16. WHILE 대사 트랙에서 발화 구간으로 판정되지 않는 구간인 동안, THE Mastering_Assistant SHALL 배경음악 트랙의 음량을 감쇠 이전 값 기준 ±0.5데시벨 이내로 유지한다
17. THE Mastering_Assistant SHALL 자동 감쇠 결과를 트랙 음량 자동화 값으로 저장하여 사용자가 조회하고 수정할 수 있도록 한다
18. WHEN 동일한 입력 오디오와 동일한 처리 파라미터로 마스터링 처리가 2회 이상 요청되면, THE Mastering_Assistant SHALL 매 회 샘플 단위로 동일한 오디오를 산출한다(재현성 불변식)
19. THE MusicStudio SHALL 파라미터 제안 모델을 MusicStudio 기본 실행 환경과 분리된 별도 서비스로 배포한다
20. IF 파라미터 제안 서비스의 응답이 요청 후 120초 이내에 도착하지 않으면, THEN THE Mastering_Assistant SHALL 해당 요청을 중단하고 파라미터 제안 서비스를 사용 불가 상태로 판정한다
21. IF 파라미터 제안 서비스가 사용 불가 상태이면, THEN THE Mastering_Assistant SHALL 내장 Effect_Preset 기반 기본 제안을 5초 이내에 반환하고 제안 출처를 모델 제안 또는 기본 제안 중 하나의 값으로 응답에 포함한다
22. THE Mastering_Assistant SHALL 마스터링 제안 응답에 라우드니스 측정 규약으로 측정한 통합 라우드니스와 트루 피크, 그리고 31.5Hz, 63Hz, 125Hz, 250Hz, 500Hz, 1000Hz, 2000Hz, 4000Hz, 8000Hz, 16000Hz 중심의 옥타브 대역 10개에 대한 대역별 평균 에너지 값을 포함한다
23. IF 파라미터 제안 모델의 License_Descriptor의 상업적 사용 허용 여부가 거짓이면, THEN THE MusicStudio SHALL 해당 모델의 제안을 적용한 Audio_Asset의 상업적 사용 허용 여부를 거짓으로 기록한다
24. THE Mastering_Assistant SHALL 통합 라우드니스를 ITU-R BS.1770-4의 K-가중과 게이팅(400밀리초 블록, 절대 게이트 -70.0LUFS, 상대 게이트 -10.0LU)을 오디오 전체 구간에 적용하여 측정하고, 트루 피크를 ITU-R BS.1770-4의 4배 이상 오버샘플링 방식으로 측정하며, 두 측정값을 0.1 단위로 반올림하여 보고한다
25. IF 목표 라우드니스 도달에 필요한 게인을 적용한 결과의 트루 피크가 -1.0dBTP를 초과하면, THEN THE Mastering_Assistant SHALL 트루 피크가 -1.0dBTP 이하인 오디오를 산출하고, 달성한 통합 라우드니스 값과 목표값 대비 미달량 및 목표 미달 여부를 응답에 포함하며, 입력 Generation_Version을 변경하지 않고 보존한다
26. IF 라우드니스 목표값, 감쇠 깊이, 감쇠 어택 시간, 감쇠 릴리즈 시간 중 하나 이상의 입력값이 30.5, 30.13, 30.14, 30.15에 정의된 허용 범위를 벗어나면, THEN THE Mastering_Assistant SHALL 처리를 거부하고 위반된 파라미터 이름과 해당 허용 범위를 반환하며 새 Generation_Version을 생성하지 않는다

### Requirement 31: 디자인 시스템 및 모션

**User Story:** 사용자로서 나는 일관되고 매끄러운 인터페이스를 원하지만 애니메이션이 작업을 방해하지 않기를 바란다. 그래서 모션은 상태를 알려주는 역할까지만 해야 한다.

#### Acceptance Criteria

1. THE MusicStudio SHALL 진입 전환, 호버 상호작용, 텍스트 표시, 로딩 표시 4개 범주 각각에 대해 고정된 Amicro 레지스트리 버전이 제공하는 구성요소 목록에 등재된 구성요소를 1개 이상 사용하고, 각 범주에서 모션이 적용된 구성요소 중 해당 목록에 등재된 구성요소의 비율을 100%로 유지한다(불변식)
2. THE MusicStudio SHALL `components.json`의 `registries` 필드에 `@amicro` 이름공간을 등록하고 해당 이름공간을 통해 구성요소를 설치한다
3. THE MusicStudio SHALL Amicro 레지스트리 참조를 특정 버전 태그 또는 커밋 식별자로 고정한다
4. THE MusicStudio SHALL 모션이 적용된 모든 구성요소의 스프링 전환값을 Amicro_Motion_Preset 5개(`snappy`, `bouncy`, `smooth`, `gentle`, `stiff`) 중 정확히 하나의 프리셋 값과 동일하게 유지한다(불변식)
5. IF 정적 검사 실행 중 모션 전환값이 Amicro_Motion_Preset 식별자 참조가 아니라 스프링 파라미터(강성, 감쇠, 질량, 지속 시간) 수치 리터럴로 표기된 구성요소가 1개 이상 발견되면, THEN THE MusicStudio SHALL 정적 검사 결과를 실패로 반환하고, 위반 1건당 1개 항목으로 위반 구성요소 이름과 위반 파라미터 값을 보고하며, 빌드 산출물을 생성하지 않는다
6. WHILE Generation_Job이 대기 또는 진행 상태인 동안, THE MusicStudio SHALL `waveform-loader`, `apple-equalizer`, `apple-sound-wave`, `siri-wave`, `wave-physics-loader`, `symmetric-wave`, `fluid-bars`, `spring-bars` 중 하나의 구성요소로 진행 상태를 표시하고, 대기 또는 진행 상태 진입 시각으로부터 300밀리초 이내에 해당 표시를 화면에 나타낸다
7. WHILE Generation_Job이 대기 또는 진행 상태인 동안, THE MusicStudio SHALL 진행률을 0 이상 100 이하의 정수 백분율로 또는 대기 순번을 1 이상의 정수로 진행 상태 표시와 함께 텍스트로 표시하고, 해당 텍스트를 2초 이내 간격으로 갱신한다
8. THE MusicStudio SHALL `use-reduced-motion` 훅으로 `prefers-reduced-motion: reduce` 설정 여부를 판별한다
9. WHILE `prefers-reduced-motion: reduce`가 설정된 동안, THE MusicStudio SHALL Motion_Classification_Table에서 장식 목적으로 분류된 모든 애니메이션의 재생 프레임 수를 0으로 유지하고, 해당 구성요소를 애니메이션 종료 상태로 즉시 표시한다
10. WHILE `prefers-reduced-motion: reduce`가 설정된 동안, THE MusicStudio SHALL Motion_Classification_Table에서 상태 전달 목적으로 분류된 모든 애니메이션의 지속 시간을 200밀리초 이하로 유지한다
11. WHILE 애니메이션이 재생되는 동안, THE MusicStudio SHALL 모든 대화형 구성요소의 포인터 입력과 키보드 입력 수신 상태를 유지하고, 입력이 차단되는 시간을 0밀리초로 유지한다(불변식)
12. WHEN 사용자가 애니메이션 재생 중 대화형 구성요소를 조작하면, THE MusicStudio SHALL 해당 조작에 대한 시각적 응답을 100밀리초 이내에 표시한다
13. THE MusicStudio SHALL 애니메이션이 적용된 모든 대화형 구성요소에 대해 키보드 탭 이동 순서를 시각적 배치 순서와 일치하게 유지한다
14. THE MusicStudio SHALL 애니메이션이 적용된 모든 대화형 구성요소에 대해 포커스 이동 후 100밀리초 이내에 포커스 표시를 나타내고, 애니메이션 재생 중에도 포커스 표시 영역과 대상 구성요소 화면 영역의 경계 차이를 2 CSS 픽셀 이하로 유지한다
15. WHEN 외부 레지스트리에 대한 네트워크 접근이 불가한 환경에서 빌드가 실행되면, THE MusicStudio SHALL 빌드를 성공 상태로 완료하고, 31.1의 4개 범주 구성요소가 적용된 화면을 산출물에 포함한다
16. THE MusicStudio SHALL React 19 이상, Tailwind CSS 4 이상, Motion 12 이상의 의존성 버전 하한을 프로젝트 의존성 정의에 명시한다
17. THE MusicStudio SHALL Amicro 라이브러리의 라이선스 고지를 제품 오픈소스 고지 화면에 포함한다
18. THE MusicStudio SHALL 모션이 적용된 각 구성요소의 애니메이션을 상태 전달 목적과 장식 목적 중 정확히 하나로 분류한 Motion_Classification_Table을 보유하고, 모션이 적용된 구성요소 중 분류가 없는 구성요소 수를 0개로 유지한다(불변식)
19. THE MusicStudio SHALL 모든 모션 전환의 정착 시간, 즉 전환 대상 값이 목표 값의 1% 이내에 도달하여 유지되기까지의 시간을 600밀리초 이하로 유지한다(불변식)
20. WHEN `prefers-reduced-motion` 설정이 변경되면, THE MusicStudio SHALL 화면 재적재 없이 1초 이내에 변경된 설정을 재생 중인 애니메이션과 이후 애니메이션에 적용한다

### Requirement 32: 인앱 인터페이스 사운드 계층

**User Story:** 사용자로서 나는 작업 상태를 소리로도 알고 싶지만 소리를 끌 수도 있어야 한다. 그래서 소리는 화면 정보를 보강하는 수준에서만 동작해야 한다.

#### Acceptance Criteria

1. THE UI_Sound_Layer SHALL 제품 이벤트를 78개 Semantic_Cue 중 하나로 대응시키는 매핑 표를 보유하며, 각 항목은 큐 이름 1개, 대응 화면 표시 요소 식별자 1개 이상, 해당 상태를 서술하는 텍스트 문구 1개를 포함한다
2. THE UI_Sound_Layer SHALL `AudioContext`를 최초 재생 요청 시점에 생성한다
3. WHEN 사용자의 최초 신뢰된 포인터 또는 키보드 조작이 발생하면, THE UI_Sound_Layer SHALL 잠금 해제 함수를 호출하여 오디오 재생을 활성화한다
4. WHILE 잠금 해제가 완료되지 않은 동안, THE UI_Sound_Layer SHALL 각 큐 재생 요청에 대해 오디오 출력 없이, 재생되지 않았음을 나타내는 재생 여부 값과 억제 사유(잠금 미해제)를 포함한 정상 결과를 20밀리초 이내에 반환하고 해당 요청을 그 시점에 종료 처리하며, 재생 대상은 잠금 해제 이후 새로 도착한 요청으로 한정한다
5. THE UI_Sound_Layer SHALL 동시 재생 음성 수를 0 이상 8 이하로 유지한다(불변식)
6. WHILE 어떤 루프 큐의 재생 인스턴스가 진행 중인 동안, WHEN 같은 큐 이름에 대한 재생이 다시 요청되면, THE UI_Sound_Layer SHALL 동시 재생 음성 수를 그대로 유지하고 진행 중 인스턴스와 동일한 핸들 식별자를 반환하며 해당 인스턴스의 재생 위치를 계속 진행시킨다(멱등 속성)
7. WHEN 루프 큐가 표현하는 상태가 성공, 실패, 취소 중 하나로 종료되면, THE UI_Sound_Layer SHALL 해당 루프 재생을 200밀리초 이내에 중지한다
8. WHILE 동일 큐 이름의 직전 재생 시작 시점으로부터 50밀리초가 경과하지 않은 동안, THE UI_Sound_Layer SHALL 같은 큐의 신규 재생 요청에 대해 오디오 출력 없이, 재생되지 않았음을 나타내는 재생 여부 값과 억제 사유(최소 간격 미충족)를 포함한 정상 결과를 반환하고 해당 요청을 그 시점에 종료 처리한다
9. WHEN 사용자가 사운드 팩을 변경하면, THE UI_Sound_Layer SHALL 진행 중인 각 루프 재생의 핸들 식별자를 변경 전과 동일한 값으로 유지한 상태에서 해당 루프의 오디오 출처를 새 팩의 같은 큐 이름 자산으로 500밀리초 이내에 전환하고, 전환 구간의 무음 길이를 50밀리초 이하로 유지한다
10. THE UI_Sound_Layer SHALL 사용자가 선택할 수 있는 사운드 팩을 2개 이상 제공한다
11. IF 음량 설정 변경 요청의 값이 0.0 이상 1.0 이하 범위를 벗어나면, THEN THE UI_Sound_Layer SHALL 해당 요청을 거부하고 직전에 적용된 음량 값을 유지하며 허용 범위를 알리는 오류 표시를 제공한다
12. WHEN 사용자가 사운드 활성화 여부, 음량, 선택 팩 중 하나를 변경하면, THE UI_Sound_Layer SHALL 변경된 설정을 지속 저장소에 저장한다
13. WHEN 사용자가 새 세션으로 접속하면, THE UI_Sound_Layer SHALL 지속 저장소에 값이 있는 항목을 저장된 값으로 복원하고 값이 없는 항목에 기본값(사운드 활성화 여부 참, 음량 0.5, 기본 제공 팩)을 적용한다
14. WHILE 사운드 활성화 여부가 비활성인 동안, THE UI_Sound_Layer SHALL 동시 재생 음성 수를 0으로 유지하고, 각 큐 재생 요청에 대해 오디오 출력 없이 재생되지 않았음을 나타내는 재생 여부 값과 억제 사유(사운드 비활성)를 포함한 정상 결과를 20밀리초 이내에 반환한다
15. WHEN 사운드 큐 재생이 요청되면, THE MusicStudio SHALL 매핑 표가 해당 큐에 지정한 화면 표시 요소와 상태 서술 텍스트를 요청 시점 기준 200밀리초 이내에 표시하고, 대응 상태가 종료될 때까지 또는 최소 3초 동안 유지한다
16. THE MusicStudio SHALL 성공, 경고, 오류 상태를 서로 다른 아이콘 형상 1개와 서로 다른 상태 서술 텍스트 라벨 1개를 포함한 2개 이상의 비색상 채널로 표시한다
17. THE UI_Sound_Layer SHALL 오디오 자산을 제외한 사운드 재생 런타임 코드의 압축 후 전송 크기를 20킬로바이트 이하로 유지한다(불변식)
18. THE UI_Sound_Layer SHALL 사운드 자산 사전 적재 중 단일 브라우저 작업 점유 시간을 50밀리초 이하로 유지한다
19. WHEN 문서 가시성이 숨김 상태로 전환되거나 세션이 종료되면, THE UI_Sound_Layer SHALL 진행 중인 모든 루프 재생을 200밀리초 이내에 중지하여 동시 재생 음성 수를 0으로 만든다
20. THE MusicStudio SHALL 인터페이스 사운드 자산의 라이선스 고지를 제품 오픈소스 고지 화면에 포함한다
21. IF 동시 재생 음성 수가 8인 상태에서 신규 큐 재생이 요청되면, THEN THE UI_Sound_Layer SHALL 재생 시작 시점이 가장 이른 원샷 인스턴스 1개를 중지한 후 요청된 큐를 재생하고, 루프 인스턴스는 중지 대상에서 제외한다
22. WHEN 진행 중 인스턴스가 없는 루프 큐의 재생이 요청되면, THE UI_Sound_Layer SHALL 해당 큐의 재생 인스턴스 1개를 생성하고 그 인스턴스의 핸들 식별자를 반환한다
23. IF 사운드 팩 변경 요청에서 새 팩에 진행 중 루프 큐와 같은 이름의 자산이 없거나 해당 자산 적재가 3초 이내에 완료되지 않으면, THEN THE UI_Sound_Layer SHALL 직전 팩의 오디오로 해당 루프 재생을 계속 유지하고 선택 팩 설정을 직전 값으로 되돌리며 전환 실패를 알리는 오류 표시를 제공한다

### Requirement 33: 라이선스, 저작자 표시 및 상업적 사용 준수

**User Story:** 서비스 운영자로서 나는 각 엔진의 라이선스 조건을 제품이 강제하도록 하고 싶다. 그래서 사용자가 비상업 라이선스 모델의 결과물을 상업적으로 쓰는 일이 구조적으로 막힌다.

#### Acceptance Criteria

1. THE Provider_Registry SHALL 등록된 각 엔진과 제품에 포함된 각 제3자 라이브러리·사운드 자산 출처에 대해 코드 라이선스 식별자, 가중치 라이선스 식별자, 상업적 사용 허용 여부, 요구 저작자 표시 문구, 라이선스 원문 링크의 5개 항목이 모두 채워진 License_Descriptor를 보유하며, 요구 저작자 표시 문구를 1자 이상 500자 이하로, 라이선스 원문 링크를 1개 이상 5개 이하로 기록하고, 저작자 표시를 요구하지 않는 출처에는 표시 요구 없음을 뜻하는 고정 값을 기록한다
2. IF 엔진 등록 또는 갱신 요청의 코드 라이선스 식별자 또는 가중치 라이선스 식별자 중 1개 이상이 비상업 라이선스 식별자 목록에 속하면, THEN THE Provider_Registry SHALL 해당 항목의 상업적 사용 허용 여부를 거짓으로 기록하고 요청에 포함된 상업적 사용 허용 여부 값 대신 거짓이 적용된 사실과 판정 근거가 된 라이선스 식별자를 응답에 포함한다
3. THE Provider_Registry SHALL 비상업 라이선스 식별자 목록을 1개 이상 200개 이하의 항목과 목록 버전 식별자를 갖는 형태로 보유하고, 목록의 항목이 추가 또는 삭제될 때마다 목록 버전 식별자를 1 증가시킨다
4. WHERE 하나의 엔진이 제3자 구성 부품을 포함하는 경우, THE Provider_Registry SHALL 각 구성 부품에 대해 개별 License_Descriptor 항목을 1개 이상 200개 이하 범위로 기록하고, 해당 엔진의 상업적 사용 허용 여부를 모든 구성 부품의 상업적 사용 허용 여부가 참인 경우에만 참으로 기록한다
5. THE Provider_Registry SHALL 원격 엔진으로 등록된 각 모델에 대해 해당 모델 제공자가 명시한 라이선스 식별자와 이용 약관 링크를 기록한다
6. IF 엔진 등록 또는 갱신 요청의 License_Descriptor 5개 항목 중 1개 이상이 비어 있으면, THEN THE Provider_Registry SHALL 등록을 거부하고 비어 있는 모든 항목 이름을 반환하며 기존에 저장된 License_Descriptor를 변경 없이 유지한다
7. WHEN Audio_Asset이 저장되면, THE MusicStudio SHALL 사용된 엔진 식별자, 가중치 라이선스 식별자, 요구 저작자 표시 문구, 상업적 사용 허용 여부, 판정에 사용된 비상업 라이선스 식별자 목록의 버전 식별자, 출처 정보 기록 시각(밀리초 정밀도)을 해당 자산의 출처 정보로 저장하고, 저장된 출처 정보를 이후 수정 없이 보존한다
8. THE MusicStudio SHALL Audio_Asset 상세 화면에 해당 자산의 엔진 식별자, 라이선스 식별자, 요구 저작자 표시 문구, 상업적 사용 허용 여부를 표시한다
9. WHEN 사용자가 Audio_Asset 다운로드를 요청하면, THE Library_Service SHALL 해당 자산과 계보 깊이 32 이하의 모든 조상 자산에 대한 엔진 식별자, 라이선스 식별자, 요구 저작자 표시 문구, 상업적 사용 허용 여부를 자산 1건당 1개 항목으로 담은 텍스트 파일을 오디오 파일과 함께 포함한다
10. WHEN 사용자가 상업적 사용 허용 여부가 거짓인 엔진을 생성 요청에 선택하면, THE MusicStudio SHALL 비상업적 사용 제한 고지 1건을 표시하고 사용자의 명시적 확인 조작이 완료된 이후에만 해당 생성 요청을 접수한다
11. IF 사용 목적 값이 `commercial`인 다운로드 또는 내보내기 요청의 대상 Audio_Asset의 출처 정보에 기록된 상업적 사용 허용 여부가 거짓이면, THEN THE MusicStudio SHALL 해당 요청을 거부하고 제한 사유와 동일 Asset_Kind를 지원하며 상업적 사용 허용 여부가 참인 엔진 식별자 목록을 10개 이하로 반환하며 대상 자산과 그 출처 정보를 변경 없이 유지한다
12. IF Timeline_Project의 Timeline_Clip이 참조하는 Audio_Asset 또는 그 계보 깊이 32 이하의 조상 자산 중 1개 이상의 상업적 사용 허용 여부가 거짓이면, THEN THE Mixdown_Renderer SHALL 산출된 `mix` Audio_Asset의 상업적 사용 허용 여부를 거짓으로 기록한다
13. THE Mixdown_Renderer SHALL 산출된 `mix` Audio_Asset의 출처 정보에 참여한 모든 Audio_Asset과 계보 깊이 32 이하의 모든 조상 자산의 엔진 식별자, 라이선스 식별자, 요구 저작자 표시 문구를 자산 1건당 1개 항목으로 포함한다
14. THE MusicStudio SHALL 모든 Audio_Asset의 출처 정보에 Requirement 16에 정의된 AI 생성 워터마크 정보와 AI 생성 표기를 함께 유지한다(불변식)
15. WHEN 사용자가 자산 출처 정보 내보내기를 요청하면, THE MusicStudio SHALL 자산 식별자, 엔진 식별자, 라이선스 식별자, 저작자 표시 문구, 상업적 사용 허용 여부, 생성 시각을 담은 기계 판독 가능 문서를 반환한다
16. WHEN 엔진의 License_Descriptor가 변경되면, THE MusicStudio SHALL 변경 이전 값, 변경 이후 값, 변경 주체 식별자, 변경 시각을 변경 확정 후 5초 이내에 Audit_Log에 기록한다
17. WHEN 엔진의 상업적 사용 허용 여부가 참에서 거짓으로 변경되면, THE MusicStudio SHALL 해당 엔진으로 생성된 기존 Audio_Asset의 출처 정보를 생성 시점의 값으로 유지하고, 해당 자산에 대한 사용 목적 `commercial` 요청을 생성 시점의 상업적 사용 허용 여부를 기준으로 판정하며, 변경 시각 이후 24시간 이내에 각 자산 소유자에게 변경 사실과 영향 자산 개수를 통지하고, 해당 자산의 상세 화면에 변경 이후 값과 변경 시각을 함께 표시한다
18. THE MusicStudio SHALL 제품 오픈소스 고지 화면에 사용된 모든 엔진과 라이브러리의 라이선스 식별자와 원문 링크를 표시한다
19. THE Library_Service SHALL 모든 Audio_Asset 다운로드 및 내보내기 요청에 대해 사용 목적 값을 `commercial`과 `non_commercial` 중 정확히 하나로 기록하고, 사용 목적 값이 전달되지 않은 요청에는 `non_commercial`을 적용한다
20. WHEN 기존 Audio_Asset 1개 이상을 입력으로 하는 Edit_Task, 스템 추출, 이펙트 적용, 음성 변환, 믹스다운 중 하나의 결과로 새 Audio_Asset이 저장되면, THE MusicStudio SHALL 새 자산의 상업적 사용 허용 여부를 모든 직접 입력 자산의 상업적 사용 허용 여부와 처리에 사용된 모든 엔진의 상업적 사용 허용 여부가 참인 경우에만 참으로 기록한다
21. THE MusicStudio SHALL 상업적 사용 허용 여부가 거짓인 조상 자산이 계보 깊이 32 이하에 1개 이상 존재하는 모든 Audio_Asset의 상업적 사용 허용 여부를 거짓으로 유지한다(불변식)

## Appendix: 제품 결정으로 확정한 수치 가정

아래 값은 참조 구현이나 ACE_Engine 상수에서 직접 도출되지 않은 **제품 결정**이며, 확인이 필요하다.

| 항목 | 확정값 | 관련 요구사항 |
| --- | --- | --- |
| 배경음악 목표 길이 범위 | 5초 ~ 600초 | 21.2, 21.3 |
| 루프 이음 연속성 판정 기준 | 이음점 전후 10ms 구간 RMS 차이 ≤ 1.0dB, 첫/끝 샘플 진폭 차이 ≤ 최대 진폭의 5% | 21.7, 21.8, 22.14, 24.6 |
| 강도 변형 개수 상한 | 4 | 21.9, 21.11 |
| 강도 단계 간 라우드니스 차이 | 1.0 ~ 6.0LUFS | 21.11 |
| 루프 양 끝 구간 에너지 하한 | 첫/마지막 100ms 구간 RMS ≥ 전체 RMS -6dB | 21.16 |
| 루프 마디 정합 기준 | 1마디 길이의 1 ~ 64배 정수배, 오차 ±25ms | 21.17 |
| 루프 기준 미충족 시 재생성 횟수 | 최대 2회 재생성(총 3회 시도) | 21.18 |
| 기준 자산 BPM 정합 허용 오차 | ±1BPM | 21.13 |
| 원샷 효과음 길이 범위 | 0.1초 ~ 10.0초 | 22.4, 22.18 |
| 효과음 기본값 | 목표 길이 2.0초, 변형 개수 4, 고속 등급 | 22.17 |
| 모델 등급별 샘플링 단계 수 기본값 | 고속 8, 고품질 30 | 22.10, 22.11 |
| 정렬 점수 동점 판정 임계 | 0.001 (동점 시 시드 오름차순) | 22.6 |
| 꼬리 감쇠 적용 대상 | 루프가 아닌 효과음에만 적용 | 22.15 |
| 안내 척도 허용 범위 | 1.0 ~ 15.0 (기본 7.5는 참조 구현 기본값) | 22.12 |
| 영상 업로드 제약 | mp4/mov/webm, 0.5초 ~ 60초, 200MB 이하, 8 ~ 120fps, 짧은 변 128픽셀 이상 | 23.2, 23.3 |
| V2A 온셋 정렬 허용 오차 | ±80ms (영상 24fps 기준 약 2프레임) | 23.8 |
| V2A 온셋 정렬 충족률 | 신뢰도 0.50 이상 이벤트의 90% 이상 | 23.8 |
| V2A 온셋 검출 기준 | 5ms 프레임 단기 RMS가 직전 50ms 평균보다 6.0dB 이상 큰 최초 프레임 | 23.8 |
| 시각 이벤트 신뢰도 임계 | 0.50 | 23.8, 23.16 |
| V2A 요청당 산출 자산 개수 | 1 ~ 4 | 23.1 |
| V2A 길이 오차 | ±40ms | 23.9 |
| 미리보기 영상 오디오·영상 싱크 허용 오차 | ±20ms | 23.12 |
| 폴리 생성 작업 시간 상한 | 900초 | 23.17 |
| 업로드 영상 보관 기간 / 미리보기 보관 기간 | 168시간(7일) | 23.12, 23.13 |
| 사운드 팩 이름 / 음향 성격 설명 길이 범위 | 1자 ~ 60자 / 1자 ~ 200자 | 24.1, 24.20 |
| 사운드 팩 원샷 큐 길이 범위 | 0.05초 ~ 1.5초 (상한은 UI SFX 택소노미 근거, 하한은 제품 결정) | 24.4 |
| 사운드 팩 루프 큐 길이 범위 | 0.5초 ~ 4.0초 | 24.5 |
| 사운드 팩 라우드니스 측정 방식 및 허용 범위 | 400ms 창·100ms 간격 창별 라우드니스의 최대값(400ms 미만 큐는 전체 1창), -25 ~ -21LUFS | 24.7 |
| 사운드 팩 큐 쌍 유사도 측정 방식 | 48000Hz 모노·-23LUFS 정규화 후 25ms 창·10ms 간격·멜 40밴드에서 1~13차 켑스트럼 계수 시간 평균 벡터의 코사인 유사도, 큐 쌍 3003개 전수 | 24.9 |
| 사운드 팩 큐 간 유사도 상한 | 0.95 | 24.9, 24.22 |
| 사운드 팩 내보내기 응답 시간 상한 | 60초 | 24.10 |
| 개별 큐 생성 실패 시 재시도 횟수 | 최대 2회 재시도(총 3회 시도) | 24.21 |
| 유사도 상한 초과 시 큐 재생성 횟수 | 최대 3회 | 24.22 |
| 발화 속도 / 음높이 범위 | 0.5x ~ 2.0x / -12 ~ +12반음 | 25.5, 25.6 |
| 스크립트 전체 길이 상한 | 20000자 | 25.4 |
| 조각 연결 교차 페이드 | 50ms | 23.7, 25.11, 25.15 |
| 스크립트 분할 허용 위치 | 행 경계 또는 문장 종결 부호(`.`, `?`, `!`, `。`) 직후 | 25.11 |
| 대사 행 개수 상한 / 행당 문자 수 범위 | 1000개 / 1자 ~ 1000자 | 25.14 |
| 행 재생성 시 길이 변화 판정 임계 | 1ms | 25.16 |
| 대사 끝 무음 구간 범위 및 판정 기준 | 50ms ~ 200ms, -60dBFS 이하 연속 구간 | 25.19 |
| 참조 음성 샘플 요건 | 6초 ~ 120초, 16000Hz 이상, 발화 구간 비율 60% 이상 | 26.2, 26.3, 26.5 |
| Voice_Profile 이름 길이 범위 | 1자 ~ 64자 | 26.1 |
| Voice_Profile 참조 샘플 개수 상한 | 10 | 26.7 |
| Voice_Consent_Record 보관 기간 | 대상 Voice_Profile 삭제 시각으로부터 5년 | 26.14 |
| Voice_Profile 공유 대상 인원 범위 | 1명 ~ 50명 | 26.19 |
| Voice_Profile 삭제 처리 시한 | 접수 후 24시간 | 26.21 |
| 동의 철회 처리 시한 / 공개 자산 비공개 전환 시한 | 접수 후 24시간 / 상태 전환 후 24시간 | 26.28, 26.30 |
| 음성 변환 길이 허용 오차 | ±100ms | 26.25 |
| 전사 대상 오디오 제약 | 0.5초 ~ 3600초, 500MB 이하, 8000 ~ 48000Hz | 27.5, 27.15 |
| 전사 결과 행 개수 범위 | 1개 ~ 2000개 | 27.1 |
| 전사 응답 시간 상한 산식 | 오디오 길이(초) × 등급별 1초당 최대 처리 시간(초) + 60초 | 27.1, 27.16 |
| 전사 모델 등급 개수 / 1초당 최대 처리 시간 범위 | 2개 ~ 5개 / 0.01초 ~ 5.00초 | 27.2 |
| 언어 자동 판별 미확정 임계 | 신뢰도 0.50 | 27.4 |
| 발화 미검출 판정 기준 | 검출된 발화 구간 총 길이 200ms 미만 | 27.12 |
| 전사 행 텍스트 수정 길이 범위 | 1자 ~ 500자 | 27.11 |
| 타임라인 트랙 수 상한 | 32 (`track` 0~31) | 28.4 |
| 프로젝트당 클립 개수 상한 | 500 | 28.5 |
| 클립 게인 / 트랙 음량 / 팬 범위 | -40 ~ +12dB / -60 ~ +12dB / -1.0 ~ +1.0 | 28.16, 28.18 |
| 스냅 허용 오차 / 동거리 후보 판정 | 50ms / 시각이 더 작은 후보 선택 | 28.21 |
| 프로젝트 템포 / 박자 값 범위 | 30 ~ 300 정수 BPM / 2, 3, 4, 6 | 28.39 |
| 되돌리기 이력 보관 횟수 | 100 | 28.22 |
| 믹스다운 길이 허용 오차 | 10ms | 28.25 |
| 가환 속성 샘플 값 차이 허용 | 0.0001 | 28.26 |
| 재현성 검증 반복 횟수 | 3회 | 28.27 |
| 피크 정규화 후 목표 진폭 / 감쇠량 범위 | 0.99 ~ 1.0 / 0dB 초과 ~ 40dB 이하 | 28.28 |
| 프로젝트 동등 관계 허용 오차 | 게인·트랙 음량 0.1dB, 팬 0.01, 시각·식별자 정확 일치 | 28.32 |
| 재생 위치 트랙 간 동기 허용 오차 | 20ms | 28.35 |
| Effect_Chain 항목 개수 상한 | 16 | 29.13 |
| Audio_Asset당 버전 개수 상한 | 16 | 29.19 |
| Generation_Version 이름 / Effect_Preset 이름 길이 범위 | 1자 ~ 60자 | 29.20, 29.22 |
| 사용자당 Effect_Preset 개수 상한 | 100 | 29.35 |
| 기본 버전 승격 규칙 | 생성 시각이 가장 늦은 버전, 동시각이면 버전 식별자 오름차순 첫 번째 | 29.17 |
| 체인 동등 관계 수치 파라미터 허용 오차 | 0.000001 | 29.26, 29.27 |
| 이펙트 처리 길이 허용 오차(딜레이·리버브 미포함) | 10ms | 29.30 |
| 이펙트 처리 테일 상한(딜레이 또는 리버브 포함) | 원본 길이 + 10000ms | 29.32 |
| 라우드니스 목표 범위 / 입력 단위 / 기본값 | -30.0 ~ -6.0LUFS / 0.1LUFS / 기본 -14.0LUFS | 30.5 |
| 트루 피크 상한 | -1.0dBTP | 30.7 |
| 라우드니스 정규화 허용 오차 | ±0.5LUFS | 30.6 |
| 라우드니스 측정 규약 | ITU-R BS.1770-4 K-가중, 400ms 블록, 절대 게이트 -70.0LUFS, 상대 게이트 -10.0LU, 트루 피크 4배 이상 오버샘플링, 보고값 0.1 단위 반올림 | 30.24 |
| 라우드니스 정규화 멱등 허용 편차 | 게인 변화 ≤ 0.1dB, 라우드니스 ±0.1LUFS, 트루 피크 ±0.1dB | 30.8 |
| 대사 정리 판정 기준 | 비발화 구간 평균 RMS 10.0dB 이상 감쇠, 발화 구간 라우드니스 ±1.0LUFS 유지 | 30.9 |
| 발화 구간 판정 기준 | 100ms 창 RMS ≥ -45.0dB인 200ms 이상 연속 구간 | 30.12 |
| 자동 감쇠 기본값 | 깊이 -12dB, 어택 50ms, 릴리즈 300ms | 30.13, 30.14, 30.15 |
| 자동 감쇠 깊이 허용 오차 / 비발화 구간 음량 유지 오차 | ±1.0dB / ±0.5dB | 30.12, 30.16 |
| 파라미터 제안 서비스 응답 제한 | 120초 | 30.20 |
| 기본 제안 반환 시간 상한 | 5초 | 30.21 |
| 제안 근거 주파수 대역 구성 | 31.5 / 63 / 125 / 250 / 500 / 1000 / 2000 / 4000 / 8000 / 16000Hz 중심 옥타브 대역 10개 | 30.22 |
| 프런트엔드 의존성 하한 | React 19, Tailwind CSS 4, Motion 12 | 31.16 |
| 감소된 모션 상태의 애니메이션 지속 시간 상한 | 200ms | 31.10 |
| 조작 응답 시간 상한 | 100ms | 31.12 |
| 진행 상태 표시 노출 시한 / 텍스트 갱신 간격 상한 | 300ms / 2초 | 31.6, 31.7 |
| 포커스 표시 노출 시한 / 포커스 영역 경계 차이 상한 | 100ms / 2 CSS 픽셀 | 31.14 |
| 모션 정착 시간 상한 (목표 값의 1% 이내 도달·유지) | 600ms | 31.19 |
| `prefers-reduced-motion` 변경 반영 시한 | 1초 | 31.20 |
| UI 사운드 런타임 크기 상한 | 압축 기준 20kB (참조 구현 12.0kB) | 32.17 |
| 큐 재생 최소 간격 | 50ms | 32.8 |
| 억제 결과 반환 시간 상한 | 20ms | 32.4, 32.14 |
| 사운드 설정 기본값 | 활성화 참, 음량 0.5, 기본 제공 팩 | 32.13 |
| 루프 재생 중지 시한 | 200ms | 32.7, 32.19 |
| 사운드 팩 전환 시한 / 전환 구간 무음 상한 / 자산 적재 시한 | 500ms / 50ms / 3초 | 32.9, 32.23 |
| 음성 수 상한 도달 시 회수 정책 | 재생 시작이 가장 이른 원샷 1개 중지, 루프는 제외 | 32.21 |
| 사운드 큐 시각 표시 노출 시한 / 최소 유지 시간 | 200ms / 3초 | 32.15 |
| 요구 저작자 표시 문구 길이 범위 / 라이선스 원문 링크 개수 범위 | 1자 ~ 500자 / 1개 ~ 5개 | 33.1 |
| 비상업 라이선스 식별자 목록 항목 개수 범위 | 1개 ~ 200개 | 33.3 |
| 엔진당 구성 부품 License_Descriptor 개수 범위 | 1개 ~ 200개 | 33.4 |
| 출처 정보 기록 시각 정밀도 | 밀리초 | 33.7 |
| 출처 문서 계보 깊이 상한 | 32 | 33.9, 33.12, 33.13, 33.21 |
| 대체 엔진 목록 반환 개수 상한 | 10개 | 33.11 |
| License_Descriptor 변경 Audit_Log 기록 시한 | 5초 | 33.16 |
| 상업적 사용 허용 여부 변경 통지 시한 | 24시간 | 33.17 |
| 사용 목적 기본값 | `non_commercial` | 33.19 |
| 원격 엔진 응답 제한 | 300초 | 20.14 |
| 시간 초과 실패 시 환급 완료 시한 | 60초 | 20.15 |
| 엔진 상태 점검 주기 / 대기 시간 / 이력 보관 | 60초 ±5초 / 10초 / 최근 100건 이상, 24시간 이상 | 20.7 |
| 엔진 사용 불가 판정 / 사용 가능 복귀 판정 | 연속 3회 실패 / 연속 2회 성공 | 20.8, 20.21 |
| 대체 엔진 재라우팅 횟수 | 1회 | 20.10 |
| Engine_Descriptor 값 범위 | 엔진 식별자 1~64자, 지원 Asset_Kind 1~6개, 입력 양식 1~3개, 최대 출력 길이 1000~3600000ms, 샘플레이트 16000~48000Hz | 20.1, 20.23 |
| 엔진 일일 쿼터 값 범위 / 초기화 시각 | 1 ~ 1000000 / 매일 00:00 UTC | 20.12 |
| 엔진 목록 조회 응답 시간 상한 | 5초 | 20.19 |
| 엔진 쿼터 경보 임계 | 일일 배정량의 10% | 18.12 |
| 자산당 태그 개수 상한 / 태그 길이 범위 | 20개 / 1자 ~ 30자 | 19.8, 19.14 |
| Audio_Asset 길이 상한 | 3600000ms | 19.11, 19.15 |
| 자산 이름 길이 범위 | 1자 ~ 200자 | 19.3 |
| 리샘플링 후 길이 허용 오차 | ±10ms | 19.5 |
| 계보 입력 자산 개수 상한 / 계보 경로 깊이 | 64개 / 1 ~ 32 | 19.6, 19.7, 19.13 |
| 라이브러리 업로드 오디오 제약 | mp3/wav/flac, 50MB 이하, 1ms ~ 3600000ms | 19.12, 19.15 |

### 엔진·라이브러리별 라이선스 식별자 (Provider_Registry 등록 초기값)

아래 값은 Requirement 33.1과 33.4가 요구하는 License_Descriptor의 **등록 초기값**이다. 요구사항 본문은 기록·판정·표시 의무만 규정하며, 개별 식별자 값은 이 표로 관리한다.

| 대상 | 코드 라이선스 식별자 | 가중치 라이선스 식별자 | 상업적 사용 |
| --- | --- | --- | --- |
| Woosh 계열 엔진 | `MIT` | `CC-BY-NC-4.0` | 불가 |
| Woosh 영상 기반 모델 | `Apache-2.0` | `CC-BY-NC-4.0` | 불가 |
| DeepAFx 기반 파라미터 제안 모델 | Adobe Research License (비상업 연구 목적 한정) | Adobe Research License (비상업 연구 목적 한정) | 불가 |
| DeepAFx LV2 플러그인 | 플러그인별 개별 기록 | 해당 없음 | 플러그인별 개별 판정 |
| UI SFX 인터페이스 사운드 | 런타임 코드 `MIT` | 기본 사운드 자산 `CC0-1.0` | 가능 |
| Amicro 구성요소 라이브러리 | `MIT` | 해당 없음 | 가능 |
| ACE-Step 생성 엔진 | 제공자 명시 값 | 제공자 명시 값 | 제공자 명시 값에 따름 |
| 원격 엔진으로 등록된 각 모델 | 제공자 명시 값 | 제공자 명시 값 | 제공자 명시 값에 따름 |
| 비상업 라이선스 식별자 목록 초기 항목 | `CC-BY-NC-4.0`, Adobe Research License | — | — |

### 참조 구현에서 도출한 값(확인 불필요)

- 48000Hz 샘플레이트 — Woosh-AE `config.yaml`의 `sample_rate: 48000`, ACE-Step 파이프라인의 `sample_rate = 48000`
- 효과음 프롬프트 77토큰 — Woosh-DFlow `config.yaml`의 `max_description_length: 77`
- 샘플링 단계 수 100, 안내 척도 기본 7.5, 시드 상한 2147483647 — Woosh `api/compute_agent.py`의 `GenerateArgs`와 Gradio 데모의 시드 생성식
- V2A 8초 처리 구간, 영상 24fps — Woosh `Woosh-VFlow-8s` / `Woosh-DVFlow-8s` 체크포인트와 `video_fps: 24`
- 78개 큐 / 13개 범주 / 72개 원샷 / 6개 루프 / 원샷 1.5초 이하 / 8보이스 / mp3+ogg 배포 / 매니페스트 필드 — UI SFX `README.md`와 `docs/taxonomy.md`
- 이펙트 8종과 모든 파라미터 허용 범위, 내장 프리셋 4종, 원본 버전 보존, 기본 버전 단일성 — Voicebox `effects-pipeline.mdx`
- 분할 기준 문자 수 기본 800자 / 범위 100~5000자 — Voicebox `tts-generation.mdx`
- `start_time_ms`, `track`, `trim_start_ms`, `trim_end_ms`, 동일 트랙 비중첩, 트림 검증식, 200ms 간격, 믹스다운 길이 정의, 피크 초과 시 정규화 — Voicebox `stories.mdx`
- 스프링 프리셋 5종과 그 수치, 파형/이퀄라이저 로더 이름, `use-reduced-motion` 훅, `@amicro` 이름공간 — Amicro `registry/lib/presets.ts`, `registry/registry.json`, `registry/hooks/use-reduced-motion.ts`, `README.md`
- 라이선스 식별자 — Woosh `README.md`(코드 MIT / V2A 코드 Apache-2.0 / 가중치 CC-BY-NC-4.0), UI SFX `LICENSE`·`LICENSE-AUDIO`(MIT / CC0-1.0), Amicro `LICENSE`(MIT), DeepAFx `LICENSE`(Adobe Research License, 비상업 연구 목적 한정)
