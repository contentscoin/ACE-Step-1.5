/**
 * Generation_Gateway for songs (Requirements 3, 4).
 *
 * Every acceptance criterion in Requirements 3 and 4 begins "THE
 * Generation_Gateway SHALL", and this is that gateway: it validates the musical
 * request, refuses it with the offending field and its allowance, and otherwise
 * hands a submission to the Job_Orchestrator. It does not poll, charge, refund or
 * talk to an engine — Requirement 5's lifecycle already owns all four.
 *
 * The one judgement call is documented on
 * `UNSPECIFIED_LENGTH_RESERVATION_SECONDS` below.
 */

import type { AssetKind } from '../../domain/asset-kind';
import type { SongGenerationRequest, SongParameters } from '../../domain/song/request';
import { validateSongRequest } from '../../domain/song/validation';
import type { ModerationDecision } from '../moderation/decision';

import type { JobOrchestrator, SubmitJobInput, SubmitOutcome } from './job-orchestrator';
import { songRequestInvalid } from './song-errors';

/**
 * Length reserved for routing and pricing when the caller lets the engine choose.
 *
 * Requirement 3.3 keeps the length off the engine payload, but Requirement 2.2
 * prices by length and Requirement 20.6 routes by it, so one number is still
 * needed. Neither requirements.md nor `acestep/constants.py` fixes it — the engine
 * simply lets its language model decide — so this is a product policy value, not an
 * engine bound, and it is stated here as a single overridable default rather than
 * hidden in a pricing call. 240 s is the full-song length the engine's own
 * preprocessing treats as its working ceiling (`max_duration` in
 * `acestep/training_v2/configs.py`).
 *
 * Open question for the spec: whether an engine-decided length should be reserved,
 * charged at the reservation and trued up afterwards, or charged only once the
 * engine reports the real length.
 */
export const UNSPECIFIED_LENGTH_RESERVATION_SECONDS = 240;

export interface SongGatewayOptions {
  readonly orchestrator: JobOrchestrator;
  /** `song` for Requirements 3 and 4; task 2.4 reuses the gateway with `bgm`. */
  readonly assetKind?: AssetKind;
  readonly reservedLengthSeconds?: number;
}

export interface SongSubmissionInput {
  readonly accountId: string;
  readonly request: SongGenerationRequest;
  /** Engine named by the caller (Requirement 20.3). */
  readonly engineId?: string;
  /** Content policy verdict, evaluated lazily by the orchestrator (design §9.1). */
  readonly moderate?: () => ModerationDecision;
}

export class SongGateway {
  private readonly orchestrator: JobOrchestrator;
  private readonly assetKind: AssetKind;
  private readonly reservedLengthSeconds: number;

  constructor(options: SongGatewayOptions) {
    this.orchestrator = options.orchestrator;
    this.assetKind = options.assetKind ?? 'song';
    this.reservedLengthSeconds =
      options.reservedLengthSeconds ?? UNSPECIFIED_LENGTH_RESERVATION_SECONDS;
  }

  /**
   * Requirements 3.5, 3.8 and 4.6 reject; everything else is accepted and submitted.
   *
   * Validation happens before the orchestrator is touched, so a malformed request
   * never reaches routing, moderation or the credit debit.
   */
  async submit(input: SongSubmissionInput): Promise<SubmitOutcome> {
    const validation = validateSongRequest(input.request);
    if (validation.kind === 'invalid') {
      throw songRequestInvalid(validation.violations);
    }
    return this.orchestrator.submit(this.submissionOf(input, validation.parameters));
  }

  private submissionOf(input: SongSubmissionInput, song: SongParameters): SubmitJobInput {
    const lengthSeconds = song.durationSeconds ?? this.reservedLengthSeconds;

    return {
      accountId: input.accountId,
      assetKind: this.assetKind,
      inputModality: 'text',
      durationMs: Math.round(lengthSeconds * 1000),
      // Requirement 4.8: the batch count is how many Audio_Assets Requirement 5.6
      // will create, and therefore what Requirement 2.2 charges for.
      resultCount: song.batchSize,
      song,
      // The text the Moderation_Service inspects is whichever the user actually
      // wrote; `song` keeps both, and the prompt is the one already threaded
      // through the lifecycle.
      ...promptOf(song),
      ...(song.seed === undefined ? {} : { seed: song.seed }),
      ...(input.engineId === undefined ? {} : { engineId: input.engineId }),
      ...(input.moderate === undefined ? {} : { moderate: input.moderate }),
    };
  }
}

function promptOf(song: SongParameters): { readonly prompt?: string } {
  const text = song.mode === 'simple' ? song.description : song.caption;
  return text === undefined ? {} : { prompt: text };
}
