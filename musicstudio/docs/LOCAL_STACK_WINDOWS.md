# Windows PC에서 MusicStudio 전체 실행 — 엔진에 연결해 웹에서 곡 만들기

[엔진 설치 문서](LOCAL_ENGINE_WINDOWS.md)를 마치고 `npm run engine:smoke`로 소리가 나오는 것을
확인한 다음 단계입니다. 같은 PC에서 MusicStudio의 나머지를 띄워 웹 화면에서 곡을 만들고,
라이브러리에서 재생·다운로드하는 것까지가 목표입니다.

```text
브라우저 (localhost:5173)                       ← 웹 화면, Node로 실행
   │
게이트웨이 (localhost:8080) ─ PostgreSQL ─ Redis ─ DSP   ← Docker Desktop 안
   │
ACE-Step 엔진 (127.0.0.1:8001)                   ← Windows에서 직접, GTX 1070 사용
```

엔진만 Docker 밖에 있는 이유는 GPU 때문입니다. 나머지 넷은 GPU가 필요 없어서 컨테이너로
한 번에 띄웁니다.

---

## 0. 준비물

| 항목 | 비고 |
| --- | --- |
| 엔진 설치와 `engine:smoke` 성공 | [LOCAL_ENGINE_WINDOWS.md](LOCAL_ENGINE_WINDOWS.md) |
| Docker Desktop | docker.com 에서 설치. 설치 중 **WSL 2** 사용을 선택하고, 끝나면 재부팅 |
| 디스크 | 컨테이너 이미지와 데이터 3–5 GB |

Docker Desktop은 기본적으로 C:에 데이터를 둡니다. C:가 빠듯하면 Docker Desktop의
**Settings → Resources → Advanced → Disk image location**을 `D:\Docker`로 바꾸세요.

---

## 1. 설정 파일 만들기 (처음 한 번)

PowerShell에서:

```powershell
cd D:\ACE-Step-1.5\musicstudio
$secret = node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
@"
MUSICSTUDIO_JWT_SECRET=$secret
MUSICSTUDIO_CORS_ORIGINS=http://localhost:5173
"@ | Set-Content -Encoding ascii .env
Get-Content .env
```

두 줄이 보이면 됩니다.

- `MUSICSTUDIO_JWT_SECRET` — 로그인 토큰 서명 키. 아무에게도 보여 주지 마세요. 바꾸면 기존
  로그인이 모두 풀립니다.
- `MUSICSTUDIO_CORS_ORIGINS` — 웹 화면(5173 포트)이 게이트웨이를 부를 수 있게 허용.

`.env`는 저장소에 올라가지 않습니다(`.gitignore`에 포함).

---

## 2. 컨테이너 띄우기

Docker Desktop이 켜져 있는지(작업 표시줄 고래 아이콘) 확인하고:

```powershell
cd D:\ACE-Step-1.5\musicstudio
docker compose up --build -d
```

처음에는 이미지를 받고 빌드하느라 5–15분 걸립니다. 끝나면:

```powershell
docker compose ps
```

`postgres`, `redis`, `dsp`, `gateway` 넷 다 `running`(또는 `healthy`)이면 됩니다.

### 게이트웨이가 엔진을 보는지 확인

**엔진 창(`start_api_server.bat`)이 켜져 있는 상태에서**:

```powershell
(Invoke-RestMethod http://localhost:8080/ready) | ConvertTo-Json
```

이렇게 나오면 전부 연결된 것입니다.

```json
{
  "status": "ready",
  "checks": {
    "database": "ok", "redis": "ok", "dsp": "ok",
    "engine": "available", "engineLastCheck": "success"
  }
}
```

`status`가 `degraded`이고 `engineLastCheck`가 `failure`라면 게이트웨이(컨테이너 안)가 엔진
(Windows)에 닿지 못하는 것입니다. 아래 "엔진에 닿지 않을 때"를 보세요.

---

## 3. 웹 화면 띄우기

새 PowerShell에서:

```powershell
cd D:\ACE-Step-1.5\musicstudio\web
npm ci
$env:VITE_MUSICSTUDIO_API_URL = "http://localhost:8080"
npm run dev
```

`npm ci`는 처음 한 번만 합니다. `Local: http://localhost:5173/`이 뜨면 브라우저로 엽니다.
이 창도 켜 둬야 합니다.

> `VITE_MUSICSTUDIO_API_URL`을 빼먹으면 웹이 **데모 모드**로 뜹니다(화면 위에 "데모 모드"
> 안내). 그때는 창을 닫고 위 세 줄을 다시 실행하세요.

---

## 4. 첫 곡

1. **가입** — 이메일과 비밀번호. 이 PC 안에만 저장됩니다.
2. **생성** 화면에서 **Custom 모드**를 고르고:
   - 캡션: 예) `warm lo-fi piano, vinyl crackle`
   - **인스트루멘털** 체크
   - **길이(초)에 `30`을 꼭 넣으세요.** 비워 두면 엔진이 길이를 정하는데, 몇 분짜리 곡이
     나올 수 있고 1070에서는 게이트웨이의 작업 제한 시간(15분)을 넘길 수 있습니다.
3. **생성 요청** → 진행률이 올라가다 완료되면 **라이브러리**에 곡이 생깁니다.
4. 곡을 열어 **재생**, **다운로드**(FLAC/WAV/MP3)를 해 봅니다.

생성되는 동안 엔진 창에 진행 로그가 올라가는 것이 보입니다. 30초 곡이 잘 되면 길이를 늘려
보세요. `engine:smoke`에서 잰 시간이 기준입니다.

---

## 5. 끄고 다시 켜기

| 끌 때 | 켤 때 (순서대로) |
| --- | --- |
| 웹 창에서 `Ctrl+C` | 1. `start_api_server.bat` (엔진, 1–2분 로딩) |
| `docker compose down` (데이터는 남음) | 2. `docker compose up -d` (빌드 없이 빠름) |
| 엔진 창 닫기 | 3. 웹: `$env:VITE_MUSICSTUDIO_API_URL=...` 후 `npm run dev` |

계정과 곡은 Docker 볼륨에 남아서 다시 켜도 그대로입니다. 전부 지우려면
`docker compose down -v`(되돌릴 수 없음).

코드를 업데이트(`git pull`)한 뒤에는 `docker compose up --build -d`로 다시 빌드하세요.

---

## 엔진에 닿지 않을 때

게이트웨이는 컨테이너 안에서 `host.docker.internal:8001`로 엔진을 찾습니다. Docker Desktop은
보통 이 주소를 Windows 쪽 `127.0.0.1`로 연결해 주지만, 환경에 따라 안 되는 경우가 있습니다.

1. 엔진 창에 `Uvicorn running on http://127.0.0.1:8001`이 떴는지, Windows에서
   `(Invoke-RestMethod http://127.0.0.1:8001/health).data`가 되는지 먼저 확인.
2. 그래도 `/ready`가 `failure`면, 엔진이 모든 주소에서 받도록 바꿉니다.
   `D:\ACE-Step-1.5\start_api_server.bat`을 메모장으로 열어, 맨 위 설정의 두 줄을
   ```bat
   set HOST=127.0.0.1
   REM set HOST=0.0.0.0
   ```
   이렇게 바꿉니다(`REM`이 붙은 줄은 꺼진 줄입니다).
   ```bat
   REM set HOST=127.0.0.1
   set HOST=0.0.0.0
   ```
   같은 파일에서 API 키 줄의 `REM`도 지우고 값을 정합니다. 같은 네트워크의 다른 기기가
   엔진을 쓰지 못하게 하려는 것입니다.
   ```bat
   set API_KEY=--api-key 여기에-아무-긴-문자열
   ```
   `musicstudio\.env`에도 같은 값을 한 줄 추가합니다:
   ```text
   MUSICSTUDIO_ENGINE_API_TOKEN=여기에-아무-긴-문자열
   ```
3. 엔진을 다시 켜고(처음이면 Windows 방화벽 창이 뜹니다 — **개인 네트워크만** 허용),
   `docker compose up -d`로 게이트웨이를 다시 띄운 뒤 `/ready`를 다시 확인합니다.

> 게이트웨이는 엔진을 1분마다 확인합니다. 엔진을 나중에 켰다면 1분쯤 기다리거나
> `docker compose restart gateway`로 바로 다시 확인하게 할 수 있습니다.

## 그 밖의 문제

| 증상 | 조치 |
| --- | --- |
| `docker compose up`에서 `port is already allocated` (5432/6379/8002/8080) | 이 PC의 다른 프로그램이 그 포트를 씀. `.env`에 다른 포트를 지정: 5432는 `MUSICSTUDIO_POSTGRES_PORT=55432`, 6379는 `MUSICSTUDIO_REDIS_PORT`, 8002는 `MUSICSTUDIO_DSP_PORT`. 8080이면 `MUSICSTUDIO_PORT=18080`과 `MUSICSTUDIO_PUBLIC_BASE_URL=http://localhost:18080`을 넣고, 웹의 `VITE_MUSICSTUDIO_API_URL`도 같은 포트로 |
| `set MUSICSTUDIO_JWT_SECRET` 오류 | `.env`가 `musicstudio` 폴더에 없음. 1단계를 다시 |
| 웹에서 로그인/가입이 "네트워크 오류" | 게이트웨이가 꺼져 있거나, `.env`의 `MUSICSTUDIO_CORS_ORIGINS`가 빠짐. 고친 뒤 `docker compose up -d` |
| 생성이 실패로 끝남 | 엔진 창의 마지막 오류와 `docker compose logs gateway --tail 50` 출력을 보내 주세요 |
| 15분 후 시간 초과 | 길이를 줄이세요(30–60초). 1070에서 긴 곡은 제한 시간을 넘길 수 있습니다 |

## 참고

- 엔진 설치: [LOCAL_ENGINE_WINDOWS.md](LOCAL_ENGINE_WINDOWS.md)
- 구성 설명과 환경 변수 전체: [`../README.md`](../README.md)의 "Running the whole thing",
  "Running the gateway directly"
