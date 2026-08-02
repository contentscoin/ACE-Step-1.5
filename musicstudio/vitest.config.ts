import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Property suites (design §10) run at least 100 cases each; give them room.
    testTimeout: 30_000,
    // Leave one core to the main thread.
    //
    // The workers report progress back to the main process by *awaiting* an
    // `onTaskUpdate` call over birpc, whose timeout is 60 s and is not
    // configurable from here. That call is only safe while the main thread can
    // still be scheduled. With one worker per core the property suites saturate
    // every core — the run that prompted this spent 242 s of test CPU inside
    // 102 s of wall clock, and `test/unit/sound-pack/cue-synthesis.test.ts`
    // alone holds a core for 30 s comparing 3003 MFCC pairs (Requirement 24.9).
    // Under that load the main thread can miss the window, and the worker then
    // throws `Timeout calling "onTaskUpdate"` as an unhandled error. It fails
    // the run *after* every test has already passed, so the signal is pure
    // noise: it says nothing about the code under test.
    //
    // A percentage rather than a fixed count, so this holds on both a 4-core CI
    // runner and a larger developer machine.
    maxWorkers: '75%',
  },
});
