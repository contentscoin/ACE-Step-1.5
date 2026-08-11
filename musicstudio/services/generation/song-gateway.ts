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
import type { ModerationField } from '../../domain/moderation/fields';
import type { SongGenerationRequest, SongParameters } from '../../domain/song/request';
import {
  SONG_DURATION_BOUNDS,
  validateSongRequest,
  type SongDurationBounds,
} from '../../domain/song/validation';
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

/**
 * Requirements 15.5, 15.6 — the persona surface, narrowed to one call.
 *
 * The gateway asks for an adapter and gets one or a rejection; it does not fetch a persona
 * and read its fields. 15.6's ownership check and 15.5's readiness check are a single
 * decision that `services/persona` owns, and a gateway re-deriving it from a record would
 * be a second place for "may this account use this persona" to be answered — which is the
 * kind of duplication that eventually answers differently.
 *
 * Structurally satisfied by `createPersonaService(...)`, without this module importing it.
 */
export interface PersonaAdapterResolver {
  resolveAdapter(personaId: string, requesterId: string): Promise<string>;
}

/**
 * Requirement 16.1's text inspection, narrowed to the one call the gateway makes.
 *
 * Structurally satisfied by `ModerationService`, without this module importing it — the
 * same shape every other cross-service port in `services/generation` takes.
 */
export interface SongModerationPort {
  inspect(request: {
    readonly accountId: string;
    readonly requestId: string;
    readonly texts: readonly { readonly field: ModerationField; readonly value: string }[];
  }): ModerationDecision;
}

/**
 * The Moderation_Service and the identifier its block audit is correlated by.
 *
 * `newRequestId` is separate because the Generation_Job does not exist yet when the
 * verdict is taken — that is the whole point of the ordering in design §9.1 — so the
 * job id cannot be the correlation key. Requirement 16.7's audit entry needs one
 * regardless (§11.2), and minting it here keeps the gateway free of a clock or a
 * counter of its own.
 */
export interface SongModerationOptions {
  readonly service: SongModerationPort;
  readonly newRequestId: () => string;
}

export interface SongGatewayOptions {
  readonly orchestrator: JobOrchestrator;
  /**
   * Inspects the request's text before anything can charge for it (Requirement 16.2).
   *
   * Optional, like every other collaborator here: a composition without a
   * Moderation_Service submits without a verdict and the orchestrator approves
   * nothing, which is the pre-Requirement-16 behaviour. Wiring it is what makes the
   * 403 path reachable from the HTTP surface rather than only from a caller that
   * passes its own `moderate` thunk.
   */
  readonly moderation?: SongModerationOptions;
  /** Requirement 15.5. Omitted in compositions with no Persona_Service. */
  readonly personas?: PersonaAdapterResolver;
  /** `song` for Requirements 3 and 4; task 2.4 reuses the gateway with `bgm`. */
  readonly assetKind?: AssetKind;
  readonly reservedLengthSeconds?: number;
  /**
   * Permitted output length. Requirement 4.2's 10–600 s unless overridden.
   *
   * The BGM_Service overrides it with Requirement 21.2's 5–600 s. It is the only
   * per-Asset_Kind bound in the request: everything else the validator checks is a
   * property of the engine's parameter space and does not vary by what is generated.
   */
  readonly durationBounds?: SongDurationBounds;
}

export interface SongSubmissionInput {
  readonly accountId: string;
  readonly request: SongGenerationRequest;
  /** Engine named by the caller (Requirement 20.3). */
  readonly engineId?: string;
  /**
   * Content policy verdict, evaluated lazily by the orchestrator (design §9.1).
   *
   * Overrides the gateway's own Moderation_Service when both are present, so a caller
   * that has already inspected the text — the Requirement 16.10 speech path does — is
   * not inspected a second time under a different request id.
   */
  readonly moderate?: () => ModerationDecision;
  /** Requirement 15.5: the persona to generate in. Refused by 15.6 if not the caller's. */
  readonly personaId?: string;
}

export class SongGateway {
  private readonly orchestrator: JobOrchestrator;
  private readonly personas: PersonaAdapterResolver | null;
  private readonly moderation: SongModerationOptions | null;
  private readonly assetKind: AssetKind;
  private readonly reservedLengthSeconds: number;
  private readonly durationBounds: SongDurationBounds;

  constructor(options: SongGatewayOptions) {
    this.orchestrator = options.orchestrator;
    this.personas = options.personas ?? null;
    this.moderation = options.moderation ?? null;
    this.assetKind = options.assetKind ?? 'song';
    this.reservedLengthSeconds =
      options.reservedLengthSeconds ?? UNSPECIFIED_LENGTH_RESERVATION_SECONDS;
    this.durationBounds = options.durationBounds ?? SONG_DURATION_BOUNDS;
  }

  /**
   * Requirements 3.5, 3.8 and 4.6 reject; everything else is accepted and submitted.
   *
   * Validation happens before the orchestrator is touched, so a malformed request
   * never reaches routing, moderation or the credit debit.
   */
  async submit(input: SongSubmissionInput): Promise<SubmitOutcome> {
    const validation = validateSongRequest(input.request, this.durationBounds);
    if (validation.kind === 'invalid') {
      throw songRequestInvalid(validation.violations);
    }

    // Requirements 15.5, 15.6 — resolved before the orchestrator, so a persona the caller
    // does not own is refused before routing, moderation or the credit debit, exactly as a
    // malformed request is. A 403 that arrived after a charge would need a refund path.
    const personaAdapterRef = await this.resolvePersona(input);

    return this.orchestrator.submit({
      ...this.submissionOf(input, validation.parameters),
      ...(personaAdapterRef === null ? {} : { personaAdapterRef }),
    });
  }

  private async resolvePersona(input: SongSubmissionInput): Promise<string | null> {
    if (input.personaId === undefined) return null;
    if (this.personas === null) {
      throw new Error('a personaId was submitted to a gateway composed without a Persona_Service');
    }
    return this.personas.resolveAdapter(input.personaId, input.accountId);
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
      ...this.moderationOf(input, song),
    };
  }

  /**
   * The verdict thunk the orchestrator runs inside its gate.
   *
   * Lazy for the reason design §9.1 gives, and lazy here too: the request id is minted
   * inside the thunk, so a submission that never reaches the gate — routing refuses it
   * first — leaves no gap in the correlation sequence.
   */
  private moderationOf(
    input: SongSubmissionInput,
    song: SongParameters,
  ): { readonly moderate?: () => ModerationDecision } {
    if (input.moderate !== undefined) return { moderate: input.moderate };

    const moderation = this.moderation;
    if (moderation === null) return {};

    const texts = moderationTextsOf(song);
    return {
      moderate: () =>
        moderation.service.inspect({
          accountId: input.accountId,
          requestId: moderation.newRequestId(),
          texts,
        }),
    };
  }
}

/**
 * Requirement 16.1's three fields, as they appear on a song request.
 *
 * Only the ones the caller actually wrote: an absent caption is not an empty caption,
 * and inspecting `''` would put a field in the audited decision that the user never
 * submitted.
 */
function moderationTextsOf(
  song: SongParameters,
): readonly { readonly field: ModerationField; readonly value: string }[] {
  const texts: { readonly field: ModerationField; readonly value: string }[] = [];

  if (song.description !== undefined) texts.push({ field: 'description', value: song.description });
  if (song.caption !== undefined) texts.push({ field: 'caption', value: song.caption });
  if (song.lyrics !== undefined) texts.push({ field: 'lyrics', value: song.lyrics });

  return texts;
}

function promptOf(song: SongParameters): { readonly prompt?: string } {
  const text = song.mode === 'simple' ? song.description : song.caption;
  return text === undefined ? {} : { prompt: text };
}
