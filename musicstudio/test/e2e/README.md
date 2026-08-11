# End-to-end scenarios (task 9.3)

Seven flows, one file each, named for the flow rather than for the module under test.

## What "end to end" means here, precisely

It means **the real composition of the layers that exist** — never a stub standing in for one
of the product's own layers. What is substituted, and only this, is what design §1.4.1 places
outside the product: the generation engines (a scripted double reproducing their wire contract),
the object store, and the SQL stores (in-memory implementations built from the same domain
functions the SQL would have to reproduce).

That distinction is worth stating because it is not uniform across the seven:

| Flow | Runs through |
|---|---|
| 인증 | HTTP, `app.inject` |
| 생성 | HTTP for the request, service for the library read (Requirement 11 has no route yet) |
| 편집 | HTTP |
| 타임라인 | Service composition — Requirement 28 has no routes; task 9.1 mounted Requirement 17's |
| 안전 | HTTP |
| 라이선스 | Service composition — the download path is `Library_Service` + `Licensing_Service` |
| Public_API | HTTP, except the webhook delivery — see below |

Two of the seven are service-level because the product has no HTTP surface for them yet, and
saying so here is better than a file that reads as if everything is a request. When Requirement
28's routes land, those two move up a layer and this table changes.

## What these flows found, and what is still open

Writing them surfaced three things no per-clause test could:

- **Migration 0013 could never have been applied.** Its `CHECK` used a subquery, which
  PostgreSQL rejects with `0A000`; the migration suite had been skipping for want of a database.
  Fixed with `jsonb_path_exists`, and the suite now runs against a real PostgreSQL in CI.
- **The moderation gate was unreachable over HTTP.** The orchestrator, the gate and the 403
  presenter all existed and were all tested, but no route supplied a verdict, so Requirement
  16.2 could not be triggered by a request. `SongGateway` now takes a `Moderation_Service`.
- **A refusal named the wrong licence.** For an asset restricted by Requirement 33.21 — its own
  licence permissive, an ancestor's not — the 403 reported the asset's own `weightLicenseId`.
  `Licensing_Service` now reads the deciding licences from the lineage.

One gap is **not** closed, and the Public_API flow says so where it drives around it: nothing
calls `WebhookDispatcher.onJobTerminal` on its own. A Generation_Job does not record the API key
that submitted it, so the orchestrator has no key to dispatch for. The flow exercises the real
dispatcher over the real endpoint store the HTTP registration wrote to — the hand-off is
covered — but the trigger is the test, not the product. Requirement 17.10 is therefore satisfied
in parts and not as a whole.

## Why they are separate from `test/integration/`

`test/integration/` asserts a *contract*: this route answers 403, this envelope carries these
fields. These assert a *journey*: the state each step leaves behind is the state the next step
needs, and a step's effect is observed where a user would see it rather than where it was
written. A flow can be green with every contract test green — that is the gap these close.

## Nothing here sleeps or reaches a network

Time moves only when a harness clock is advanced. There is no `setTimeout`, no retry loop, and
no port bound. A flow that needed a real second to pass would be a flow nobody runs.
