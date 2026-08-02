/**
 * Sound-effect request validation (Requirements 22.2–22.5, 22.10–22.13, 22.17, 22.18).
 *
 * Pure and total, reporting *every* violated field rather than the first, for the reason
 * `domain/bgm/validation.ts` gives: 22.18 names two fields that can each be out of range
 * in one request, and a caller told about one at a time makes two round trips to learn
 * what it could have sent.
 *
 * The violation type is Requirement 3/4's `SongFieldViolation`, not a new one — 22.3 and
 * 22.18 ask for the violated constraint name, the input value and the permitted range,
 * which is exactly what a `range` or `length` allowance already carries. Requirement 22.3
 * additionally asks for the *character count and token count* of the prompt, which a
 * plain `length` allowance cannot hold, so the prompt violation is reported through
 * `SfxPromptViolation` alongside the field list and the error carries both.
 *
 * The ordering of the two tier-dependent checks is the only subtlety. The sampling step
 * count is validated against the tier's own window (22.10 vs 22.11), so the tier must be
 * resolved *before* the step count is judged — including when the tier itself was
 * defaulted by 22.17. An invalid tier therefore suppresses the step check rather than
 * judging it against a guess, because "30 steps is out of range" would be false advice
 * for a caller who meant `high_quality` and misspelled it.
 */

import {
  lengthViolation,
  rangeViolation,
  enumViolation,
  type SongFieldViolation,
} from '../song/violation';

import {
  SFX_DEFAULT_TARGET_LENGTH_SECONDS,
  SFX_DEFAULT_VARIANT_COUNT,
  SFX_GUIDANCE_SCALE_DEFAULT,
  SFX_GUIDANCE_SCALE_MAX,
  SFX_GUIDANCE_SCALE_MIN,
  SFX_PROMPT_MAX_TOKENS,
  SFX_PROMPT_MIN_LENGTH,
  SFX_SEED_MAX,
  SFX_SEED_MIN,
  SFX_TARGET_LENGTH_SECONDS_MAX,
  SFX_TARGET_LENGTH_SECONDS_MIN,
  SFX_VARIANT_COUNT_MAX,
  SFX_VARIANT_COUNT_MIN,
  isSfxGuidanceScale,
  isSfxSeed,
  isSfxTargetLengthSeconds,
  isSfxVariantCount,
} from './bounds';
import {
  SFX_MODEL_TIERS,
  isSamplingStepCountFor,
  isSfxModelTier,
  stepBoundsFor,
  type SfxModelTier,
} from './model-tier';
import type { SfxDefaultableField, SfxGenerationRequest, SfxParameters } from './request';
import { estimatingPromptTokenizer, type PromptTokenizer } from './tokenize';

/** Requirement 22.3's payload: which constraint, and both measured sizes. */
export interface SfxPromptViolation {
  /** `min_length` or `max_tokens` — the constraint name 22.3 asks to be named. */
  readonly constraint: 'min_length' | 'max_tokens';
  /** Requirement 22.3: 입력 문자 수, after trimming. */
  readonly characterCount: number;
  /** Requirement 22.3: 입력 토큰 수. */
  readonly tokenCount: number;
  readonly minLength: number;
  readonly maxTokens: number;
}

export type SfxValidation =
  | { readonly kind: 'valid'; readonly parameters: SfxParameters }
  | {
      readonly kind: 'invalid';
      readonly violations: readonly SongFieldViolation[];
      /** Present when the prompt itself was one of the violations (22.3). */
      readonly prompt: SfxPromptViolation | null;
    };

export interface SfxValidationOptions {
  /** Requirements 22.2, 22.3. Defaults to the local estimate; see `tokenize.ts`. */
  readonly tokenizer?: PromptTokenizer;
}

export function validateSfxRequest(
  request: SfxGenerationRequest,
  options: SfxValidationOptions = {},
): SfxValidation {
  const tokenizer = options.tokenizer ?? estimatingPromptTokenizer;
  const violations: SongFieldViolation[] = [];

  const prompt = validatePrompt(request.prompt, tokenizer);
  if (prompt !== null) {
    violations.push(
      lengthViolation('prompt', prompt.characterCount, SFX_PROMPT_MIN_LENGTH, SFX_PROMPT_MAX_TOKENS),
    );
  }

  // Requirements 22.4, 22.18. An omitted length is Requirement 22.17's default and is
  // not a violation; a present one out of range is.
  if (request.targetLengthSeconds !== undefined && !isSfxTargetLengthSeconds(request.targetLengthSeconds)) {
    violations.push(
      rangeViolation(
        'targetLengthSeconds',
        request.targetLengthSeconds,
        SFX_TARGET_LENGTH_SECONDS_MIN,
        SFX_TARGET_LENGTH_SECONDS_MAX,
        false,
      ),
    );
  }

  // Requirements 22.5, 22.16, 22.18.
  if (request.variantCount !== undefined && !isSfxVariantCount(request.variantCount)) {
    violations.push(
      rangeViolation(
        'variantCount',
        request.variantCount,
        SFX_VARIANT_COUNT_MIN,
        SFX_VARIANT_COUNT_MAX,
      ),
    );
  }

  // Requirement 22.9: an unrecognised tier is refused with the two that exist.
  const tierValid = request.modelTier === undefined || isSfxModelTier(request.modelTier);
  if (!tierValid) {
    violations.push(enumViolation('modelTier', request.modelTier, SFX_MODEL_TIERS));
  }

  // Requirements 22.10, 22.11 — judged against the resolved tier, and skipped entirely
  // when the tier is unusable. See the module comment.
  const tier: SfxModelTier = tierValid ? (request.modelTier ?? 'fast') : 'fast';
  if (tierValid && request.samplingSteps !== undefined && !isSamplingStepCountFor(tier, request.samplingSteps)) {
    const bounds = stepBoundsFor(tier);
    violations.push(rangeViolation('samplingSteps', request.samplingSteps, bounds.min, bounds.max));
  }

  // Requirement 22.12.
  if (request.guidanceScale !== undefined && !isSfxGuidanceScale(request.guidanceScale)) {
    violations.push(
      rangeViolation(
        'guidanceScale',
        request.guidanceScale,
        SFX_GUIDANCE_SCALE_MIN,
        SFX_GUIDANCE_SCALE_MAX,
        false,
      ),
    );
  }

  // Requirement 22.13 bounds the seed space; a caller-named seed must sit inside it,
  // or Requirement 22.8's promise would be made about a value the engine cannot use.
  if (request.seed !== undefined && !isSfxSeed(request.seed)) {
    violations.push(rangeViolation('seed', request.seed, SFX_SEED_MIN, SFX_SEED_MAX));
  }

  if (violations.length > 0) return { kind: 'invalid', violations, prompt };
  return { kind: 'valid', parameters: resolve(request, tier) };
}

/** Requirements 22.2, 22.3. `null` when the prompt is acceptable. */
function validatePrompt(prompt: unknown, tokenizer: PromptTokenizer): SfxPromptViolation | null {
  const text = typeof prompt === 'string' ? prompt.trim() : '';
  const characterCount = text.length;
  const tokenCount = tokenizer.countTokens(text);
  const shape = { characterCount, tokenCount, minLength: SFX_PROMPT_MIN_LENGTH, maxTokens: SFX_PROMPT_MAX_TOKENS };

  // 22.3 lists the two constraints in this order, and the shorter-than-minimum case is
  // reported first because a prompt of no characters has no meaningful token count to
  // have exceeded.
  if (characterCount < SFX_PROMPT_MIN_LENGTH) return { constraint: 'min_length', ...shape };
  if (tokenCount > SFX_PROMPT_MAX_TOKENS) return { constraint: 'max_tokens', ...shape };
  return null;
}

/**
 * Requirement 22.17's defaults, applied and recorded.
 *
 * The prompt is stored trimmed. 22.3 measures it "앞뒤 공백 제거 후", so the trimmed form
 * is the one the length constraint is about, and submitting the untrimmed text would
 * mean the engine saw a prompt that was never validated.
 *
 * The sampling-step default comes from the *resolved* tier, so a request that named
 * neither gets 8 steps on the fast tier (22.10) and one that named `high_quality`
 * without steps gets 30 (22.11). `samplingSteps` is listed among the applied defaults
 * whenever it was derived this way, because 22.17's "적용된 값을 응답에 포함" is about
 * telling the user what they are being charged for, and the step count is the field that
 * most changes what they get.
 */
function resolve(request: SfxGenerationRequest, tier: SfxModelTier): SfxParameters {
  const appliedDefaults: SfxDefaultableField[] = [];
  if (request.targetLengthSeconds === undefined) appliedDefaults.push('targetLengthSeconds');
  if (request.variantCount === undefined) appliedDefaults.push('variantCount');
  if (request.modelTier === undefined) appliedDefaults.push('modelTier');
  if (request.samplingSteps === undefined) appliedDefaults.push('samplingSteps');
  if (request.guidanceScale === undefined) appliedDefaults.push('guidanceScale');

  return {
    prompt: request.prompt.trim(),
    targetLengthSeconds: request.targetLengthSeconds ?? SFX_DEFAULT_TARGET_LENGTH_SECONDS,
    variantCount: request.variantCount ?? SFX_DEFAULT_VARIANT_COUNT,
    modelTier: tier,
    samplingSteps: request.samplingSteps ?? stepBoundsFor(tier).fallback,
    guidanceScale: request.guidanceScale ?? SFX_GUIDANCE_SCALE_DEFAULT,
    loop: request.loop ?? false,
    ...(request.seed === undefined ? {} : { seed: request.seed }),
    appliedDefaults,
  };
}
