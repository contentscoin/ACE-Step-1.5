/**
 * Waiting, expressed through the injected `Scheduler`.
 *
 * Requirements 5.2 (5-second polls), 6.2 (2-second-plus backoff) and 6.5 (resume
 * within 60 seconds) are all delays, and none of them may cost a test real time.
 * Routing every wait through the task 1.3 `Scheduler` port is what makes that
 * true: production passes the `setTimeout`-backed scheduler, tests pass a manual
 * one and drive it.
 *
 * There is no `setTimeout` anywhere in `services/generation/`, which is the
 * property this one-function module exists to keep enforceable.
 */

import type { Scheduler } from '../../adapters/registry/health-schedule';

export function sleepVia(scheduler: Scheduler, delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    scheduler.after(delayMs, resolve);
  });
}
