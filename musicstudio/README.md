# MusicStudio (product layer)

Self-contained product-layer service for the multimodal AI audio studio. ACE-Step
is an **external service** to this layer (design §2.1), so `musicstudio/` carries
its own toolchain and is prepared for extraction into a standalone repository
with `git filter-repo` (design §1.4.1).

Spec: `.kiro/specs/ai-music-generation-service/` (`requirements.md`, `design.md`,
`tasks.md`). This directory currently contains the task 1.0 scaffold only.

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
- `dsp/pyproject.toml` — DSP worker deps, resolved separately from the engine's PyTorch/CUDA stack.
- The repository root `package.json` (VitePress docs) and `pyproject.toml` (ACE-Step engine) are **never modified**.

## Local commands

Node 22, Python 3.11–3.12.

```bash
# TypeScript side
npm install
npm run lint        # includes the acestep import boundary rules
npm run typecheck
npm test            # vitest + fast-check (test/property, test/unit)

# Python DSP worker side
cd dsp
python -m venv .venv && . .venv/bin/activate
pip install -e '.[dev]'
python scripts/check_import_boundary.py   # boundary check over musicstudio/
pytest                                    # pytest + hypothesis
```

## Layout (design §1.4.5)

```
api/        API gateway layer (Fastify): gateway/, public/, sse/
services/   Domain services (§2.2)
adapters/   Engine adapters (§3.1) — the only external engine coupling point
domain/     Parsers/printers and data models (§4, §7) — pure logic, main PBT target
dsp/        Python DSP worker (§5, §12): src/, test/, scripts/
web/        React SPA (§8) + UI_Sound_Layer
db/         PostgreSQL migrations and schema (§4)
test/       TypeScript tests (§10): property/, unit/, integration/
```

`AGENTS.md` at the repository root governs `acestep/`, not this tree (design
§1.4.3). Two of its principles still apply here: keep modules single-responsibility
and small, and pair every behaviour change with a test that pins it.
