/**
 * Lyrics_Assistant (Requirements 8.1–8.6).
 *
 * Two operations, both synchronous request/response:
 *
 * - `enrich` — Requirement 8.1's formatting call, returned as a *proposal* holding
 *   both sides (8.2).
 * - `draft` — Requirement 8.3's topic-words-only draft, structurally checked against
 *   Requirement 8.4 before it is handed back.
 *
 * **Requirement 8.6 is satisfied structurally.** The assistant has no credit
 * dependency at all: no `CreditService`, no debit port, nothing it could charge
 * through even by mistake. Enrichment creates no Generation_Job, so it never reaches
 * the Requirement 2.2 charging path either. That is a stronger guarantee than a test
 * asserting a balance is unchanged, and `test/unit/lyrics/credit-invariance.test.ts`
 * pins it with a stand-in balance that throws on any debit.
 *
 * **Requirement 8.5 is satisfied by construction.** The original input is copied into
 * the outcome *before* the engine is called, and the engine's answer is never written
 * back over it — an enriched value only ever appears on the `enriched` side of a
 * proposal. So there is no code path on which a failure could leave a partially
 * overwritten input.
 */

import { missingDraftSections } from '../../domain/lyrics/draft-structure';
import type { LyricsDocument } from '../../domain/lyrics/document';
import { parseLyrics } from '../../domain/lyrics/lyrics-parser';
import { printLyrics } from '../../domain/lyrics/lyrics-printer';
import type { RecognisedLyricsSection } from '../../domain/lyrics/section-type';
import type { ParseWarning } from '../../domain/parse-error';

import type { FormattedLyricsSample, LyricsFormatPort } from './format-port';

/** One complete set of generation inputs — either what the user wrote, or the engine's. */
export interface LyricsCandidate {
  readonly caption: string;
  readonly lyrics: string;
  readonly bpm: number | null;
  readonly keyScale: string | null;
  readonly timeSignature: number | null;
  readonly durationSeconds: number | null;
  readonly vocalLanguage: string | null;
}

export interface LyricsEnrichmentRequest {
  readonly caption: string;
  readonly lyrics: string;
  readonly bpm?: number;
  readonly keyScale?: string;
  readonly timeSignature?: number;
  readonly durationSeconds?: number;
  readonly vocalLanguage?: string;
}

/**
 * Requirement 8.2's side-by-side presentation.
 *
 * There is deliberately **no** `selected` or `recommended` field. "사용자가 어느 쪽을
 * 생성에 사용할지 선택하도록 요구한다" is a statement that the system must not decide, so
 * the type offers nothing to read as a decision; `selectLyricsCandidate` is the only
 * way to obtain a single candidate, and it has no default argument.
 */
export interface LyricsEnrichmentProposal {
  readonly original: LyricsCandidate;
  readonly enriched: LyricsCandidate;
  /** The enriched lyrics parsed into sections, so a client can render the structure. */
  readonly enrichedStructure: LyricsDocument;
  /** Requirement 9.4 warnings raised while parsing the enriched lyrics. */
  readonly warnings: readonly ParseWarning[];
}

export const LYRICS_CANDIDATE_CHOICES = ['original', 'enriched'] as const;

export type LyricsCandidateChoice = (typeof LYRICS_CANDIDATE_CHOICES)[number];

/** Requirement 8.2: the caller must name a side; nothing is implied. */
export function selectLyricsCandidate(
  proposal: LyricsEnrichmentProposal,
  choice: LyricsCandidateChoice,
): LyricsCandidate {
  return choice === 'original' ? proposal.original : proposal.enriched;
}

export type LyricsAssistantFailureCode =
  /** Requirement 8.5: the engine refused or was unreachable. */
  | 'lyrics_enrichment_engine_failed'
  /** Requirement 8.4: the draft came back without a Verse or without a Chorus. */
  | 'lyrics_draft_structure_incomplete';

export interface LyricsAssistantFailure {
  readonly kind: 'failed';
  readonly code: LyricsAssistantFailureCode;
  readonly reason: string;
  /** Requirement 8.5: the caller's input, unchanged. */
  readonly original: LyricsCandidate;
}

export type LyricsEnrichmentOutcome =
  | { readonly kind: 'proposed'; readonly proposal: LyricsEnrichmentProposal }
  | LyricsAssistantFailure;

export interface LyricsDraftRequest {
  /** Requirement 8.3: the topic words, and nothing else. */
  readonly topic: string;
  readonly bpm?: number;
  readonly keyScale?: string;
  readonly timeSignature?: number;
  readonly durationSeconds?: number;
  readonly vocalLanguage?: string;
}

export interface LyricsDraft {
  readonly caption: string;
  /** Tagged plain text, reprinted from the parsed structure so the tags are canonical. */
  readonly lyrics: string;
  readonly structure: LyricsDocument;
  readonly bpm: number | null;
  readonly keyScale: string | null;
  readonly timeSignature: number | null;
  readonly durationSeconds: number | null;
  readonly vocalLanguage: string | null;
  readonly warnings: readonly ParseWarning[];
}

export type LyricsDraftOutcome =
  | { readonly kind: 'drafted'; readonly draft: LyricsDraft }
  | (LyricsAssistantFailure & { readonly missingSections?: readonly RecognisedLyricsSection[] });

export interface LyricsAssistant {
  enrich(request: LyricsEnrichmentRequest): Promise<LyricsEnrichmentOutcome>;
  draft(request: LyricsDraftRequest): Promise<LyricsDraftOutcome>;
}

export interface LyricsAssistantOptions {
  readonly formatPort: LyricsFormatPort;
  /** Passed through to the engine when set; otherwise the engine's own default holds. */
  readonly temperature?: number;
}

export function createLyricsAssistant(options: LyricsAssistantOptions): LyricsAssistant {
  const { formatPort } = options;
  const temperature =
    options.temperature === undefined ? {} : { temperature: options.temperature };

  return {
    async enrich(request) {
      // Requirement 8.5: captured before the call, so a failure cannot have touched it.
      const original = candidateFromRequest(request);

      let sample: FormattedLyricsSample;
      try {
        sample = await formatPort.format({
          caption: request.caption,
          lyrics: request.lyrics,
          ...musicalOnly(request),
          ...temperature,
        });
      } catch (error) {
        return engineFailure(original, error);
      }

      const enriched = mergeOverOriginal(original, sample);
      const parsed = parseLyrics(enriched.lyrics);

      return {
        kind: 'proposed',
        proposal: {
          original,
          enriched,
          enrichedStructure: parsed.document,
          warnings: parsed.warnings,
        },
      };
    },

    async draft(request) {
      // Requirement 8.3: topic words become the caption, and there are no draft
      // lyrics — an empty lyrics field is how the engine is asked to write them.
      const original = candidateFromRequest({
        caption: request.topic,
        lyrics: '',
        ...musicalOnly(request),
      });

      let sample: FormattedLyricsSample;
      try {
        sample = await formatPort.format({
          caption: request.topic,
          lyrics: '',
          ...musicalOnly(request),
          ...temperature,
        });
      } catch (error) {
        return engineFailure(original, error);
      }

      const lyricsText = sample.lyrics ?? '';
      const parsed = parseLyrics(lyricsText);
      const missing = missingDraftSections(parsed.document);

      // Requirement 8.4, enforced as a postcondition on what is *returned*: a draft
      // that reaches the caller always has at least one Verse and one Chorus.
      //
      // The alternative — synthesising the missing sections — would mean inventing
      // lyric content or relabelling the engine's, and a Chorus the user never asked
      // for is worse than being told the draft did not come back usable. The caller
      // can ask again; the engine is stochastic.
      if (missing.length > 0) {
        return {
          kind: 'failed',
          code: 'lyrics_draft_structure_incomplete',
          reason: `The drafted lyrics are missing a ${missing.join(' and a ')} section.`,
          original,
          missingSections: missing,
        };
      }

      return {
        kind: 'drafted',
        draft: {
          caption: sample.caption ?? request.topic,
          // Reprinted from the parsed structure so the returned draft carries
          // canonical tags — the same text the Lyrics_Printer would produce, which is
          // what makes it safe to hand straight to Custom_Mode generation.
          lyrics: printLyrics(parsed.document),
          structure: parsed.document,
          bpm: sample.bpm,
          keyScale: sample.keyScale,
          timeSignature: sample.timeSignature,
          durationSeconds: sample.durationSeconds,
          vocalLanguage: sample.vocalLanguage,
          warnings: parsed.warnings,
        },
      };
    },
  };
}

/**
 * The user's input as a complete candidate.
 *
 * An absent musical field becomes `null` — the *absence* is recorded, not filled in,
 * so Requirement 8.5's "변경 없이 유지" holds literally: no value the user did not
 * supply appears on this side.
 */
function candidateFromRequest(request: LyricsEnrichmentRequest): LyricsCandidate {
  return {
    caption: request.caption,
    lyrics: request.lyrics,
    bpm: request.bpm ?? null,
    keyScale: request.keyScale ?? null,
    timeSignature: request.timeSignature ?? null,
    durationSeconds: request.durationSeconds ?? null,
    vocalLanguage: request.vocalLanguage ?? null,
  };
}

/**
 * The enriched side, with the user's value kept wherever the engine reported nothing.
 *
 * Requirement 8.2 asks the user to compare two *complete* alternatives; a side with
 * holes in it is not comparable. Falling back to the original for a `null` field
 * mirrors what the engine's own route does (`format_result.caption or prompt`).
 */
function mergeOverOriginal(
  original: LyricsCandidate,
  sample: FormattedLyricsSample,
): LyricsCandidate {
  return {
    caption: sample.caption ?? original.caption,
    lyrics: sample.lyrics ?? original.lyrics,
    bpm: sample.bpm ?? original.bpm,
    keyScale: sample.keyScale ?? original.keyScale,
    timeSignature: sample.timeSignature ?? original.timeSignature,
    durationSeconds: sample.durationSeconds ?? original.durationSeconds,
    vocalLanguage: sample.vocalLanguage ?? original.vocalLanguage,
  };
}

/**
 * Only the fields the caller supplied travel onward.
 *
 * Same rule as Requirements 3.3 and 4.7: an omitted field must reach the engine
 * absent, because that absence is the instruction to invent a value. Under
 * `exactOptionalPropertyTypes` an absent property and one set to `undefined` are
 * different types, which is why each field is spread conditionally rather than
 * copied.
 */
function musicalOnly(
  request: Omit<LyricsEnrichmentRequest, 'caption' | 'lyrics'>,
): Partial<LyricsEnrichmentRequest> {
  return {
    ...(request.bpm === undefined ? {} : { bpm: request.bpm }),
    ...(request.keyScale === undefined ? {} : { keyScale: request.keyScale }),
    ...(request.timeSignature === undefined ? {} : { timeSignature: request.timeSignature }),
    ...(request.durationSeconds === undefined ? {} : { durationSeconds: request.durationSeconds }),
    ...(request.vocalLanguage === undefined ? {} : { vocalLanguage: request.vocalLanguage }),
  };
}

/**
 * Requirement 8.5's outcome.
 *
 * The reason is read off the thrown value structurally rather than by narrowing to
 * `AceEngineError`, which would make this service know which engine it is talking to.
 */
function engineFailure(original: LyricsCandidate, error: unknown): LyricsAssistantFailure {
  return {
    kind: 'failed',
    code: 'lyrics_enrichment_engine_failed',
    reason: error instanceof Error ? error.message : String(error),
    original,
  };
}
