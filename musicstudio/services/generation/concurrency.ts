/**
 * A bounded-concurrency map, for the fan-outs the requirements cap.
 *
 * Requirement 24.1's sound pack is 78 cue generations and task 3.4 caps them at 8 in
 * flight. Nothing in the repository already does this — `scheduling.ts` is a single
 * `sleepVia`, `job-orchestrator.ts` awaits one job at a time, and the credit layer's
 * `tryAcquireJobSlot` enforces a *plan's* concurrent-job allowance against Redis rather
 * than limiting a local loop — so this is written here rather than reached for.
 *
 * It lives beside `scheduling.ts` in `services/generation/` because it is a scheduling
 * primitive and not a sound-pack one: nothing in it mentions a cue, and Requirement 22.16's
 * eight variants or Requirement 28's clip renders could use it unchanged.
 *
 * ### Why not `Promise.all` in slices of 8
 *
 * Because slices idle. A slice of eight finishes when its *slowest* member does, so with
 * 78 tasks of uneven duration — and cue generations are uneven, since Requirement 24.21
 * retries some of them twice — the pipeline drains to one in flight ten times over. This
 * starts a new task the moment any task finishes, so the ceiling is also the floor while
 * work remains, which is what "동시 8개" should mean.
 *
 * ### Ordering and failure, both deliberate
 *
 * - **Results come back in input order**, not completion order. The pack's cue order is the
 *   taxonomy's (see `SEMANTIC_CUES`) and Requirement 24.22's "나중에 생성된 큐" is read off
 *   it, so a scheduler that returned cues in whatever order they finished would make that
 *   clause depend on timing.
 * - **A rejection does not cancel the others.** `mapWithConcurrency` settles every task and
 *   returns each outcome, because Requirement 24.21 requires that the cues which succeeded
 *   be kept when others fail. `Promise.all`'s fail-fast is exactly wrong here: it would
 *   abandon up to seven in-flight generations the user has already been charged for. A
 *   caller that wants fail-fast can throw on the first `rejected` it finds, which is a
 *   decision it can make with the whole picture rather than one made for it by the
 *   combinator.
 *
 * Deterministic given deterministic tasks: the worker loop pulls indices in ascending order,
 * so which task starts next is fixed, and only *when* it starts depends on timing.
 */

/** One task's outcome. `PromiseSettledResult`'s shape, with the index kept. */
export type SettledTask<T> =
  | { readonly index: number; readonly status: 'fulfilled'; readonly value: T }
  | { readonly index: number; readonly status: 'rejected'; readonly reason: unknown };

/**
 * Run `task` over every item with at most `limit` in flight.
 *
 * `limit` is clamped to at least 1: a limit of 0 would deadlock, and a caller that computed
 * one from a configuration value should get a slow run rather than a hang.
 */
export async function mapWithConcurrency<Input, Output>(
  items: readonly Input[],
  limit: number,
  task: (item: Input, index: number) => Promise<Output>,
): Promise<readonly SettledTask<Output>[]> {
  const ceiling = Math.max(1, Math.floor(limit));
  const results = new Array<SettledTask<Output>>(items.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;

      try {
        results[index] = {
          index,
          status: 'fulfilled',
          value: await task(items[index] as Input, index),
        };
      } catch (reason) {
        results[index] = { index, status: 'rejected', reason };
      }
    }
  };

  // `next` is read and incremented with no `await` between the two statements, so no two
  // workers can claim the same index — JavaScript's run-to-completion semantics make that a
  // guarantee rather than a race that happens not to have been observed.
  const workers = Array.from({ length: Math.min(ceiling, items.length) }, () => worker());
  await Promise.all(workers);

  return results;
}

/**
 * The same, for a caller that wants the values and will let the first failure throw.
 *
 * Still runs every task to completion first — the difference is only in what is returned,
 * so a rejection cannot leave in-flight work unaccounted for.
 */
export async function mapWithConcurrencyOrThrow<Input, Output>(
  items: readonly Input[],
  limit: number,
  task: (item: Input, index: number) => Promise<Output>,
): Promise<readonly Output[]> {
  const settled = await mapWithConcurrency(items, limit, task);
  const failure = settled.find((result) => result.status === 'rejected');
  if (failure !== undefined && failure.status === 'rejected') throw failure.reason;
  return settled.map((result) => (result as { value: Output }).value);
}

/**
 * The greatest number of tasks that were ever in flight at once.
 *
 * A test helper that belongs with the limiter rather than in a test file, because "at most 8
 * concurrent" is the property this module exists to provide and asserting it needs an
 * observation the limiter is in the best position to define. Wrap a task with this and the
 * peak is measured rather than inferred from timings.
 */
export function withConcurrencyProbe<Input, Output>(
  task: (item: Input, index: number) => Promise<Output>,
): {
  readonly probed: (item: Input, index: number) => Promise<Output>;
  peak(): number;
} {
  let inFlight = 0;
  let peak = 0;

  return {
    probed: async (item, index) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        return await task(item, index);
      } finally {
        inFlight -= 1;
      }
    },
    peak: () => peak,
  };
}
