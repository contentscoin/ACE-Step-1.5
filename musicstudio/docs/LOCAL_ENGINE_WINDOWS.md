# Windows PC에 ACE-Step 엔진 설치 — GTX 1070 (8 GB) 기준

MusicStudio가 실제 곡을 만들려면 ACE-Step 엔진이 GPU가 있는 PC에서 돌아야 합니다. 이 문서는
**Windows 10/11 + NVIDIA GTX 1070 (8 GB) + RAM 64 GB**, 설치 위치 **`D:\`** 기준입니다. 다른
카드여도 절차는 같고, 1070 전용인 부분은 따로 표시했습니다.

목표는 두 단계입니다.

1. 엔진만 띄워서 **곡 하나가 실제로 나오는지** 확인한다 (`npm run engine:smoke`).
2. 그다음에 MusicStudio 나머지(게이트웨이·DB·Redis·DSP)를 붙인다 — 별도 문서에서 다룹니다.

---

## 0. 준비물

| 항목 | 받는 곳 | 비고 |
| --- | --- | --- |
| NVIDIA 드라이버 최신 | GeForce Experience 또는 nvidia.com | `nvidia-smi`가 실행되면 됨 |
| Git for Windows | git-scm.com | 기본 옵션으로 설치 |
| Node.js 22 LTS | nodejs.org | `engine:smoke` 실행용. 엔진 자체에는 불필요 |
| 디스크 여유 | D: 약 **30 GB** | 아래 표 참고 |

파이썬과 uv는 따로 설치하지 않아도 됩니다. 엔진 실행 스크립트가 처음 실행될 때 uv 설치를
물어보고(`Y`), uv가 파이썬과 패키지를 받아옵니다.

### 디스크 사용량 (대략)

| 무엇 | 위치 | 크기 |
| --- | --- | --- |
| 파이썬 환경 (`.venv`, PyTorch 포함) | `D:\ACE-Step-1.5\.venv` | 8–10 GB |
| 모델 가중치 (첫 실행 시 자동 다운로드) | `D:\ACE-Step-1.5\checkpoints` | 11–12 GB |
| uv 다운로드 캐시 | 기본은 **C:** (`%LOCALAPPDATA%\uv\cache`) | 5 GB 안팎 |

C:가 224 GB SSD라 여유가 적다면, 설치 전에 **PowerShell**에서 uv 캐시를 D:로 옮겨 두세요
(새로 연 터미널부터 적용됩니다).

```powershell
setx UV_CACHE_DIR D:\uv-cache
```

> D:가 HDD여도 괜찮습니다. 엔진을 켤 때 모델을 읽는 데 1–2분 더 걸릴 뿐, 생성 속도는 GPU가
> 정합니다.

---

## 1. 코드 받기

PowerShell을 **새로** 열고:

```powershell
cd D:\
git clone https://github.com/contentscoin/ACE-Step-1.5.git
cd D:\ACE-Step-1.5
```

> 반드시 이 저장소(`contentscoin`)를 받으세요. 실행 스크립트의 업데이트 확인은 `origin`을
> 기준으로 하므로, 이 저장소를 받으면 업데이트도 여기서 옵니다.

---

## 2. 엔진 첫 실행

탐색기에서 `D:\ACE-Step-1.5\start_api_server.bat`을 더블클릭합니다. **설정을 고칠 필요는
없습니다** — 1070에 필요한 것은 아래처럼 자동으로 맞춰집니다.

처음에는 오래 걸립니다(인터넷 속도에 따라 20–60분).

1. `[Update] Checking for updates...` — 새 버전이 있으면 업데이트할지 묻습니다. `Y`면 됩니다.
2. `Install uv? (Y/N)` — `Y`.
3. `Running: uv sync` — 파이썬과 패키지 설치.
4. **(1070 전용)** `[Compatibility] Legacy NVIDIA GPU detected with unsupported torch arch.`
   — 기본 PyTorch는 1070(sm_61)을 지원하지 않아서, 1070을 지원하는 버전
   (`torch 2.5.1+cu121`)으로 자동 재설치합니다. 정상입니다.
5. `Starting ACE-Step API Server...` — 모델을 내려받고(첫 실행만) 불러옵니다.

### 정상이면 보이는 줄

| 로그 | 뜻 |
| --- | --- |
| `Legacy CUDA GPU detected (pre-Volta ...): forcing 5Hz LM backend recommendation to PyTorch.` | 1070에서 돌지 않는 vLLM 대신 PyTorch로 언어 모델 실행 |
| `[initialize_service] Pre-Ampere CUDA detected: using float16 instead of bfloat16.` | 1070에는 bf16이 없어서 fp16 사용 |
| `[API Server] LLM model loaded: acestep-5Hz-lm-0.6B` | 언어 모델 로드 완료 — MusicStudio의 기본 생성(`thinking`)에 필요 |
| `Uvicorn running on http://127.0.0.1:8001` | 엔진이 요청을 받을 준비가 됨 |

이 창은 **닫지 마세요**. 닫으면 엔진이 꺼집니다.

### 엔진이 살아 있는지 확인

다른 PowerShell 창에서:

```powershell
(Invoke-RestMethod http://127.0.0.1:8001/health).data
```

`status : ok`, `models_initialized : True`, `llm_initialized : True`가 나오면 성공입니다.

`llm_initialized : False`라면 곡은 만들어지지만, 엔진이 언어 모델 기능(캡션 다듬기, 언어 추정)을
조용히 끄고 생성합니다. 엔진 창에서 `LLM model failed to load` 줄을 찾아 알려 주세요.

---

## 3. 곡 하나 만들어 보기 — `engine:smoke`

엔진 창은 켜 둔 채로, 새 PowerShell에서:

```powershell
cd D:\ACE-Step-1.5\musicstudio
npm ci
npm run engine:smoke
```

`npm ci`는 처음 한 번만 하면 됩니다. 성공하면 이렇게 끝납니다.

```text
engine http://127.0.0.1:8001 · 10 s · thinking false
  state 0 20%
  ...
  state 1
wrote data\smoke\<작업ID>-0.flac (... bytes; bpm ..., key ..., length 10 s)
done in ... s
```

`D:\ACE-Step-1.5\musicstudio\data\smoke\`의 `.flac` 파일을 재생해 보세요. **소리가 나면 엔진은
이 PC에서 MusicStudio가 쓰는 방식 그대로 동작하는 것**입니다.

그다음, MusicStudio의 기본 설정과 같은 조건(언어 모델 사용, 30초)으로 한 번 더:

```powershell
npm run engine:smoke -- --duration 30 --thinking --caption "warm lo-fi piano, vinyl crackle"
```

마지막 줄의 `done in ... s`가 이 PC에서 30초짜리 곡 하나에 걸리는 시간입니다. 알려주시면
게이트웨이 쪽 대기 시간 설정의 기준으로 쓰겠습니다.

### 실패하면

`engine:smoke`는 어느 단계에서 멈췄는지 알려 줍니다.

| 메시지 | 원인과 조치 |
| --- | --- |
| `failed at health: fetch failed` | 엔진이 꺼져 있거나 아직 로딩 중. 엔진 창에 `Uvicorn running`이 떴는지 확인 |
| `failed at submit: ... 429` | 엔진 대기열이 가득 참. 잠시 후 다시 |
| `failed at poll: CUDA out of memory` | VRAM 부족. 아래 "메모리가 부족할 때" 참고 |
| `failed at fetch: ... 403` | 엔진이 결과 파일 경로를 거부함. 엔진 창의 마지막 로그를 알려 주세요 |
| `failed at timeout` | 15분 안에 끝나지 않음. 엔진 창의 마지막 로그를 알려 주세요 |

### 메모리가 부족할 때 (1070)

8 GB는 이 엔진의 하한선에 가깝습니다. `CUDA out of memory`가 나면 순서대로 시도하세요.

1. 다른 GPU 사용 프로그램(게임, 브라우저 하드웨어 가속, 다른 AI 도구)을 끄고 다시.
2. `--duration`을 짧게(10–30초) 해서 동작부터 확인.
3. 그래도 안 되면 엔진 창의 로그 전체를 보내 주세요. 오프로드 설정을 이 PC에 맞춰 드리겠습니다.

---

## 4. 다음 단계

엔진에서 소리가 나오면 MusicStudio의 나머지(게이트웨이, PostgreSQL, Redis, DSP)를 Docker
Desktop으로 띄우고 이 엔진에 연결합니다:
[LOCAL_STACK_WINDOWS.md](LOCAL_STACK_WINDOWS.md). 엔진 실행 설정은 그 문서가 바꾸라고 할
때까지 기본값 그대로 두면 됩니다.

## 참고

- 1070 같은 구형(Pascal) 카드 지원 방식: [`docs/en/GPU_COMPATIBILITY.md`](../../docs/en/GPU_COMPATIBILITY.md)
  의 "Legacy CUDA GPU Backend Selection"
- 엔진 설치 일반: [`docs/en/INSTALL.md`](../../docs/en/INSTALL.md)
- `engine:smoke` 옵션: [`../README.md`](../README.md)의 "Checking the engine alone"
