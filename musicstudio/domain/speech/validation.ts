/**
 * Dialogue request validation (Requirements 25.4–25.10, 25.22).
 *
 * Pure and total, reporting *every* violated field rather than the first, for the reason
 * `domain/sfx/validation.ts` gives: 25.22 names five constraints that can each be out of range
 * in one request, and a caller told about one at a time makes five round trips to learn what it
 * could have sent. The violation type is Requirement 3/4's `SongFieldViolation`, because 25.22
 * asks for the violated constraint name and the permitted range, which is exactly what a
 * `range` or `length` allowance carries.
 *
 * ### What this module does *not* decide
 *
 * - **The language check (25.3)** needs the engine catalogue, so it lives in
 *   `services/speech/speech-service.ts` where the catalogue is available. Only the *shape* of
 *   the code is checked here; a well-formed code no engine speaks is 25.3's refusal, not
 *   25.22's.
 * - **The acting instruction and the tags (25.7, 25.8, 25.9)** are engine capabilities. The
 *   *length* of the instruction is 25.22's business and is checked here; whether the engine can
 *   use it is not.
 * - **The line bounds (25.14)** are `lines.ts`, because they are about the stored form rather
 *   than the request, and 25.22 does not enumerate them.
 *
 * ### The script is measured trimmed
 *
 * 25.4 bounds "스크립트 전체 길이" without saying whether surrounding whitespace counts. It is
 * measured after trimming, the same reading Requirement 22.3 states explicitly for a prompt, so
 * that a script of nothing but spaces is refused rather than accepted and then found to have no
 * lines at all under 25.14. The *stored* script keeps its interior whitespace verbatim; only
 * the leading and trailing runs are dropped, so line offsets inside it are unaffected.
 */

import {
  lengthViolation,
  rangeViolation,
  type SongFieldViolation,
} from '../song/violation';
import { SFX_SEED_MAX, SFX_SEED_MIN, isSfxSeed } from '../sfx/bounds';

import {
  ACTING_INSTRUCTION_MAX_LENGTH,
  PITCH_SEMITONES_DEFAULT,
  PITCH_SEMITONES_MAX,
  PITCH_SEMITONES_MIN,
  SCRIPT_MAX_LENGTH,
  SCRIPT_MIN_LENGTH,
  SPEAKING_RATE_DEFAULT,
  SPEAKING_RATE_MAX,
  SPEAKING_RATE_MIN,
  SPLIT_THRESHOLD_DEFAULT,
  SPLIT_THRESHOLD_MAX,
  SPLIT_THRESHOLD_MIN,
  isPitchSemitones,
  isSpeakingRate,
  isSplitThresholdChars,
} from './bounds';
import { isLanguageCode, normaliseLanguageCode } from './language';
import { resolveParalinguisticTags } from './paralinguistic';
import type {
  DialogueGenerationRequest,
  SpeechDefaultableField,
  SpeechParameters,
} from './request';

/** Requirement 25.22's 위반된 제약 이름, as a closed list. */
export const SPEECH_REQUEST_CONSTRAINTS = [
  'script',
  'speakingRate',
  'pitchSemitones',
  'actingInstruction',
  'splitThresholdChars',
  'languageCode',
  'seed',
] as const;

export type SpeechRequestConstraint = (typeof SPEECH_REQUEST_CONSTRAINTS)[number];

export const SPEECH_REQUEST_CONSTRAINT_REQUIREMENT: Readonly<
  Record<SpeechRequestConstraint, string>
> = {
  script: '25.4',
  speakingRate: '25.5',
  pitchSemitones: '25.6',
  actingInstruction: '25.7',
  splitThresholdChars: '25.10',
  languageCode: '25.3',
  seed: '25.18',
};

export type SpeechValidation =
  | { readonly kind: 'valid'; readonly parameters: SpeechParameters }
  | {
      readonly kind: 'invalid';
      readonly violations: readonly SongFieldViolation[];
      readonly constraints: readonly SpeechRequestConstraint[];
    };

export interface SpeechValidationOptions {
  /** Requirement 25.7: whether the chosen engine accepts a natural-language direction. */
  readonly supportsActingInstruction?: boolean;
  /** Requirements 25.8, 25.9: whether the chosen engine understands 준언어 태그. */
  readonly supportsParalinguisticTags?: boolean;
}

export function validateDialogueRequest(
  request: DialogueGenerationRequest,
  options: SpeechValidationOptions = {},
): SpeechValidation {
  const violations: SongFieldViolation[] = [];
  const constraints: SpeechRequestConstraint[] = [];

  const script = typeof request.script === 'string' ? request.script.trim() : '';
  if (script.length < SCRIPT_MIN_LENGTH || script.length > SCRIPT_MAX_LENGTH) {
    violations.push(lengthViolation('script', script.length, SCRIPT_MIN_LENGTH, SCRIPT_MAX_LENGTH));
    constraints.push('script');
  }

  // Requirement 25.5. An omitted rate is the default and is not a violation.
  if (request.speakingRate !== undefined && !isSpeakingRate(request.speakingRate)) {
    violations.push(
      rangeViolation(
        'speakingRate',
        request.speakingRate,
        SPEAKING_RATE_MIN,
        SPEAKING_RATE_MAX,
        false,
      ),
    );
    constraints.push('speakingRate');
  }

  // Requirement 25.6. Semitones are integers: a criterion stated in 반음 with integer bounds
  // has no fractional member, and forwarding 3.5 semitones would ask two engines to round it
  // in two directions.
  if (request.pitchSemitones !== undefined && !isPitchSemitones(request.pitchSemitones)) {
    violations.push(
      rangeViolation(
        'pitchSemitones',
        request.pitchSemitones,
        PITCH_SEMITONES_MIN,
        PITCH_SEMITONES_MAX,
        false,
      ),
    );
    constraints.push('pitchSemitones');
  }

  // Requirement 25.7's 200자 ceiling. Length only; capability is the service's business.
  const instruction = request.actingInstruction?.trim() ?? '';
  if (instruction.length > ACTING_INSTRUCTION_MAX_LENGTH) {
    violations.push(
      lengthViolation('actingInstruction', instruction.length, 0, ACTING_INSTRUCTION_MAX_LENGTH),
    );
    constraints.push('actingInstruction');
  }

  // Requirement 25.10.
  if (
    request.splitThresholdChars !== undefined &&
    !isSplitThresholdChars(request.splitThresholdChars)
  ) {
    violations.push(
      rangeViolation(
        'splitThresholdChars',
        request.splitThresholdChars,
        SPLIT_THRESHOLD_MIN,
        SPLIT_THRESHOLD_MAX,
      ),
    );
    constraints.push('splitThresholdChars');
  }

  // Requirement 25.3 / 27.3's shape. A malformed code is refused here so 25.3's
  // "engines supporting this language" answer is never computed for something that is not a
  // language code at all.
  if (!isLanguageCode(normaliseLanguageCode(String(request.languageCode ?? '')))) {
    violations.push(lengthViolation('languageCode', request.languageCode, 2, 2));
    constraints.push('languageCode');
  }

  // Requirement 25.18 bounds the seed space through the shared seed model of
  // `domain/sfx/seed.ts`; a caller-named seed must sit inside it, or the reproducibility
  // promise would be made about a value no engine can use.
  if (request.seed !== undefined && !isSfxSeed(request.seed)) {
    violations.push(rangeViolation('seed', request.seed, SFX_SEED_MIN, SFX_SEED_MAX));
    constraints.push('seed');
  }

  if (violations.length > 0) return { kind: 'invalid', violations, constraints };
  return { kind: 'valid', parameters: resolve(request, script, instruction, options) };
}

/**
 * Requirements 25.5, 25.6, 25.9, 25.10's defaults and removals, applied and recorded.
 *
 * The acting instruction becomes `null` when the engine cannot use it (25.7 is a `WHERE`), so
 * a downstream adapter never has to decide whether to forward it — the decision is taken once,
 * here, and what the adapter receives is what the engine gets.
 */
function resolve(
  request: DialogueGenerationRequest,
  script: string,
  instruction: string,
  options: SpeechValidationOptions,
): SpeechParameters {
  const appliedDefaults: SpeechDefaultableField[] = [];
  if (request.speakingRate === undefined) appliedDefaults.push('speakingRate');
  if (request.pitchSemitones === undefined) appliedDefaults.push('pitchSemitones');
  if (request.splitThresholdChars === undefined) appliedDefaults.push('splitThresholdChars');

  // Requirements 25.8, 25.9.
  const tags = resolveParalinguisticTags(script, options.supportsParalinguisticTags === true);

  return {
    script: tags.script,
    originalScript: script,
    voiceProfileId: request.voiceProfileId,
    languageCode: normaliseLanguageCode(request.languageCode),
    speakingRate: request.speakingRate ?? SPEAKING_RATE_DEFAULT,
    pitchSemitones: request.pitchSemitones ?? PITCH_SEMITONES_DEFAULT,
    actingInstruction:
      options.supportsActingInstruction === true && instruction.length > 0 ? instruction : null,
    splitThresholdChars: request.splitThresholdChars ?? SPLIT_THRESHOLD_DEFAULT,
    removedTags: tags.removedTags,
    ...(request.seed === undefined ? {} : { seed: request.seed }),
    appliedDefaults,
  };
}
