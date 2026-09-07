# MusicStudio (product layer)

Self-contained product-layer service for the multimodal AI audio studio. ACE-Step
is an **external service** to this layer (design §2.1), so `musicstudio/` carries
its own toolchain and is prepared for extraction into a standalone repository
with `git filter-repo` (design §1.4.1).

Spec: `.kiro/specs/ai-music-generation-service/` (`requirements.md`, `design.md`,
`tasks.md`). Spec tasks **1.0 through 9.3 are implemented** — infrastructure,
generation, DSP, timeline, library/playback/sharing, safety/consent/licensing,
frontend, observability, and the public API, each with the tests its task names.
What is deliberately still open is listed under [Not wired yet](#not-wired-yet), and
`docs/ROADMAP.md` is the plan for closing it.

## Live demo

<https://acestep-musicstudio-demo.vercel.app>

The React SPA, built from `web/` and served as a static bundle. It is worth being
precise about what is running, because the interesting half is real:

- **The rules are the product's own.** The screens talk to `StudioApi`
  (`web/src/lib/api/port.ts`), and the demo implementation behind it
  (`demo-api.ts`) answers by calling the same `domain/` functions the services
  call — `applyLibraryQuery`, `ruleOnDownload`, `planRangeResponse`,
  `activeLineAt`, `positionAt`, `applyFeedQuery`, `applyLike`,
  `validateSongRequest`, `executeCommand`. A screen that re-derived any of those
  would be a second answer to a settled question.
- **The app says it is a demo, on every screen.** A banner above the navigation
  states that no music is generated, and the player repeats it beside the
  transport. It reads `api.backend.kind` rather than a build flag, so it
  disappears when a gateway is wired and cannot be left switched on by mistake.
- **No music is generated, and the audio is synthetic.** There is no engine, so a
  submitted job advances on a timer and finishes with a seeded asset. The sound
  is a seeded harmonic tone rendered from the asset id
  (`web/src/lib/api/demo-audio.ts`) — the same bytes the player streams and the
  download delivers, so the file you save is the audio you heard. Both are what a
  real deployment replaces first.
- **The download is a real file.** It used to report a prepared file of
  `duration × 48000 × channels × 2` bytes and deliver nothing. It now returns a
  WAV whatever format was requested — the demo has no encoder — and the panel
  says which format arrived instead of repeating which was asked for.
- **State is per-session.** The demo backend holds published assets, renames and
  timeline history in memory. A reload returns to the seed.

Routing is hash-based (`web/src/app/router.tsx`), which is why the bundle needs no
server rewrites and works from any static host:

| Route | Screen |
| ----- | ------ |
| `#/generate` (default) | Simple/Custom generation request |
| `#/library`, `#/asset/:id` | Library listing and asset detail |
| `#/timeline` | Timeline project, clips, undo/redo |
| `#/mastering` | Mastering measurement and suggestions |
| `#/explore` | Public feed |
| `#/s/:token` | Public share page (Req 14.4 revocation included) |
| `#/system` | Design-system reference |

### Redeploying it

The Vercel project builds `web/` from a checkout of this repository rather than
from an uploaded copy, so the deployed bundle is always this source:

```
Build   git clone --depth 1 --filter=blob:none --sparse <repo> && git sparse-checkout set musicstudio
        && cd musicstudio/web && npm ci && npm run build
Output  dist
```

Connecting the repository to Vercel directly is equivalent and simpler: Root
Directory `musicstudio/web`, framework Vite, build `npm run build`, output `dist`.

## Coupling invariant (design §1.4.4, §14 risk #9)

> No code under `musicstudio/` imports `acestep/`. The only coupling point to
> ACE-Step is the HTTP interface called by `ACE_Engine_Adapter` (§3.1, §3.6).

Enforcement, with no exemptions:

| Language   | Mechanism                                                             |
| ---------- | --------------------------------------------------------------------- |
| TypeScript | ESLint `no-restricted-imports` + `no-restricted-syntax` — `eslint.boundary.mjs` |
| Python     | `dsp/scripts/check_import_boundary.py` (AST scan of `musicstudio/**/*.py`) |

Both run in `.github/workflows/musicstudio-ci.yml`, which is path-filtered to
`musicstudio/**` and does not touch the host repository workflows.

## Independent toolchain (design §1.4.2, §12.1)

- `package.json` / `tsconfig.json` — product-layer Node/TypeScript deps and compiler settings.
- `web/package.json` — the SPA's own deps, resolved separately again.
- `dsp/pyproject.toml` — DSP worker deps, resolved separately from the engine's PyTorch/CUDA stack.
- The repository root `package.json` (VitePress docs) and `pyproject.toml` (ACE-Step engine) are **never modified**.

## Running the gateway (slice S5)

`api/gateway/main.ts` is the composition root: PostgreSQL for accounts and assets, Redis
for sessions, the ACE-Step adapter over HTTP, the DSP sidecar over HTTP and a filesystem
object store. Four things are required; everything else defaults to a local setup.

```bash
# 1. Stores (any PostgreSQL 16 and Redis 7 will do)
export MUSICSTUDIO_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/musicstudio
export MUSICSTUDIO_REDIS_URL=redis://127.0.0.1:6379
export MUSICSTUDIO_JWT_SECRET=$(openssl rand -hex 32)
export MUSICSTUDIO_PUBLIC_BASE_URL=http://127.0.0.1:8080

# 2. Schema
npm run db:migrate                     # or MUSICSTUDIO_MIGRATE_ON_START=true

# 3. The two other processes, in their own terminals
(cd .. && ./run_api_server.sh)         # ACE-Step on :8001   → MUSICSTUDIO_ENGINE_URL
(cd dsp && PYTHONPATH=src python -m musicstudio_dsp.sidecar)   # DSP on :8002 → MUSICSTUDIO_DSP_URL

# 4. Gateway
npm start                              # :8080; MUSICSTUDIO_HOST / MUSICSTUDIO_PORT
curl -s localhost:8080/ready           # {"status":"ready","checks":{database,redis,dsp,engine}}
```

`GET /health` is liveness; `GET /ready` reports each dependency and answers 503 only when a
store is down — an unreachable engine or sidecar is `degraded`, and the health monitor keeps
probing. Optional settings: `MUSICSTUDIO_ENGINE_API_TOKEN`, `MUSICSTUDIO_ENGINE_EXECUTION_LOCATION`
(`local`|`remote`), `MUSICSTUDIO_ENGINE_WEIGHT_LICENSE_ID` (recorded on every asset,
Requirement 33.7), `MUSICSTUDIO_ENGINE_DAILY_MAX_REQUESTS` / `_GPU_SECONDS`,
`MUSICSTUDIO_OBJECT_STORE_DIR` (default `data/objects`).

What is still v0 in this composition is named in `api/gateway/composition.ts`: the job
store, queue and event bus are in-memory (a restart forgets in-flight jobs), no credits
are charged, and no moderation service is composed. `docs/ROADMAP.md` §4.4 tracks each.

## Local commands

Node 22, Python 3.11–3.12.

```bash
# TypeScript side
npm install
npm run lint             # includes the acestep import boundary rules
npm run typecheck
npm test                 # vitest + fast-check (test/property, test/unit, test/e2e)
npm run check:properties # every Property in design §10 is declared by some test
npm run test:db          # needs PostgreSQL 16 (+ Redis, + the DSP sidecar for two files); see test/integration

# React SPA
cd web
npm install
npm run dev              # Vite dev server against the in-browser demo backend
npm run build            # motion + sound-budget + a11y gates, then tsc and vite build
npm test                 # vitest + happy-dom

# Python DSP worker side
cd dsp
python -m venv .venv && . .venv/bin/activate
pip install -e '.[dev]'
python scripts/check_import_boundary.py   # boundary check over musicstudio/
pytest                                    # pytest + hypothesis
```

`web`'s `build` runs its static checks *before* the bundler on purpose: Requirement
31.5 says a violation produces no build artefact, and a Vite plugin doing the same
work would run after the output directory had already been written.

## Continuous integration

`.github/workflows/musicstudio-ci.yml`, path-filtered to `musicstudio/**`:

| Job | What it gates |
| --- | ------------- |
| Import boundary (musicstudio -> acestep) | design §14 risk #9, both languages |
| TypeScript (lint + typecheck) | ESLint, `tsc --noEmit`, property audit |
| TypeScript tests (shard 1–4/4) | vitest across `test/` |
| Web (static checks + tests + build) | motion, 20 KB sound budget, a11y, build |
| DSP worker (pytest + hypothesis) | `dsp/`, with ffmpeg and the `audio` extra installed |
| Database migrations (PostgreSQL 16) | `db/migrations` applied against a real server |

The database job exists because the schema tests used to skip without a server,
and that skip once hid a migration that could not be applied at all.

## Layout (design §1.4.5)

```
api/        API gateway layer (Fastify): gateway/, public/, sse/
services/   Domain services (§2.2)
adapters/   Engine adapters (§3.1) — the only external engine coupling point
domain/     Parsers/printers and data models (§4, §7) — pure logic, main PBT target
dsp/        Python DSP worker (§5, §12): src/, test/, scripts/
web/        React SPA (§8) + UI_Sound_Layer
db/         PostgreSQL migrations and schema (§4)
scripts/    Repository checks that CI runs (e.g. the Property audit)
test/       TypeScript tests (§10): property/, unit/, integration/, e2e/
docs/       Handover notes
```

`test/e2e/` holds seven flows named after journeys rather than modules — auth,
generation, edit, timeline, safety, licensing, Public_API. `test/e2e/README.md`
records, per flow, which layers are real and which are substituted, because that
is not uniform across the seven and a file that reads as though it were would be
misleading.

## Not wired yet

- **Webhook delivery has no production trigger** (Requirement 17.10, partial).
  `WebhookDispatcher.onJobTerminal` is exercised by the Public_API flow against a
  real endpoint store, but nothing calls it automatically: `Generation_Job` does
  not record the API key that submitted it, so the orchestrator has no key to
  dispatch to.
- **The gateway needs its externals.** Running `api/gateway` for real wants
  PostgreSQL, Redis/BullMQ, an object store and a reachable ACE-Step engine. The
  SPA demo above needs none of them, which is the point of the `StudioApi` seam.

`AGENTS.md` at the repository root governs `acestep/`, not this tree (design
§1.4.3). Two of its principles still apply here: keep modules single-responsibility
and small, and pair every behaviour change with a test that pins it.
