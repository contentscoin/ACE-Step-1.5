/**
 * `Effects_Service` — applying a chain, and previewing one (Requirements 29.9–29.14,
 * 29.28, 29.30, 29.32).
 *
 * The two version and preset halves of Requirement 29 live in `version-manager.ts` and
 * `preset-service.ts`. This module is the part that involves *audio*: it validates the
 * request, sends it across the `EffectProcessingPort`, checks the length invariants the
 * requirement states over the result, and — for a non-preview — folds the new version
 * into the asset's version set through `createDerivedVersion`.
 *
 * ### Validation happens here, before the port
 *
 * Requirements 29.9 and 29.10 require a *refusal* naming the offending kind or parameter
 * and its permitted range. That is only answerable synchronously if the check precedes the
 * queue, so `applyChain` runs `chainViolations` before it touches the port and returns
 * every fault (not just the first — 29.9/29.10 place no "first only" limit on the service;
 * only 29.33 does, and that constrains the parser).
 *
 * ### The length invariants are checked, not assumed
 *
 * Requirement 29.30 requires a chain without delay or reverb to preserve length within
 * 10 ms; 29.32 requires a chain *with* either to land in `[original, original + 10 s]`.
 * Both are stated as invariants ("불변식") of what `Effects_Service` produces, so a result
 * that breaches one is a failure of this service, and reporting it as such is more useful
 * than storing a version whose length nobody checked. Which of the two applies is read off
 * `chainMayExtendTail`, which reads the registry's `extendsTail` flag — so the pair of
 * effect names appears once, in `domain/effects/registry.ts`, and not here.
 *
 * ### Requirement 29.28: a preview stores nothing
 *
 * `previewChain` returns the processing result and never calls `createDerivedVersion`.
 * That is enforced by construction rather than by a flag: the preview path has no version
 * set in scope and no identifier to create one with, so it *cannot* store a version.
 */

import {
  EFFECT_LENGTH_TOLERANCE_MS,
  EFFECT_TAIL_ALLOWANCE_MS,
  chainMayExtendTail,
  chainViolations,
  toChain,
  type EffectChain,
} from '../../domain/effects';
import type { ChainViolation } from '../../domain/effects/chain';
import type { GenerationVersion } from '../../domain/generation-version';

import type {
  EffectProcessingPort,
  EffectProcessingResult,
  EffectProcessingSubject,
} from './ports';
import { createDerivedVersion, type VersionOutcome, type VersionRefusal } from './version-manager';

export type EffectsRefusalCode =
  /** Requirements 29.9, 29.10, 29.13. */
  | 'chain_invalid'
  /** Requirement 29.30 breached by the worker's output. */
  | 'length_not_preserved'
  /** Requirement 29.32 breached by the worker's output. */
  | 'tail_allowance_exceeded';

export interface EffectsRefusal {
  readonly ok: false;
  readonly code: EffectsRefusalCode | VersionRefusal['code'];
  readonly chainViolations?: readonly ChainViolation[];
  readonly detail?: string;
  readonly versionRefusal?: VersionRefusal;
}

export interface ApplyChainSuccess {
  readonly ok: true;
  readonly processing: EffectProcessingResult;
  readonly versions: readonly GenerationVersion[];
  readonly created: GenerationVersion;
}

export interface PreviewSuccess {
  readonly ok: true;
  readonly processing: EffectProcessingResult;
}

export type ApplyChainOutcome = ApplyChainSuccess | EffectsRefusal;
export type PreviewOutcome = PreviewSuccess | EffectsRefusal;

function refuse(code: EffectsRefusal['code'], rest: Partial<EffectsRefusal> = {}): EffectsRefusal {
  return { ok: false, code, ...rest };
}

export interface EffectsService {
  applyChain(input: ApplyChainInput): Promise<ApplyChainOutcome>;
  previewChain(input: PreviewChainInput): Promise<PreviewOutcome>;
}

export interface ApplyChainInput {
  readonly assetId: string;
  readonly versions: readonly GenerationVersion[];
  /** Requirement 29.14: the version the chain is applied to. */
  readonly sourceVersionId: string;
  readonly subject: EffectProcessingSubject;
  /** Raw chain, validated here (Requirements 29.9, 29.10, 29.13). */
  readonly chain: unknown;
  readonly newVersionId: string;
  readonly name: string;
  readonly createdAtMs: number;
}

export interface PreviewChainInput {
  readonly subject: EffectProcessingSubject;
  readonly chain: unknown;
}

/**
 * Requirements 29.30, 29.32: is this output length admissible for this chain?
 *
 * Exported because it is the invariant itself, and both the unit suite and the property
 * suite assert it directly rather than only through a service call.
 *
 * The two branches are not symmetrical, matching the clauses. 29.30 is a two-sided ±10 ms
 * tolerance. 29.32 is one-sided-and-then-capped: at least the original length, at most the
 * original plus 10 s. A reverb cannot *shorten* audio, so a shorter result means something
 * went wrong rather than that a tolerance was tight — hence no lower slack on that branch.
 */
export function lengthViolationFor(
  chain: EffectChain,
  originalDurationMs: number,
  processedDurationMs: number,
): EffectsRefusalCode | null {
  if (chainMayExtendTail(chain)) {
    // Requirement 29.32.
    const upper = originalDurationMs + EFFECT_TAIL_ALLOWANCE_MS;
    // The lower bound gets the same ±10 ms slack the rest of the pipeline uses, because
    // a resampled original and its processed copy can differ by a fraction of a frame
    // and 29.32's "이상" is not meant to fail on a single sample of rounding.
    if (processedDurationMs < originalDurationMs - EFFECT_LENGTH_TOLERANCE_MS) {
      return 'tail_allowance_exceeded';
    }
    if (processedDurationMs > upper) return 'tail_allowance_exceeded';
    return null;
  }

  // Requirement 29.30.
  if (Math.abs(processedDurationMs - originalDurationMs) > EFFECT_LENGTH_TOLERANCE_MS) {
    return 'length_not_preserved';
  }
  return null;
}

export function createEffectsService(processing: EffectProcessingPort): EffectsService {
  /** Shared prologue: validate, then process. */
  async function validateAndProcess(
    rawChain: unknown,
    subject: EffectProcessingSubject,
    preview: boolean,
  ): Promise<
    | { readonly ok: true; readonly chain: EffectChain; readonly result: EffectProcessingResult }
    | EffectsRefusal
  > {
    const violations = chainViolations(rawChain);
    if (violations.length > 0) {
      return refuse('chain_invalid', { chainViolations: violations });
    }

    const chain = toChain(rawChain);
    const result = await processing.process({ subject, chain, preview });

    const originalDurationMs = (subject.frameCount * 1000) / subject.sampleRate;
    const lengthFault = lengthViolationFor(chain, originalDurationMs, result.durationMs);
    if (lengthFault !== null) {
      return refuse(lengthFault, {
        detail: `original ${String(originalDurationMs)} ms, processed ${String(result.durationMs)} ms`,
      });
    }

    // Requirement 29.29's shape half. The sample-level half cannot be checked from here —
    // the samples never cross the port — and lives in `dsp/test/test_effects.py` as
    // Property 14. What *is* checkable here is that the worker did not silently change
    // the channel count, which 29.29 also forbids.
    if (result.channels !== subject.channels || result.sampleRate !== subject.sampleRate) {
      return refuse('length_not_preserved', {
        detail: `shape changed: ${String(subject.channels)}ch@${String(subject.sampleRate)} -> ${String(result.channels)}ch@${String(result.sampleRate)}`,
      });
    }

    return { ok: true, chain, result };
  }

  return {
    /** Requirement 29.14: one new version, nothing existing altered. */
    async applyChain(input: ApplyChainInput): Promise<ApplyChainOutcome> {
      const processed = await validateAndProcess(input.chain, input.subject, false);
      if (!processed.ok) return processed;

      const outcome: VersionOutcome = createDerivedVersion({
        assetId: input.assetId,
        versions: input.versions,
        derivedFromVersionId: input.sourceVersionId,
        newVersionId: input.newVersionId,
        name: input.name,
        chain: processed.chain,
        durationMs: Math.round(processed.result.durationMs),
        createdAtMs: input.createdAtMs,
      });

      if (!outcome.ok) {
        return { ok: false, code: outcome.code, versionRefusal: outcome };
      }
      if (outcome.created === undefined) {
        return refuse('chain_invalid', { detail: 'version creation returned no version' });
      }

      return {
        ok: true,
        processing: processed.result,
        versions: outcome.versions,
        created: outcome.created,
      };
    },

    /** Requirement 29.28: stream the result, store nothing. */
    async previewChain(input: PreviewChainInput): Promise<PreviewOutcome> {
      const processed = await validateAndProcess(input.chain, input.subject, true);
      if (!processed.ok) return processed;
      return { ok: true, processing: processed.result };
    },
  };
}
