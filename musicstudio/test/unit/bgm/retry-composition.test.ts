import { describe, expect, it } from 'vitest';

import { BGM_LOOP_QUALITY_MAX_ATTEMPTS } from '../../../domain/bgm/bounds';
import { MAX_ENGINE_RETRY_ATTEMPTS } from '../../../domain/generation-job/retry-policy';
import { isGenerationError } from '../../../services/generation/errors';
import {
  DEFAULT_BGM_BPM,
  DEFAULT_BGM_TIME_SIGNATURE,
  bgmLoopRequest,
  createBgmHarness,
} from '../../support/bgm-harness';
import { drainScheduler } from '../../support/generation-harness';
import { compliantLoop, monoAudio, withClickAt } from '../../support/pcm-synthesis';

/**
 * Requirement 21.18's quality retry against Requirement 6.2's transport retry.
 *
 * **Validates: Requirements 6.1, 6.2, 6.3, 21.18**
 *
 * Two retry budgets exist on the same code path and they count different events. This
 * file is the evidence that neither consumes the other:
 *
 * - **6.2 counts re-requests of one submission** to an engine that refused it — up to
 *   three, at least two seconds apart, inside a single `SongGateway.submit`. Its counter
 *   is `attemptsMade` on that one job record.
 * - **21.18 counts complete generations whose audio failed the seam criteria** — up to
 *   three, each a fresh Generation_Job with a different seed. Its counter is the loop in
 *   `bgm-service.ts`.
 *
 * The rule that keeps them apart is that a non-`produced` submission returns immediately.
 * A transport failure produced no audio, so no criterion was unmet, so 21.18's remedy —
 * a different seed — has nothing to address. And a quality miss happens *after* the engine
 * answered successfully, so it never touches `attemptsMade`.
 *
 * Nothing here sleeps: the 6.2 backoff runs on the harness's manual scheduler.
 */

const bpm = DEFAULT_BGM_BPM;
const timeSignature = DEFAULT_BGM_TIME_SIGNATURE;

function goodLoop() {
  return compliantLoop({ bpm, timeSignature, barCount: 4 }).audio;
}

function clickingLoop() {
  const channel = goodLoop().channels[0];
  if (channel === undefined) throw new Error('no channel');
  return monoAudio(withClickAt(channel, channel.length - 1, 1.0));
}

/** A queue-saturation refusal — the HTTP 429 Requirement 6.2 keys on. */
function saturated(): Error & { statusCode: number } {
  return Object.assign(new Error('queue full'), { statusCode: 429 });
}

describe('a transport failure does not spend a quality attempt (Requirement 21.18)', () => {
  it('returns the engine failure without regenerating for quality', async () => {
    const harness = createBgmHarness();
    // Every 6.2 re-request refused, so submission fails before any audio exists.
    harness.generation.adapter.failSubmit(saturated(), 10);

    const pending = harness.service.generate({
      accountId: 'user-1',
      request: bgmLoopRequest(),
    });
    await drainScheduler(harness.generation.scheduler);
    const outcome = await pending;

    expect(outcome.kind).toBe('failed');
    // The quality gate was never reached: no audio was fetched, so no seam was judged.
    expect(harness.candidates.calls).toHaveLength(0);
    // And exactly one Generation_Job existed, not three.
    expect(harness.generation.charges.requests).toHaveLength(1);
  });

  it('spends the whole 6.2 budget inside that one job, not across three', async () => {
    const harness = createBgmHarness();
    harness.generation.adapter.failSubmit(saturated(), 10);

    const pending = harness.service.generate({
      accountId: 'user-1',
      request: bgmLoopRequest(),
    });
    await drainScheduler(harness.generation.scheduler);
    const outcome = await pending;
    if (outcome.kind !== 'failed') throw new Error('expected a transport failure');

    // Requirement 6.2's three re-requests plus the original: four engine calls in all,
    // and all four belong to the single job.
    expect(harness.generation.adapter.submitCount).toBe(MAX_ENGINE_RETRY_ATTEMPTS + 1);
    const record = await harness.generation.store.find(outcome.jobId);
    expect(record?.attemptsMade).toBe(MAX_ENGINE_RETRY_ATTEMPTS);
    // Requirement 6.3: the count ran out, and that is the reason reported.
    expect(outcome.failure.reason).toBe('retries_exhausted');
  });

  it('is distinguished from a quality miss by its failure reason', async () => {
    // 6.3 reports `retries_exhausted`; 21.18 reports `loop_quality_unmet`. Two different
    // events, two different names, so an operator reading the Audit_Log can tell an
    // engine that would not answer from an engine that answered badly.
    const transport = createBgmHarness();
    transport.generation.adapter.failSubmit(saturated(), 10);
    const pendingTransport = transport.service.generate({
      accountId: 'user-1',
      request: bgmLoopRequest(),
    });
    await drainScheduler(transport.generation.scheduler);
    const transportOutcome = await pendingTransport;

    const quality = createBgmHarness();
    quality.candidates.setDefault({ kind: 'audio', audio: clickingLoop() });
    const qualityError = await quality.service
      .generate({ accountId: 'user-1', request: bgmLoopRequest() })
      .catch((thrown: unknown) => thrown);

    expect(transportOutcome.kind === 'failed' ? transportOutcome.failure.reason : '').toBe(
      'retries_exhausted',
    );
    if (!isGenerationError(qualityError)) throw new Error('expected a GenerationError');
    expect(qualityError.code).toBe('bgm_loop_quality_unmet');
  });

  it('exits without a quality attempt when the engine produced no audio at all', async () => {
    // The engine accepted the job and then returned nothing. Requirements 6.1–6.3 own
    // this case and have already settled it, so 21.18's counter must not advance.
    const harness = createBgmHarness();
    harness.candidates.script({ kind: 'unproduced', reason: 'decoder crashed' });

    const outcome = await harness.service.generate({
      accountId: 'user-1',
      request: bgmLoopRequest(),
    });

    expect(outcome).toMatchObject({ kind: 'failed' });
    expect(harness.candidates.calls).toHaveLength(1);
    expect(harness.generation.charges.requests).toHaveLength(1);
  });
});

describe('a quality miss does not spend a transport attempt (Requirement 6.2)', () => {
  it('leaves attemptsMade at zero on every rejected quality attempt', async () => {
    const harness = createBgmHarness();
    harness.candidates.setDefault({ kind: 'audio', audio: clickingLoop() });

    await harness.service
      .generate({ accountId: 'user-1', request: bgmLoopRequest() })
      .catch(() => undefined);

    const records = await Promise.all(
      harness.candidates.calls.map((call) => harness.generation.store.find(call.jobId)),
    );
    expect(records).toHaveLength(BGM_LOOP_QUALITY_MAX_ATTEMPTS);
    for (const record of records) {
      // The engine answered first time for each attempt; the fault was in the audio.
      expect(record?.attemptsMade).toBe(0);
    }
  });

  it('makes exactly one engine request per quality attempt when transport is healthy', async () => {
    const harness = createBgmHarness();
    harness.candidates.setDefault({ kind: 'audio', audio: clickingLoop() });

    await harness.service
      .generate({ accountId: 'user-1', request: bgmLoopRequest() })
      .catch(() => undefined);

    expect(harness.generation.adapter.submitCount).toBe(BGM_LOOP_QUALITY_MAX_ATTEMPTS);
  });
});

describe('the two budgets compose multiplicatively, and nothing is counted twice', () => {
  it('retries transport inside each quality attempt without shortening the ladder', async () => {
    // The worst case the composition permits: each quality attempt survives one 429 and
    // then produces audio. The quality ladder still gets its full three attempts, and the
    // engine sees two requests per attempt.
    const harness = createBgmHarness();
    harness.candidates.setDefault({ kind: 'audio', audio: clickingLoop() });
    harness.generation.adapter.failSubmit(saturated(), 1);

    const pending = harness.service
      .generate({ accountId: 'user-1', request: bgmLoopRequest() })
      .catch((thrown: unknown) => thrown);
    await drainScheduler(harness.generation.scheduler);
    const error = await pending;

    if (!isGenerationError(error)) throw new Error('expected the quality rejection');
    expect(error.code).toBe('bgm_loop_quality_unmet');
    expect((error.details as { attempts: number }).attempts).toBe(BGM_LOOP_QUALITY_MAX_ATTEMPTS);

    // One 429 consumed one 6.2 re-request; the remaining attempts submitted cleanly.
    expect(harness.generation.adapter.submitCount).toBe(BGM_LOOP_QUALITY_MAX_ATTEMPTS + 1);
    expect(harness.candidates.calls).toHaveLength(BGM_LOOP_QUALITY_MAX_ATTEMPTS);
  });

  it('caps the engine at 3 quality attempts times 4 requests', () => {
    // Stated as arithmetic over the two published constants rather than driven, because
    // the bound is what matters and it follows from the two budgets being independent.
    expect(BGM_LOOP_QUALITY_MAX_ATTEMPTS).toBe(3);
    expect(MAX_ENGINE_RETRY_ATTEMPTS).toBe(3);
    expect(BGM_LOOP_QUALITY_MAX_ATTEMPTS * (MAX_ENGINE_RETRY_ATTEMPTS + 1)).toBe(12);
  });

  it('refunds each failure exactly once, whichever budget ended it', async () => {
    // The important consequence of the split: a transport failure is refunded by
    // Requirement 6.3 and a quality miss by Requirement 21.18, and a single failure is
    // never refunded by both.
    const harness = createBgmHarness();
    harness.candidates.setDefault({ kind: 'audio', audio: clickingLoop() });
    harness.generation.adapter.failSubmit(saturated(), 1);

    const pending = harness.service
      .generate({ accountId: 'user-1', request: bgmLoopRequest() })
      .catch(() => undefined);
    await drainScheduler(harness.generation.scheduler);
    await pending;

    // Three jobs were charged; three were refunded. One refund each, no double credit.
    expect(harness.generation.charges.requests).toHaveLength(BGM_LOOP_QUALITY_MAX_ATTEMPTS);
    expect(harness.generation.refunds.requests).toHaveLength(BGM_LOOP_QUALITY_MAX_ATTEMPTS);
    const jobIds = harness.generation.refunds.requests.map((request) => request.jobId);
    expect(new Set(jobIds).size).toBe(jobIds.length);
  });
});
