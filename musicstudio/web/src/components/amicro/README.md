# Amicro components, vendored

Requirements 31.1, 31.2, 31.3, 31.15, 31.17.

## Why these files are in the repository rather than installed at build time

Requirement 31.15 requires a build to **succeed with no network access to the external registry**
and still ship the four component categories of 31.1. A build that ran `npx amicro add …` could not
do that, and a lockfile does not help — a shadcn-style registry serves source files over HTTP at
install time, not a package the lockfile pins.

So the components are *installed once and committed*. `components.json` declares the `@amicro`
namespace and the pinned version (31.2, 31.3), `registry.json` beside this file records the listing
those components came from, and nothing in `vite.config.ts`, in a `postinstall`, or in a plugin
fetches anything. `npm run build` with the network unplugged produces the same output.

## What is unverified, and what to do about it

**The registry listing in `registry.json` is a transcription, not a fetch.** No `@amicro` registry
was reachable when these components were written: the only published package matching the name
(`@subhanhq/amicro@1.0.1`) is a card-layout library with none of the loaders Requirement 31.6 names
and no registry manifest or CLI of its own. The eight loading-category names are taken verbatim from
Requirement 31.6, which names them; the entry, hover and text names are **product decisions** made
so the four categories of 31.1 have something concrete to point at.

This is a §14 risk to settle with whoever owns the registry, and the shape of the fix is small:
replace the four `.tsx` files here with the registry's own, and correct `registry.json` to the
listing it publishes. Everything that *checks* those components — the preset table, the
classification table, the static check, the settle-time bound — stays exactly as it is, because none
of it depends on who wrote the component.

## Licence (Requirement 31.17)

Amicro is MIT-licensed. The notice is reproduced in `src/notices/open-source.ts`, which is what the
product's open-source notice screen renders. A vendored component still carries its licence: copying
the source is what the registry is *for*, and it does not make the copy unlicensed.
