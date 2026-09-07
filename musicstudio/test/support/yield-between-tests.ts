import { beforeEach } from 'vitest';

/**
 * One macrotask turn before every test.
 *
 * Registered through `setupFiles` in `vitest.config.ts`, so it applies to every file. It exists
 * for one failure: `[vitest-worker]: Timeout calling "onTaskUpdate"`, with every test passing.
 *
 * A vitest worker reports each finished test to the main thread over `birpc`, and the reply
 * comes back as a `MessagePort` message — a macrotask, delivered in the event loop's poll
 * phase. birpc gives up on a reply after a hard-coded 60 seconds that no option reaches (see
 * `createRuntimeRpc` in vitest's `rpc` chunk). A file whose tests are CPU-bound and synchronous,
 * and which between tests only ever `await` promises that are already settled, spends its whole
 * run in microtasks: the loop never reaches the poll phase, the reply sits undelivered, and once
 * the file has run for 60 s the timer fires and vitest counts an unhandled error against a run
 * in which nothing failed. `sound-pack/sound-pack-service.test.ts` — 78 synthesised cues per
 * case — takes ~30 s on a developer machine and passed; on a contended CI runner it took 64 s
 * and did not.
 *
 * `setImmediate` runs in the check phase, *after* poll, so awaiting it once per test lets any
 * pending reply be delivered before the next block of synchronous work begins. The cost is a
 * millisecond per test across the suite. The four-shard split in the workflow remains for the
 * critical path; this is what removes the failure rather than shortening the exposure to it.
 */
beforeEach(
  () =>
    new Promise<void>((resolve) => {
      setImmediate(resolve);
    }),
);
