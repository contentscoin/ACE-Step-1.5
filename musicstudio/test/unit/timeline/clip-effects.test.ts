import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { toChain } from '../../../domain/effects/chain';
import {
  EFFECT_KINDS,
  EFFECT_REGISTRY,
  EFFECT_TAIL_ALLOWANCE_MS,
} from '../../../domain/effects/registry';
import {
  CLIP_EFFECT_STAGES,
  CLIP_EFFECT_STAGE_INDEX,
  CLIP_TRUNCATE_STAGE_INDEX,
  clipChainMayExtendTail,
  clipEffectConsistency,
  clipEffectDisposition,
  clipMixdownLengthMs,
  clipsWithEffectChains,
  clipsWithTailExtendingChains,
  requiresEffectProcessor,
  tailCeilingMs,
  tailTruncationWitness,
} from '../../../domain/timeline/clip-effects';
import { timelineClipsEquivalent } from '../../../domain/timeline/equivalence';
import { clipViolations } from '../../../domain/timeline/project';
import { QUALITY_THRESHOLD_NAMES } from '../../../domain/quality/threshold-name';
import { clip, effectChain } from '../../support/timeline-harness';

/**
 * Clip effects and the tail policy (Requirements 29.31, 29.32; design §6.3).
 *
 * Example-based. Task 4.3 owns **no numbered Property** — `tasks.md` §9.2's ownership table has
 * no 4.3 row, and design §10 numbers Properties 1–24 with none left over — so nothing here is
 * numbered, and the reproducibility evidence its acceptance criterion asks for lives in
 * `dsp/test/test_mixdown.py`'s existing Property 13, extended with an `effect_processor` case
 * rather than duplicated under a new number.
 */

describe('the two tail ceilings (Requirements 29.31, 29.32; design §6.3)', () => {
  it('cuts a clip at its play length inside a mixdown', () => {
    // Design §6.3: "딜레이/리버브 포함 이펙트 → 테일 발생 → 클립 재생 길이에서 잘라냄".
    expect(tailCeilingMs('mixdown', 4_000)).toBe(4_000);
  });

  it('preserves the tail up to +10 000 ms for an independent Generation_Version', () => {
    // Design §6.3: "이펙트 테일은 독립 Generation_Version 저장 시에만 보존 (최대 +10000ms)".
    expect(tailCeilingMs('generation_version', 4_000)).toBe(4_000 + EFFECT_TAIL_ALLOWANCE_MS);
  });

  it('takes the allowance from the effect registry rather than restating 10 000', () => {
    // One declaration. `domain/effects/registry.ts` is where Requirement 29.32's number lives,
    // and `dsp/src/musicstudio_dsp/effect_registry.json` mirrors it with a parity test.
    expect(EFFECT_TAIL_ALLOWANCE_MS).toBe(10_000);
    expect(tailCeilingMs('generation_version', 0) - tailCeilingMs('mixdown', 0)).toBe(
      EFFECT_TAIL_ALLOWANCE_MS,
    );
  });

  it('classifies the allowance as a bound, not a Quality_Threshold_Set member', () => {
    // The repository's test: would changing it change what an already-recorded measurement
    // *means*? It would — every stored Generation_Version's admissible length was bounded by it —
    // so it is a bound, and Requirement 34's exhaustive threshold list must not have grown.
    //
    // Named candidates rather than a substring search: `one_shot_tail_amplitude_ratio_max` is a
    // genuine threshold (task 3.4, Requirement 24's one-shot tails) and has nothing to do with
    // Requirement 29.32's allowance, so matching on "tail" would fail on somebody else's work.
    const names: readonly string[] = QUALITY_THRESHOLD_NAMES;
    for (const candidate of [
      'effect_tail_allowance_ms',
      'clip_effect_tail_allowance_ms',
      'mixdown_clip_effect_tail_ms',
    ]) {
      expect(names).not.toContain(candidate);
    }
  });

  it('reports a mixdown clip length that is exactly the play length, chain or not', () => {
    const dry = clip({ sourceDurationMs: 5_000, trimStartMs: 500, trimEndMs: 500 });
    const wet = { ...dry, effectChain: effectChain(['reverb']) };
    expect(clipMixdownLengthMs(dry)).toBe(4_000);
    // Requirement 29.31: the chain does not change what the clip occupies on the timeline.
    expect(clipMixdownLengthMs(wet)).toBe(clipMixdownLengthMs(dry));
  });
});

describe('which chains can produce a tail (Requirements 29.30, 29.32)', () => {
  it('says yes for delay and reverb and no for the other six', () => {
    for (const kind of EFFECT_KINDS) {
      const subject = clip({ effectChain: effectChain([kind]) });
      expect(clipChainMayExtendTail(subject)).toBe(EFFECT_REGISTRY[kind].extendsTail);
    }
    // The clause names exactly two, so the registry had better agree.
    expect(EFFECT_KINDS.filter((kind) => EFFECT_REGISTRY[kind].extendsTail).sort()).toEqual([
      'delay',
      'reverb',
    ]);
  });

  it('says no for a clip with no chain', () => {
    expect(clipChainMayExtendTail(clip())).toBe(false);
  });

  it('says yes for a mixed chain that contains one tail-extending effect', () => {
    const subject = clip({ effectChain: effectChain(['gain', 'delay', 'lowpass']) });
    expect(clipChainMayExtendTail(subject)).toBe(true);
  });
});

describe('a clip\'s disposition in each destination', () => {
  const wet = clip({ sourceDurationMs: 3_000, effectChain: effectChain(['reverb']) });

  it('discards the tail in a mixdown', () => {
    const disposition = clipEffectDisposition(wet, 'mixdown');
    expect(disposition).toMatchObject({
      chainApplied: true,
      mayExtendTail: true,
      tailPreserved: false,
      ceilingMs: 3_000,
    });
  });

  it('keeps the tail for an independent version', () => {
    const disposition = clipEffectDisposition(wet, 'generation_version');
    expect(disposition).toMatchObject({
      chainApplied: true,
      mayExtendTail: true,
      tailPreserved: true,
      ceilingMs: 3_000 + EFFECT_TAIL_ALLOWANCE_MS,
    });
  });

  it('never preserves a tail a chain could not have produced', () => {
    // A chain with no delay or reverb has no tail to preserve, in either destination —
    // Requirement 29.30 keeps its length within 10 ms instead.
    const dryChain = clip({ effectChain: effectChain(['compressor', 'gain']) });
    for (const destination of ['mixdown', 'generation_version'] as const) {
      expect(clipEffectDisposition(dryChain, destination).tailPreserved).toBe(false);
    }
  });

  it('reports no chain applied for a clip without one', () => {
    // Requirement 29.31's WHERE does not hold, so nothing is applied — and the ceiling is still
    // the play length, because the truncation of design §5.6 step 4 runs regardless.
    expect(clipEffectDisposition(clip({ sourceDurationMs: 2_000 }), 'mixdown')).toMatchObject({
      chainApplied: false,
      mayExtendTail: false,
      tailPreserved: false,
      ceilingMs: 2_000,
    });
  });
});

describe('the stage order Requirement 29.31 states', () => {
  it('applies the chain to trimmed audio and cuts before the gain and the fades', () => {
    // "트림이 적용된 클립 오디오에 지정된 Effect_Chain을 적용하고 그 결과를 해당 클립의 재생
    // 길이로 잘라낸 뒤 클립 게인과 페이드를 적용한 오디오를 합산한다".
    expect(CLIP_EFFECT_STAGES.indexOf('trim')).toBeLessThan(CLIP_EFFECT_STAGE_INDEX);
    expect(CLIP_EFFECT_STAGE_INDEX).toBeLessThan(CLIP_TRUNCATE_STAGE_INDEX);
    expect(CLIP_TRUNCATE_STAGE_INDEX).toBeLessThan(CLIP_EFFECT_STAGES.indexOf('gain'));
    expect(CLIP_EFFECT_STAGES.indexOf('gain')).toBeLessThan(CLIP_EFFECT_STAGES.indexOf('fade'));
    expect(CLIP_EFFECT_STAGES.indexOf('fade')).toBeLessThan(CLIP_EFFECT_STAGES.indexOf('place'));
  });

  it('is the order dsp/src/musicstudio_dsp/mixdown.py actually implements', () => {
    // Parity against the Python source read as text — the same technique
    // `test/unit/timeline/mixdown.test.ts` uses for the numeric constants, and for the same
    // reason: no process is started, and the two sides cannot drift silently.
    const source = readFileSync(
      fileURLToPath(
        new URL('../../../dsp/src/musicstudio_dsp/mixdown.py', import.meta.url),
      ),
      'utf8',
    );
    const stageComments = [
      '# 2. Trim',
      '# 3. Clip effects',
      '# 4. Truncate',
      '# 5. Gain',
      '# 6. Fades',
      '# 7. Place',
    ];
    const positions = stageComments.map((needle) => source.indexOf(needle));
    for (const [index, position] of positions.entries()) {
      expect(position, `${stageComments[index] ?? ''} is missing from mixdown.py`).toBeGreaterThan(
        -1,
      );
    }
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
  });
});

describe('a project\'s clip-effect summary', () => {
  const clips = [
    clip({ id: 'a', track: 0, effectChain: effectChain(['reverb']) }),
    clip({ id: 'b', track: 1 }),
    clip({ id: 'c', track: 2, effectChain: effectChain(['gain']) }),
  ];

  it('names the clips that carry a chain, in the order given', () => {
    expect(clipsWithEffectChains(clips)).toEqual(['a', 'c']);
  });

  it('names only the ones whose chains can ring on', () => {
    expect(clipsWithTailExtendingChains(clips)).toEqual(['a']);
  });

  it('knows whether a processor is needed at all', () => {
    expect(requiresEffectProcessor(clips)).toBe(true);
    expect(requiresEffectProcessor([clip({ id: 'b' })])).toBe(false);
  });

  it('reports the worst case a mix would overshoot by if no tail were cut', () => {
    const witness = tailTruncationWitness(clips);
    expect(witness.clipIds).toEqual(['a']);
    expect(witness.worstCaseOvershootMs).toBe(EFFECT_TAIL_ALLOWANCE_MS);
    // Nothing to cut, nothing to overshoot by.
    expect(tailTruncationWitness([clip({ id: 'b' })]).worstCaseOvershootMs).toBe(0);
  });
});

describe('mixdown clip-effect consistency (Requirement 29.31)', () => {
  const clips = [
    clip({ id: 'a', track: 0, effectChain: effectChain(['reverb']) }),
    clip({ id: 'b', track: 1 }),
    clip({ id: 'c', track: 2, effectChain: effectChain(['gain']) }),
  ];

  it('accepts a renderer that applied exactly the chains it was sent', () => {
    expect(clipEffectConsistency(clips, ['a', 'c'])).toBeNull();
  });

  it('accepts them in either order, since membership is what is being checked', () => {
    expect(clipEffectConsistency(clips, ['c', 'a'])).toBeNull();
  });

  it('catches a dropped chain and names the clip', () => {
    const breach = clipEffectConsistency(clips, ['c']);
    expect(breach).toMatchObject({ code: 'clip_effects_not_applied', clipIds: ['a'] });
  });

  it('catches a chain applied to a clip that carries none', () => {
    const breach = clipEffectConsistency(clips, ['a', 'b', 'c']);
    expect(breach).toMatchObject({
      code: 'clip_effects_applied_unexpectedly',
      clipIds: ['b'],
    });
  });

  it('reports both sets, so the failure says what was expected and what happened', () => {
    const breach = clipEffectConsistency(clips, []);
    expect(breach?.expected).toEqual(['a', 'c']);
    expect(breach?.actual).toEqual([]);
  });

  it('accepts an empty answer for a project with no chains at all', () => {
    expect(clipEffectConsistency([clip({ id: 'b' })], [])).toBeNull();
  });
});

describe('a clip\'s chain is part of the clip (Requirements 28.32, 29.31)', () => {
  /**
   * These are the tests that make Property 6 mean something.
   *
   * Property 6 is quantified over valid projects and compares them with the project equivalence
   * relation; if the relation ignored `effectChain`, the property would pass for a printer that
   * dropped every chain. So the relation's treatment of the field is pinned here directly, in
   * both directions.
   */
  it('refuses to call two clips equivalent when only the chain differs', () => {
    const dry = clip({ id: 'a' });
    const wet = { ...dry, effectChain: effectChain(['reverb']) };
    expect(timelineClipsEquivalent(dry, wet, 0).equivalent).toBe(false);
    expect(timelineClipsEquivalent(wet, dry, 0).equivalent).toBe(false);
  });

  it('refuses when the chains differ in kind, in order or in a parameter', () => {
    const base = clip({ id: 'a', effectChain: effectChain(['reverb', 'gain']) });
    const differentKind = { ...base, effectChain: effectChain(['reverb', 'compressor']) };
    const differentOrder = { ...base, effectChain: effectChain(['gain', 'reverb']) };
    const differentParameter = {
      ...base,
      effectChain: toChain([
        ...effectChain(['reverb']).items,
        { kind: 'gain', parameters: { gain_db: 3 } },
      ]),
    };

    for (const other of [differentKind, differentOrder, differentParameter]) {
      expect(timelineClipsEquivalent(base, other, 0).equivalent).toBe(false);
    }
  });

  it('compares by value, not by reference, so a re-parsed chain still matches', () => {
    // The failure this guards against is the opposite one: a relation that used `!==` on the
    // object would call *every* parsed clip different from the clip it was printed from, and
    // Property 6 would fail for every project containing a chain.
    const left = clip({ id: 'a', effectChain: effectChain(['reverb']) });
    const right = clip({ id: 'a', effectChain: effectChain(['reverb']) });
    expect(left.effectChain).not.toBe(right.effectChain);
    expect(timelineClipsEquivalent(left, right, 0).equivalent).toBe(true);
  });

  it('names the field and the reason when the chains differ', () => {
    const verdict = timelineClipsEquivalent(
      clip({ id: 'a' }),
      clip({ id: 'a', effectChain: effectChain(['reverb']) }),
      3,
    );
    expect(verdict.equivalent).toBe(false);
    if (!verdict.equivalent) {
      expect(verdict.reason).toContain('effectChain');
      expect(verdict.reason).toContain('clip 3');
    }
  });
});

describe('a clip validates its chain by delegating to Requirement 29\'s rules', () => {
  it('accepts a clip whose chain is valid', () => {
    expect(clipViolations(clip({ effectChain: effectChain(['reverb', 'gain']) }))).toEqual([]);
  });

  it('accepts a clip with no chain', () => {
    expect(clipViolations(clip({ effectChain: null }))).toEqual([]);
  });

  it('rejects an out-of-range parameter without restating the range itself', () => {
    // Requirement 29.6 caps `gain_db` at 40. The clip layer does not know that; `chainViolations`
    // does, which is the point.
    const broken = {
      ...clip(),
      effectChain: { items: [{ kind: 'gain' as const, parameters: { gain_db: 400 } }] },
    };
    expect(clipViolations(broken).map((violation) => violation.violation)).toContain(
      'clip_effect_chain_invalid',
    );
  });

  it('rejects an unregistered effect kind', () => {
    const broken = {
      ...clip(),
      effectChain: {
        items: [{ kind: 'telephone' as unknown as 'gain', parameters: { gain_db: 0 } }],
      },
    };
    expect(clipViolations(broken).map((violation) => violation.violation)).toContain(
      'clip_effect_chain_invalid',
    );
  });

  it('rejects an empty chain, so there is one representation of "no chain"', () => {
    // Requirement 29.13's floor is 1. An empty array accepted as "no chain" would give
    // Requirement 28.33's reprint two possible outputs for one state.
    const broken = { ...clip(), effectChain: { items: [] } };
    expect(clipViolations(broken).map((violation) => violation.violation)).toContain(
      'clip_effect_chain_invalid',
    );
  });

  it('rejects `undefined`, which is not the same as `null`', () => {
    const broken = { ...clip(), effectChain: undefined as unknown as null };
    const violations = clipViolations(broken);
    expect(violations.map((violation) => violation.violation)).toContain(
      'clip_effect_chain_invalid',
    );
    expect(violations.find((v) => v.violation === 'clip_effect_chain_invalid')?.actual).toBe(
      'undefined',
    );
  });
});
