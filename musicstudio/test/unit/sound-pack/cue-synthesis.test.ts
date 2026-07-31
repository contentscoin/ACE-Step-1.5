import { describe, expect, it } from 'vitest';

import { maxShortTermLoudnessLufs } from '../../../domain/audio/loudness';
import { INITIAL_QUALITY_THRESHOLD_SET } from '../../../domain/quality/threshold-set';
import { loopSeamThresholds } from '../../../domain/quality/loop-seam-thresholds';
import { oneShotTailThresholds } from '../../../domain/quality/one-shot-tail-thresholds';
import { evaluateTailDecay } from '../../../domain/sfx/tail-decay';
import {
  CUE_SEAM_WINDOW_MS,
  PACK_CUE_PAIR_COUNT,
  PACK_LOUDNESS_HOP_MS,
  PACK_LOUDNESS_WINDOW_MS,
} from '../../../domain/sound-pack/bounds';
import { evaluateCueLoopSeam } from '../../../domain/sound-pack/loop-seam';
import { evaluateCueSimilarity } from '../../../domain/sound-pack/similarity';
import { SEMANTIC_CUES, isLoopCue } from '../../../domain/sound-pack/taxonomy';
import { judgeCueLength } from '../../../domain/sound-pack/validation';
import {
  measureLoopSync,
  measureTailDecaySync,
} from '../../../services/sound/in-process-measurement';
import {
  CUE_TARGET_LUFS,
  SEAM_STEP_TARGET,
  distinctCueFor,
  distinctOneShot,
  distinctSeamlessLoop,
  normalisedToPackLoudness,
  seamStepRatio,
} from '../../support/cue-synthesis';
import { cueDescriptor } from '../../support/cue-mfcc-descriptor';
import { TEST_PACK_BASE_SEED } from '../../support/sound-pack-harness';
import { scaled } from '../../support/pcm-synthesis';

/**
 * The fixture, checked against the clauses it claims to satisfy.
 *
 * Every assertion in `sound-pack-service.test.ts` is only evidence about the service for as long
 * as the synthesised cues really are compliant audio. This file is what makes that true rather
 * than assumed — and it is also where the *fixture's* own regressions surface, separately from
 * the product's.
 */

const seamThresholds = loopSeamThresholds(INITIAL_QUALITY_THRESHOLD_SET);
const tailThresholds = oneShotTailThresholds(INITIAL_QUALITY_THRESHOLD_SET);

/** The pack the harness produces for round 0 — the one every service test uses. */
function harnessPack(round = 0): readonly { cueName: string; audio: ReturnType<typeof distinctOneShot> }[] {
  const ROUND_STRIDE = 7_919;
  return SEMANTIC_CUES.map((cue, index) => ({
    cueName: cue.name,
    audio: distinctCueFor(
      cue.name,
      TEST_PACK_BASE_SEED + index + round * ROUND_STRIDE,
      isLoopCue(cue.name),
    ),
  }));
}

describe('a synthesised one-shot satisfies 24.4, 24.7 and 24.8', () => {
  it('is inside 24.4\'s length range', () => {
    const audio = distinctOneShot(7, { durationMs: 150 });
    expect(judgeCueLength('hover', (audio.channels[0]?.length ?? 0) / 48).satisfied).toBe(true);
  });

  it('lands at exactly the target loudness, inside 24.7\'s band', () => {
    const audio = distinctOneShot(7, { durationMs: 150 });
    const measured = maxShortTermLoudnessLufs(audio, PACK_LOUDNESS_WINDOW_MS, PACK_LOUDNESS_HOP_MS);

    expect(measured).toBeCloseTo(CUE_TARGET_LUFS, 6);
    expect(measured).toBeGreaterThanOrEqual(-25);
    expect(measured).toBeLessThanOrEqual(-21);
  });

  it('has decayed by its last 50 ms, satisfying 24.8', () => {
    const audio = distinctOneShot(7, { durationMs: 150 });
    const verdict = evaluateTailDecay(
      measureTailDecaySync({ subject: { kind: 'pcm', audio } }),
      tailThresholds,
    );

    expect(verdict.satisfied).toBe(true);
    // Margin rather than a hair's breadth, so an unrelated change does not become a mystery.
    expect(verdict.worstTailRatio).toBeLessThan(0.04);
  });

  it('places every cue in the pack at the target, whatever its kind', () => {
    for (const cue of harnessPack()) {
      const measured = maxShortTermLoudnessLufs(
        cue.audio,
        PACK_LOUDNESS_WINDOW_MS,
        PACK_LOUDNESS_HOP_MS,
      );
      expect(measured).toBeCloseTo(CUE_TARGET_LUFS, 6);
    }
  });
});

describe('a synthesised loop satisfies 24.5 and both halves of 24.6', () => {
  it('holds identical samples in its first and last 10 ms, so the RMS difference is 0 dB', () => {
    const audio = distinctSeamlessLoop(4_242, { durationMs: 600 });
    const channel = measureLoopSync({
      subject: { kind: 'pcm', audio },
      bpm: 0,
      timeSignature: 0,
      seamWindowMs: CUE_SEAM_WINDOW_MS,
    }).channels[0];

    expect(channel?.headSeamRms).toBeCloseTo(channel?.tailSeamRms ?? -1, 12);
  });

  it('keeps the sample step inside Requirement 24.6\'s ceiling for every loop in every round', () => {
    // The redraw in `distinctSeamlessLoop` is what makes this true for *every* seed rather than
    // most; before it, three of the six loops in one round exceeded the ceiling outright.
    //
    // The assertion is against the **requirement's** ceiling, which is the threshold-set member,
    // not against the redraw's own 2 % target: the redraw returns its best attempt when none
    // reaches the target, and one round-4 loop does land at 3.2 %. Comfortably compliant, and
    // asserting the target here would make a fixture's ambition into a rule.
    const ceiling = seamThresholds.seamSampleStepRatioMax;
    expect(SEAM_STEP_TARGET).toBeLessThan(ceiling);

    for (let round = 0; round <= 4; round += 1) {
      for (const cue of harnessPack(round)) {
        if (!isLoopCue(cue.cueName)) continue;
        expect(
          seamStepRatio(cue.audio.channels[0] ?? new Float32Array(0)),
          `${cue.cueName} round ${String(round)}`,
        ).toBeLessThanOrEqual(ceiling);
      }
    }
  });

  it('satisfies Requirement 24.6\'s verdict for every loop in the harness pack', () => {
    for (const cue of harnessPack()) {
      if (!isLoopCue(cue.cueName)) continue;
      const verdict = evaluateCueLoopSeam(
        measureLoopSync({
          subject: { kind: 'pcm', audio: cue.audio },
          bpm: 0,
          timeSignature: 0,
          seamWindowMs: CUE_SEAM_WINDOW_MS,
        }),
        seamThresholds,
      );
      expect(verdict.satisfied, cue.cueName).toBe(true);
    }
  });

  it('is inside 24.5\'s length range', () => {
    const audio = distinctSeamlessLoop(4_242, { durationMs: 600 });
    expect(judgeCueLength('loading', (audio.channels[0]?.length ?? 0) / 48).satisfied).toBe(true);
  });
});

describe('the pack is pairwise dissimilar under 24.9', () => {
  it('keeps all 3003 pairs below the ceiling', () => {
    const vectors = harnessPack().map((cue) => ({
      cueName: cue.cueName,
      coefficients: cueDescriptor(cue.audio),
    }));

    const verdict = evaluateCueSimilarity(vectors, 0.95);

    expect(verdict.pairCount).toBe(PACK_CUE_PAIR_COUNT);
    expect(verdict.satisfied).toBe(true);
    // Margin, so a change to the descriptor or the synthesiser shows up as a shrinking margin
    // rather than as a sudden failure.
    expect(verdict.maxSimilarity).toBeLessThan(0.95);
  });

  it('keeps the round used for a manual regeneration clean too', () => {
    // Requirement 24.17's regeneration replaces one cue with its round-4 audio, so that mix has to
    // be clean or the regeneration test would be asserting about the fixture.
    const base = harnessPack();
    const round4 = harnessPack(4);
    for (const target of ['loading', 'hover', 'select']) {
      const vectors = base.map((cue) => ({
        cueName: cue.cueName,
        coefficients: cueDescriptor(
          cue.cueName === target
            ? (round4.find((entry) => entry.cueName === target)?.audio ?? cue.audio)
            : cue.audio,
        ),
      }));
      expect(evaluateCueSimilarity(vectors, 0.95).satisfied, target).toBe(true);
    }
  });
});

describe('the descriptor behaves like an MFCC where the pack logic depends on it', () => {
  it('is unchanged by a uniform gain, because c0 is dropped', () => {
    const audio = distinctOneShot(11, { durationMs: 150 });
    const louder = {
      sampleRate: audio.sampleRate,
      channels: audio.channels.map((channel) => scaled(channel, 4)),
    };

    const before = cueDescriptor(audio);
    const after = cueDescriptor(louder);

    for (const [index, value] of before.entries()) {
      // Requirement 24.9 normalises to −23 LUFS before measuring; dropping c0 is what makes that
      // a no-op for the coefficients it keeps, and this is the assertion that pins it.
      //
      // An absolute difference rather than `toBe`, for the reason
      // `domain/sound-pack/equivalence.ts` gives: the two values are computed by different
      // orderings of the same sum, so exact equality is the wrong claim.
      expect(Math.abs(value - (after[index] as number))).toBeLessThan(1e-9);
    }
  });

  it('has 13 dimensions', () => {
    expect(cueDescriptor(distinctOneShot(3, { durationMs: 150 }))).toHaveLength(13);
  });

  it('separates two different spectral envelopes and identifies one with itself', () => {
    const first = cueDescriptor(distinctOneShot(1, { durationMs: 150 }));
    const second = cueDescriptor(distinctOneShot(2, { durationMs: 150 }));

    expect(
      evaluateCueSimilarity(
        [
          { cueName: 'a', coefficients: first },
          { cueName: 'b', coefficients: second },
        ],
        0.95,
      ).satisfied,
    ).toBe(true);
    expect(
      evaluateCueSimilarity(
        [
          { cueName: 'a', coefficients: first },
          { cueName: 'b', coefficients: first },
        ],
        0.95,
      ).satisfied,
    ).toBe(false);
  });
});

describe('the loudness normaliser', () => {
  it('is a closed-form single scale, exact for any starting level', () => {
    const audio = distinctOneShot(5, { durationMs: 150 });
    for (const gain of [0.01, 0.5, 3]) {
      const shifted = {
        sampleRate: audio.sampleRate,
        channels: audio.channels.map((channel) => scaled(channel, gain)),
      };
      const placed = normalisedToPackLoudness(shifted, -24);
      expect(
        maxShortTermLoudnessLufs(placed, PACK_LOUDNESS_WINDOW_MS, PACK_LOUDNESS_HOP_MS),
      ).toBeCloseTo(-24, 5);
    }
  });

  it('leaves silence alone rather than dividing by zero', () => {
    const silence = { sampleRate: 48_000, channels: [new Float32Array(4_800)] };
    expect(normalisedToPackLoudness(silence)).toBe(silence);
  });
});
