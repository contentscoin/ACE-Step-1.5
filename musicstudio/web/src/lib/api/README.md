# The studio API seam

Task 7.3. Two things live here and it is worth being precise about which is which.

## `port.ts` — what the screens are allowed to ask for

An interface, not a client. Every screen depends on `StudioApi` and nothing else, so the app can
be pointed at the HTTP gateway (task 9.1) by swapping one provider — and, more importantly, so a
screen cannot reach past it and start deciding things the services decide.

## `demo-api.ts` — an in-memory implementation, over the real rules

The HTTP routes do not exist yet (task 9.1 owns them), so this is what the screens run against.
It is **not a fixture returning canned JSON**. It calls the same functions
`musicstudio/services/` calls:

| screen question | who answers |
|---|---|
| which assets are in this listing | `domain/library/query.ts` → `applyLibraryQuery` |
| may I download this, in this format | `domain/library/download.ts` → `ruleOnDownload` |
| which byte window is this seek | `domain/playback/range.ts` → `planRangeResponse` |
| which lyric line is showing | `domain/playback/lyrics-sync.ts` → `activeLineAt` |
| where does the playhead land on pass 3 | `domain/playback/loop.ts` → `positionAt` |
| what is in the explore feed | `domain/sharing/feed.ts` → `applyFeedQuery` |
| does a second like change the count | `domain/sharing/like.ts` → `applyLike` |
| is this song request valid | `domain/song/validation.ts` → `validateSongRequest` |
| what does this edit do to the project | `domain/timeline/commands.ts` → `plan*` + `executeCommand` |

That is the point of the `@domain` alias in `vite.config.ts`. A UI that re-derived any of those
would be a second answer to a settled question, and the two would drift in the direction that is
hardest to notice: the screen would look right while the server disagreed.

## What the demo backend does invent

Timing and audio. There is no engine, so a submitted job advances on a timer and finishes with a
seeded asset; there is no object store, so the player's audio is a generated tone. Both are
confined to this file, and both are the parts a real deployment replaces first.
