import { describe, expect, it } from 'vitest';

import { ENGINE_JOB_STATE } from '../../adapters/engine-job';
import { assetKindForEditKind } from '../../domain/edit/edit-kind';
import { createInProcessAudioMeasurement } from '../../services/sound/in-process-measurement';
import { createJobQualityRejection } from '../../services/sound/job-quality-rejection';
import { BgmService } from '../../services/sound/bgm-service';
import { generateBgmIntensityVariants } from '../../services/sound/bgm-variants';
import { VALID_SOURCE_AUDIO } from '../support/edit-harness';
import { createGenerationHarness } from '../support/generation-harness';
import {
  bgmLoopRequest,
  bgmRequest,
  createScriptedCandidatePort,
  DEFAULT_BGM_BPM,
  DEFAULT_BGM_TIME_SIGNATURE,
} from '../support/bgm-harness';
import { compliantLoop, monoAudio, scaled, withClickAt } from '../support/pcm-synthesis';

/**
 * Background music end to end, and its two points of reuse.
 *
 * **Validates: Requirements 21.1, 21.6, 21.14, 21.15, 21.18**
 *
 * The point of this file is the *seams*, not the rules — those are covered under
 * `test/unit/bgm/`. Three things are asserted that only a composed run can show:
 *
 * 1. A `bgm` generation travels through the **same** `SongGateway` and `Job_Orchestrator`
 *    as Requirements 3 and 4, with `assetKind: 'bgm'` and nothing else changed.
 * 2. Requirement 21.14's stem separation is **task 2.2's** `extract` path, unchanged: a
 *    `bgm` asset is an ordinary edit source, and extract already yields `stem`.
 * 3. A rejected loop leaves the job lifecycle and the credit ledger consistent, because
 *    Requirement 21.18 reuses the `engine_failed` transition rather than adding one.
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

/** A harness routing both `bgm` and `stem`, with the BGM service composed over it. */
function createComposedHarness() {
  const generation = createGenerationHarness({ assetKind: 'bgm', withEditGateway: true });
  const candidates = createScriptedCandidatePort();
  const service = new BgmService({
    orchestrator: generation.orchestrator,
    candidates,
    measurement: createInProcessAudioMeasurement(),
    rejection: createJobQualityRejection(generation.runtime),
  });

  return { generation, candidates, service };
}

describe('Requirement 21.1 — a bgm Generation_Job through the shared lifecycle', () => {
  it('creates a job whose Asset_Kind is bgm and completes it', async () => {
    const { generation, service } = createComposedHarness();

    const outcome = await service.generate({ accountId: 'user-1', request: bgmRequest() });
    if (outcome.kind !== 'produced') throw new Error('expected audio');

    const record = await generation.store.find(outcome.jobId);
    expect(record?.input.assetKind).toBe('bgm');
    expect(record?.input.inputModality).toBe('text');
    // Requirement 5.1's acceptance happened through the ordinary orchestrator: routed,
    // moderated, charged, submitted.
    expect(generation.charges.requests[0]).toMatchObject({
      assetKind: 'bgm',
      jobId: outcome.jobId,
    });
    expect(generation.adapter.submitCount).toBe(1);
  });

  it('prices by the requested length, so a 5-second loop is charged as one', async () => {
    const { generation, service } = createComposedHarness();

    await service.generate({
      accountId: 'user-1',
      request: bgmRequest({ targetLengthSeconds: 5 }),
    });

    expect(generation.charges.requests[0]?.durationMs).toBe(5_000);
  });
});

describe('Requirement 21.14 — stem separation reuses task 2.2 extract', () => {
  it('maps extract to the stem Asset_Kind without any bgm-specific code', () => {
    // The whole of 21.14's mapping, already stated by design §3.6 in task 2.2's domain.
    expect(assetKindForEditKind('extract')).toBe('stem');
  });

  it('extracts stems from a produced bgm asset and stores them as stem', async () => {
    const { generation, service } = createComposedHarness();

    const produced = await service.generate({
      accountId: 'user-1',
      request: bgmLoopRequest(),
    });
    if (produced.kind !== 'produced') throw new Error('expected audio');

    // The produced `bgm` asset is an ordinary edit source. Registering it here stands in
    // for task 5.1's Library_Service, which is the port the gateway declares.
    generation.sourceAudio.set({ ...VALID_SOURCE_AUDIO, assetId: produced.assetId });

    const editGateway = generation.editGateway;
    if (editGateway === null) throw new Error('expected the edit gateway');
    const { outcome } = await editGateway.submit({
      accountId: 'user-1',
      request: {
        kind: 'extract',
        sourceAssetId: produced.assetId,
        trackName: 'drums',
        model: 'acestep-v15-base',
      },
    });

    if (outcome.kind !== 'accepted') throw new Error('expected the extract to be accepted');
    const record = await generation.store.find(outcome.acceptance.jobId);
    expect(record?.input.assetKind).toBe('stem');
    expect(record?.input.inputAssetIds).toEqual([produced.assetId]);
  });

  it('records the bgm asset as the lineage parent of its stems (Requirement 7.12)', async () => {
    const { generation, service } = createComposedHarness();

    const produced = await service.generate({ accountId: 'user-1', request: bgmRequest() });
    if (produced.kind !== 'produced') throw new Error('expected audio');
    generation.sourceAudio.set({ ...VALID_SOURCE_AUDIO, assetId: produced.assetId });

    const editGateway = generation.editGateway;
    if (editGateway === null) throw new Error('expected the edit gateway');
    const { outcome } = await editGateway.submit({
      accountId: 'user-1',
      request: {
        kind: 'extract',
        sourceAssetId: produced.assetId,
        trackName: 'vocals',
        model: 'acestep-v15-base',
      },
    });
    if (outcome.kind !== 'accepted') throw new Error('expected acceptance');

    // Completing the extract publishes its results, which is where the lineage is written.
    generation.adapter.setDefaultPoll({ state: ENGINE_JOB_STATE.succeeded });
    const poll = await generation.orchestrator.pollOnce(outcome.acceptance.jobId);
    expect(poll.kind).toBe('applied');

    const record = await generation.store.find(outcome.acceptance.jobId);
    expect(record?.lifecycle.state).toBe('succeeded');
    expect(generation.lineage.edges).toEqual(
      (record?.assetIds ?? []).map((childAssetId) => ({
        childAssetId,
        parentAssetId: produced.assetId,
        derivationType: 'extract',
      })),
    );
    expect(generation.lineage.edges.length).toBeGreaterThan(0);
  });
});

describe('Requirement 21.18 — a rejected loop leaves the system consistent', () => {
  it('ends every rejected attempt as a failed job with its credits returned', async () => {
    const { generation, candidates, service } = createComposedHarness();
    candidates.setDefault({ kind: 'audio', audio: clickingLoop() });

    await service
      .generate({ accountId: 'user-1', request: bgmLoopRequest() })
      .catch(() => undefined);

    const records = await Promise.all(
      candidates.calls.map((call) => generation.store.find(call.jobId)),
    );

    expect(records).toHaveLength(3);
    for (const record of records) {
      if (record === undefined) throw new Error('expected a job record');
      // The `engine_failed` transition the lifecycle already defines — no new state and
      // no second refund path.
      expect(record.lifecycle.state).toBe('failed');
      expect(record.lifecycle.failure?.reason).toBe('loop_quality_unmet');
      expect(record.assetIds).toEqual([]);
    }

    // One refund per job, through the same CreditRefundPort as Requirements 5.7 and 6.3.
    expect(generation.refunds.requests.map((request) => request.jobId).sort()).toEqual(
      records.map((record) => record?.jobId ?? '').sort(),
    );
  });

  it('writes an Audit_Log entry naming the criteria that failed (Requirement 6.3)', async () => {
    const { generation, candidates, service } = createComposedHarness();
    candidates.setDefault({ kind: 'audio', audio: clickingLoop() });

    await service
      .generate({ accountId: 'user-1', request: bgmLoopRequest() })
      .catch(() => undefined);

    const firstJob = candidates.calls[0]?.jobId ?? '';
    const drafts = generation.auditFor(firstJob);
    expect(drafts.length).toBeGreaterThan(0);
  });

  it('publishes no asset for a rejected loop', async () => {
    // The gate sits before completion on purpose: a loop that fails its seam criteria
    // must not be published and then withdrawn.
    const { generation, candidates, service } = createComposedHarness();
    candidates.setDefault({ kind: 'audio', audio: clickingLoop() });

    await service
      .generate({ accountId: 'user-1', request: bgmLoopRequest() })
      .catch(() => undefined);

    expect(generation.assets.published).toEqual([]);
  });
});

describe('Requirements 21.9–21.11 — a variant set over the shared lifecycle', () => {
  it('creates one Generation_Job per variant, all with Asset_Kind bgm', async () => {
    const { generation, candidates, service } = createComposedHarness();
    const channel = goodLoop().channels[0];
    if (channel === undefined) throw new Error('no channel');
    candidates.script(
      { kind: 'audio', audio: monoAudio(channel) },
      { kind: 'audio', audio: monoAudio(scaled(channel, 10 ** (3 / 20))) },
      { kind: 'audio', audio: monoAudio(scaled(channel, 10 ** (6 / 20))) },
    );

    const outcome = await generateBgmIntensityVariants(service, {
      accountId: 'user-1',
      request: { ...bgmRequest(), variantCount: 3, intensityGapLufs: 3 },
    });
    if (outcome.kind !== 'produced') throw new Error('expected a variant set');

    const records = await Promise.all(
      outcome.variants.map((variant) => generation.store.find(variant.jobId)),
    );
    expect(records).toHaveLength(3);
    for (const record of records) {
      expect(record?.input.assetKind).toBe('bgm');
    }
    // Requirement 2.2 charges each variant as its own generation.
    expect(generation.charges.requests).toHaveLength(3);
  });
});
