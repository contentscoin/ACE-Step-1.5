#!/usr/bin/env bash
# The end-to-end walkthrough (roadmap §4.4, slice S6).
#
#     MUSICSTUDIO_JWT_SECRET=$(openssl rand -hex 32) docker compose up --build -d
#     ./run_api_server.sh            # from the repository root, on a machine with a GPU
#     ./scripts/e2e.sh
#
# Register, log in, ask for a song, wait for it, list it, stream it, download it — and check
# that what comes back is really audio. It is the same journey
# `test/integration/composition-root.test.ts` drives through `app.inject()`; this one goes over
# a socket, against a gateway that was started rather than constructed, so it also proves the
# container, the compose network and the engine are talking to each other.
#
# Exits non-zero on the first thing that is not true, and says which.

set -euo pipefail

BASE_URL="${MUSICSTUDIO_BASE_URL:-http://localhost:8080}"
EMAIL="${MUSICSTUDIO_E2E_EMAIL:-e2e-$(date +%s)@studio.test}"
PASSWORD='correct-horse-battery-staple'
FORMAT="${MUSICSTUDIO_E2E_FORMAT:-wav}"
# The engine's own budget is 900 s (Requirement 5.8); this is how long we watch it.
POLL_SECONDS="${MUSICSTUDIO_E2E_TIMEOUT:-600}"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

step() { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
die()  { printf '  \033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required"; }
need curl
need python3

# `python3` rather than `jq`: the DSP side already requires Python, so this adds no dependency
# a developer of this repository does not have. The path is walked, not evaluated — a key or an
# index per argument — so nothing here executes what it reads.
json() {
  python3 -c '
import json, sys
value = json.load(sys.stdin)
for step in sys.argv[1:]:
    value = value[int(step)] if step.lstrip("-").isdigit() else value[step]
print(value)
' "$@"
}

api() {
  local method="$1" path="$2" body="${3:-}" token="${4:-}"
  local args=(-sS -X "$method" "${BASE_URL}${path}" -H 'content-type: application/json')
  [ -n "$token" ] && args+=(-H "authorization: Bearer ${token}")
  [ -n "$body" ] && args+=(-d "$body")
  curl "${args[@]}"
}

step "The gateway is up, and says what it can reach"
READY="$(curl -sS "${BASE_URL}/ready")" || die "no answer from ${BASE_URL}/ready — is compose up?"
echo "  ${READY}"
STATUS="$(printf '%s' "$READY" | json status)"
[ "$STATUS" = unavailable ] && die "a store is down; the checks above say which"
ENGINE="$(printf '%s' "$READY" | json checks engine)"
[ "$ENGINE" = available ] || die "the engine is ${ENGINE}: start ACE-Step on the host (./run_api_server.sh) and retry"
ok "database, Redis, DSP and the engine all answer"

step "Requirement 1.1 / 1.3 — register, then log in"
api POST /v1/auth/register "{\"email\":\"${EMAIL}\",\"password\":\"${PASSWORD}\"}" > "${WORK_DIR}/register.json" \
  || die "registration failed"
ok "registered ${EMAIL}"
api POST /v1/auth/login "{\"email\":\"${EMAIL}\",\"password\":\"${PASSWORD}\"}" > "${WORK_DIR}/login.json"
TOKEN="$(json accessToken < "${WORK_DIR}/login.json")"
[ -n "$TOKEN" ] || die "no access token in the login response"
ok "logged in"

step "Requirement 3 — ask for a song in Simple_Mode"
api POST /v1/songs/simple \
  '{"description":"a calm piano piece over soft rain","durationSeconds":30}' \
  "$TOKEN" > "${WORK_DIR}/submit.json"
JOB_ID="$(json jobId < "${WORK_DIR}/submit.json")"
[ -n "$JOB_ID" ] || { cat "${WORK_DIR}/submit.json"; die "the job was not accepted"; }
ok "job ${JOB_ID} accepted, engine $(json engineId < "${WORK_DIR}/submit.json")"

step "Requirement 5.2 / 5.3 — the gateway polls it; we watch"
DEADLINE=$(( $(date +%s) + POLL_SECONDS ))
STATE=pending
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  api GET "/v1/generation-jobs/${JOB_ID}" '' "$TOKEN" > "${WORK_DIR}/status.json"
  STATE="$(json state < "${WORK_DIR}/status.json")"
  case "$STATE" in
    succeeded) break ;;
    failed|cancelled) cat "${WORK_DIR}/status.json"; die "the job ended ${STATE}" ;;
  esac
  printf '  … %s\r' "$STATE"
  sleep 5
done
[ "$STATE" = succeeded ] || die "still ${STATE} after ${POLL_SECONDS}s"
ASSET_ID="$(json assetIds 0 < "${WORK_DIR}/status.json")"
ok "succeeded, asset ${ASSET_ID}"

step "Requirement 11.1 — it is in the library"
api GET /v1/library/assets '' "$TOKEN" > "${WORK_DIR}/library.json"
# The listing is passed by path, not on stdin: `python3 -` already takes its program there.
python3 - "$ASSET_ID" "${WORK_DIR}/library.json" <<'PY' || die "the asset is not in the listing"
import json, sys
page = json.load(open(sys.argv[2]))
sys.exit(0 if any(a["id"] == sys.argv[1] for a in page["assets"]) else 1)
PY
ok "listed"

step "Requirement 12.1 / 12.2 — it streams, and it seeks"
curl -sS -D "${WORK_DIR}/stream.headers" -o "${WORK_DIR}/stream.bin" \
  -H "authorization: Bearer ${TOKEN}" "${BASE_URL}/v1/playback/assets/${ASSET_ID}/stream"
grep -qi '^accept-ranges: bytes' "${WORK_DIR}/stream.headers" || die "no accept-ranges on the stream"
ok "streamed $(wc -c < "${WORK_DIR}/stream.bin") bytes, play count $(grep -i '^x-play-count' "${WORK_DIR}/stream.headers" | tr -d '\r' | cut -d' ' -f2)"
curl -sS -D "${WORK_DIR}/range.headers" -o /dev/null -r 0-1023 \
  -H "authorization: Bearer ${TOKEN}" "${BASE_URL}/v1/playback/assets/${ASSET_ID}/stream"
grep -qi '^HTTP/1.1 206' "${WORK_DIR}/range.headers" || die "a range request did not answer 206"
ok "a range request answers 206 with content-range $(grep -i '^content-range' "${WORK_DIR}/range.headers" | tr -d '\r' | cut -d' ' -f2-)"

step "Requirement 13 — download it, and check the bytes are audio"
HTTP_CODE="$(curl -sS -o "${WORK_DIR}/download.bin" -D "${WORK_DIR}/download.headers" \
  -w '%{http_code}' -H "authorization: Bearer ${TOKEN}" \
  "${BASE_URL}/v1/library/assets/${ASSET_ID}/download?format=${FORMAT}")"
if [ "$HTTP_CODE" = 402 ]; then
  die "lossless download refused by Requirement 13.4 — set MUSICSTUDIO_DEFAULT_PLAN_ID=creator, or use MUSICSTUDIO_E2E_FORMAT=mp3"
fi
[ "$HTTP_CODE" = 200 ] || { cat "${WORK_DIR}/download.bin"; die "download answered ${HTTP_CODE}"; }

python3 - "$FORMAT" "${WORK_DIR}/download.bin" <<'PY' || die "the download is not ${FORMAT} audio"
import sys
fmt, path = sys.argv[1], sys.argv[2]
data = open(path, 'rb').read()
if fmt == 'wav':
    ok = data[:4] == b'RIFF' and data[8:12] == b'WAVE'
elif fmt == 'flac':
    ok = data[:4] == b'fLaC'
elif fmt == 'ogg':
    ok = data[:4] == b'OggS'
elif fmt == 'mp3':
    ok = data[:3] == b'ID3' or (data[:1] == b'\xff' and data[1] >= 0xe0)
else:
    ok = False
print(f'  first bytes: {data[:12]!r}  ({len(data)} bytes)')
sys.exit(0 if ok else 1)
PY
ok "downloaded $(grep -i '^content-disposition' "${WORK_DIR}/download.headers" | tr -d '\r' | sed 's/.*filename="\([^"]*\)".*/\1/')"
ok "sample rate $(grep -i '^x-sample-rate' "${WORK_DIR}/download.headers" | tr -d '\r' | cut -d' ' -f2), usage $(grep -i '^x-usage-purpose' "${WORK_DIR}/download.headers" | tr -d '\r' | cut -d' ' -f2)"

printf '\n\033[1;32m음악이 생성된다 — end to end, over HTTP, with real audio at the end.\033[0m\n\n'
