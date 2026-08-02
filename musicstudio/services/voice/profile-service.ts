/**
 * Voice_Profile creation and lookup (Requirements 26.1–26.11).
 *
 * ### The ordering that makes 26.12 and 26.13 true
 *
 * One rule governs `createCloned` and it is the reason this is a service rather than a validator:
 * **the consent record is taken before any reference sample is stored.** Requirement 26.12 says
 * the record is required "참조 샘플 영구 저장 이전 단계에서", and 26.13 requires a refused upload to
 * be discarded "영구 저장 없이". So the sequence is fixed:
 *
 * 1. validate the name and the sample count (26.1, 26.7) — decidable from the request alone
 * 2. take the consent record through task 6.2's `ConsentService` (26.12–26.15)
 * 3. on refusal, **discard the staged uploads** and re-raise (26.13)
 * 4. probe and validate each sample (26.2–26.5); on refusal, discard and re-raise (26.4)
 * 5. transcribe each sample's reference text (26.6)
 * 6. promote the uploads to stored reference samples — the first durable write
 * 7. combine them into one voice prompt when there are two or more (26.8)
 *
 * Steps 1 and 4 both precede step 6, so no path exists on which a rejected upload has been
 * persisted. The consent machinery itself is **not reimplemented**: `ConsentService`,
 * `validateCloneConsent`, the audit entry of 26.15 and the immutability of 26.14 are all task
 * 6.2's, consumed here.
 *
 * ### Why the consent record is taken before the probe
 *
 * 26.12 puts the record before *storage*, not before *validation*, so either order would satisfy
 * the letter of it. Consent first is chosen because 26.13's discard is unconditional on the
 * consent path while 26.4's is a consequence of this design — a request with no consent should not
 * cause the platform to decode the audio at all, which is the same instinct
 * `V2aService.generate` follows in checking rights consent before opening the file.
 *
 * ### A `preset` profile stores no samples
 *
 * `createPreset` needs no consent record, no probe and no transcript: Requirement 26.12 conditions
 * the record on a `cloned` profile, and a catalogue voice is the provider's, not a person's whose
 * permission the user could hold. What it does need is 26.10's binding, which is copied off the
 * catalogue entry and never accepted from the caller.
 */

import { randomUUID } from 'node:crypto';

import { speechPresenceThresholds } from '../../domain/quality/speech-thresholds';
import {
  fixedThresholdSource,
  type QualityThresholdSource,
} from '../../domain/quality/threshold-source';
import { enumViolation, rangeViolation, type SongFieldViolation } from '../../domain/song/violation';
import { normaliseLanguageCode } from '../../domain/speech/language';
import type { CloneConsentRecordDraft } from '../../domain/voice/consent-record';
import {
  needsCombinedPrompt,
  validateProfileName,
  validateReferenceSampleCount,
  type ClonedVoiceProfile,
  type PresetVoiceProfile,
  type ReferenceSample,
  type VoiceProfile,
} from '../../domain/voice/profile';
import { validateReferenceSample } from '../../domain/voice/reference-sample';
import {
  DEFAULT_PRESET_VOICE_CATALOGUE,
  findPresetVoice,
  listPresetVoices,
  type CatalogueQuery,
  type PresetVoiceEntry,
} from '../../domain/voice/voice-catalogue';
import type { Clock } from '../clock';
import type { ReferenceTranscriptionPort } from '../speech/ports';

import type { ConsentService } from './consent-service';
import { consentIncomplete } from './errors';
import {
  referenceSampleRejected,
  referenceSampleUnreadable,
  voiceProfileRequestInvalid,
} from './profile-errors';
import type {
  ReferenceSampleProbePort,
  ReferenceSampleStagingPort,
  VoiceProfileRecordStorePort,
  VoicePromptPort,
} from './profile-ports';

export interface VoiceProfileServiceDependencies {
  readonly profiles: VoiceProfileRecordStorePort;
  /**
   * Task 6.2's consent-state row.
   *
   * Written here on creation so a new profile starts in `정상` with the withdrawal context the
   * state machine expects. **This is the only thing 2.7 writes through 6.2's port**, and it writes
   * the initial context rather than a state of its own choosing — see `store.ts` on why the two
   * ports over one row are kept apart.
   */
  readonly consentState: VoiceProfileCreationStatePort;
  readonly consent: ConsentService;
  readonly probe: ReferenceSampleProbePort;
  readonly staging: ReferenceSampleStagingPort;
  readonly prompts: VoicePromptPort;
  /** Requirement 26.6 — the Transcription_Service, narrowed to one method. */
  readonly transcription: ReferenceTranscriptionPort;
  readonly clock: Clock;
  /** Requirement 26.9's catalogue. Defaults to the seeded entries. */
  readonly catalogue?: readonly PresetVoiceEntry[];
  /** Requirement 34: the set in force, for 26.5's speech-presence rule. */
  readonly thresholds?: QualityThresholdSource;
  readonly newProfileId?: () => string;
}

/**
 * The slice of `VoiceProfileStatePort` creation needs.
 *
 * 6.2's port has no `create`, because 6.2 does not create profiles — 2.7 does. Declared as its own
 * one-method interface rather than by widening 6.2's port, so the write 2.7 performs on the shared
 * row is visible in a signature instead of being available to everything that holds the state
 * port.
 */
export interface VoiceProfileCreationStatePort {
  createConsentRow(input: { readonly voiceProfileId: string; readonly ownerId: string }): void;
}

export interface CreateClonedProfileInput {
  readonly ownerId: string;
  readonly name: string;
  /** Requirement 26.7 — 1–10 staged uploads. */
  readonly uploadIds: readonly string[];
  /** Requirement 26.12's four items. Absent is refused exactly like a negative record. */
  readonly consent?: Omit<CloneConsentRecordDraft, 'kind' | 'targetProfileId' | 'submittedAtMs'>;
  /** Requirement 27.3's hint for the reference transcription of 26.6. */
  readonly languageCode?: string;
}

export interface CreatePresetProfileInput {
  readonly ownerId: string;
  readonly name: string;
  /** Requirement 26.9's 음성 식별자. The engine comes from the entry, never from the caller. */
  readonly voiceId: string;
}

export class VoiceProfileService {
  private readonly deps: VoiceProfileServiceDependencies;
  private readonly catalogue: readonly PresetVoiceEntry[];
  private readonly thresholds: QualityThresholdSource;
  private readonly newId: () => string;

  constructor(deps: VoiceProfileServiceDependencies) {
    this.deps = deps;
    this.catalogue = deps.catalogue ?? DEFAULT_PRESET_VOICE_CATALOGUE;
    this.thresholds = deps.thresholds ?? fixedThresholdSource();
    this.newId = deps.newProfileId ?? (() => randomUUID());
  }

  /** Requirement 26.9 — the catalogue, with its engine, voice and language per entry. */
  presetCatalogue(query: CatalogueQuery = {}): readonly PresetVoiceEntry[] {
    return listPresetVoices(this.catalogue, query);
  }

  find(voiceProfileId: string): VoiceProfile | undefined {
    return this.deps.profiles.find(voiceProfileId);
  }

  listForOwner(ownerId: string): readonly VoiceProfile[] {
    return this.deps.profiles.listForOwner(ownerId);
  }

  /** Requirements 26.1–26.8, 26.12–26.15 in the order the module comment fixes. */
  async createCloned(input: CreateClonedProfileInput): Promise<ClonedVoiceProfile> {
    // Requirements 26.1, 26.7 — decidable from the request, so no upload is touched on failure.
    const nameCheck = validateProfileName(input.name);
    const countCheck = validateReferenceSampleCount(input.uploadIds.length);
    const requestViolations: SongFieldViolation[] = [];
    if (nameCheck.kind === 'invalid') requestViolations.push(nameCheck.violation);
    if (countCheck.kind === 'invalid') requestViolations.push(countCheck.violation);
    if (requestViolations.length > 0 || nameCheck.kind === 'invalid') {
      await this.deps.staging.discard(input.uploadIds);
      throw voiceProfileRequestInvalid({
        violations: requestViolations,
        requirements: ['26.1', '26.7'],
      });
    }

    const voiceProfileId = this.newId();

    // Requirements 26.12–26.15, through task 6.2. The row has to exist first, because the consent
    // record references the target profile (design §9.3's `target_profile_id`) and migration 0011
    // makes that a foreign key.
    this.deps.consentState.createConsentRow({ voiceProfileId, ownerId: input.ownerId });

    const intake = this.deps.consent.recordCloneConsent(
      input.consent === undefined
        ? undefined
        : {
            ...input.consent,
            kind: 'clone',
            targetProfileId: voiceProfileId,
            submittedAtMs: this.deps.clock.now().getTime(),
          },
    );
    if (intake.outcome === 'rejected') {
      // Requirement 26.13: 업로드된 참조 샘플을 영구 저장 없이 폐기한다. The discard precedes the
      // rejection, so there is no path on which the caller learns of the refusal while the files
      // are still held.
      await this.deps.staging.discard(input.uploadIds);
      throw consentIncomplete(intake.unmetItems, { voiceProfileId, uploadsDiscarded: true });
    }

    // Requirements 26.2–26.6, per sample.
    const presence = speechPresenceThresholds(this.thresholds.current());
    const samples: ReferenceSample[] = [];
    for (const uploadId of input.uploadIds) {
      const probed = await this.deps.probe.probe({
        uploadId,
        speechRmsThresholdDb: presence.speechRmsThresholdDb,
        speechMinDurationMs: presence.speechMinDurationMs,
      });

      if (probed.kind === 'unreadable') {
        await this.deps.staging.discard(input.uploadIds);
        throw referenceSampleUnreadable(uploadId, probed.detail);
      }

      const validation = validateReferenceSample(probed.sample);
      if (validation.kind === 'invalid') {
        // Requirement 26.4: the whole request fails, and *every* staged upload is discarded — not
        // only the offending one. A profile built from the subset that happened to pass is not the
        // profile the user asked for, and 26.7's count would then describe something they never
        // submitted.
        await this.deps.staging.discard(input.uploadIds);
        throw referenceSampleRejected({
          uploadId,
          violations: validation.violations,
          constraints: validation.constraints,
          speechRatio: validation.speechRatio,
          uploadsDiscarded: true,
        });
      }

      // Requirement 26.6 — the reference text, from the Transcription_Service.
      const transcribed = await this.deps.transcription.transcribeReference({
        uploadId,
        ...(input.languageCode === undefined
          ? {}
          : { languageCode: normaliseLanguageCode(input.languageCode) }),
      });

      samples.push({
        uploadId,
        durationMs: validation.probed.durationMs,
        sampleRate: validation.probed.sampleRate,
        format: validation.probed.format.toLowerCase(),
        // Requirement 26.6 requires the text to be *generated and stored*, and says nothing about a
        // transcriber that cannot answer. An empty string is stored rather than the request being
        // refused: the sample itself passed 26.5's speech-ratio check, so refusing it here would
        // discard a valid upload because a *different* service was unavailable. The empty value is
        // observable, so a later pass can fill it. **Reported as a spec gap.**
        referenceText: transcribed.kind === 'transcribed' ? transcribed.text : '',
      });
    }

    // The first durable write. Everything above could still refuse.
    for (const sample of samples) {
      await this.deps.staging.promote(sample.uploadId, voiceProfileId);
    }

    // Requirement 26.8 — only from the second sample onwards.
    const draft: ClonedVoiceProfile = {
      kind: 'cloned',
      voiceProfileId,
      ownerId: input.ownerId,
      name: nameCheck.name,
      referenceSamples: samples,
      voicePromptId: null,
      consentRecordId: intake.record.consentRecordId,
      createdAtMs: this.deps.clock.now().getTime(),
    };

    const voicePromptId = needsCombinedPrompt(draft)
      ? await this.deps.prompts.combine({
          voiceProfileId,
          uploadIds: samples.map((sample) => sample.uploadId),
        })
      : null;

    const profile: ClonedVoiceProfile = { ...draft, voicePromptId };
    this.deps.profiles.save(profile);
    return profile;
  }

  /**
   * Requirements 26.1, 26.9, 26.10 — a catalogue voice, bound to its engine.
   *
   * No consent record: 26.12 conditions one on a `cloned` profile, and a catalogue voice is the
   * provider's rather than a person's whose permission a user could hold. The consent-state row is
   * still created, because Requirement 26.29's refusal and 26.21's deletion apply to every profile
   * — a preset voice can be withdrawn by the provider as much as a cloned one can by its speaker.
   */
  createPreset(input: CreatePresetProfileInput): PresetVoiceProfile {
    const nameCheck = validateProfileName(input.name);
    const entry = findPresetVoice(this.catalogue, input.voiceId);

    const violations: SongFieldViolation[] = [];
    if (nameCheck.kind === 'invalid') violations.push(nameCheck.violation);
    if (entry === undefined) {
      violations.push(
        enumViolation(
          'voiceId',
          input.voiceId,
          this.catalogue.map((candidate) => candidate.voiceId),
        ),
      );
    }
    if (violations.length > 0 || nameCheck.kind === 'invalid' || entry === undefined) {
      throw voiceProfileRequestInvalid({ violations, requirements: ['26.1', '26.9'] });
    }

    const voiceProfileId = this.newId();
    this.deps.consentState.createConsentRow({ voiceProfileId, ownerId: input.ownerId });

    const profile: PresetVoiceProfile = {
      kind: 'preset',
      voiceProfileId,
      ownerId: input.ownerId,
      name: nameCheck.name,
      voiceId: entry.voiceId,
      // Requirement 26.10 — copied from the catalogue, never from the caller.
      engineId: entry.engineId,
      languageCode: entry.languageCode,
      createdAtMs: this.deps.clock.now().getTime(),
    };
    this.deps.profiles.save(profile);
    return profile;
  }

  /**
   * Requirement 26.7 — add a sample to an existing `cloned` profile.
   *
   * The count bound is checked against the *resulting* total, which is the only reading that keeps
   * a profile from reaching eleven samples one at a time. The consent record is not retaken: 26.12
   * conditions it on profile *creation*, and the record already covers this speaker's voice. A
   * separate criterion would be needed to require re-consent per sample, and there is none —
   * **reported as a spec observation**, because a user adding a sample of a *different* speaker to
   * an existing profile is a gap the requirement does not close.
   */
  async addReferenceSample(input: {
    readonly voiceProfileId: string;
    readonly uploadId: string;
    readonly languageCode?: string;
  }): Promise<ClonedVoiceProfile> {
    const existing = this.deps.profiles.find(input.voiceProfileId);
    if (existing === undefined || existing.kind !== 'cloned') {
      throw voiceProfileRequestInvalid({
        violations: [rangeViolation('voiceProfileId', input.voiceProfileId, 0, 0)],
        requirements: ['26.7'],
      });
    }

    const countCheck = validateReferenceSampleCount(existing.referenceSamples.length + 1);
    if (countCheck.kind === 'invalid') {
      await this.deps.staging.discard([input.uploadId]);
      throw voiceProfileRequestInvalid({
        violations: [countCheck.violation],
        requirements: ['26.7'],
      });
    }

    const presence = speechPresenceThresholds(this.thresholds.current());
    const probed = await this.deps.probe.probe({
      uploadId: input.uploadId,
      speechRmsThresholdDb: presence.speechRmsThresholdDb,
      speechMinDurationMs: presence.speechMinDurationMs,
    });
    if (probed.kind === 'unreadable') {
      await this.deps.staging.discard([input.uploadId]);
      throw referenceSampleUnreadable(input.uploadId, probed.detail);
    }

    const validation = validateReferenceSample(probed.sample);
    if (validation.kind === 'invalid') {
      await this.deps.staging.discard([input.uploadId]);
      throw referenceSampleRejected({
        uploadId: input.uploadId,
        violations: validation.violations,
        constraints: validation.constraints,
        speechRatio: validation.speechRatio,
        uploadsDiscarded: true,
      });
    }

    const transcribed = await this.deps.transcription.transcribeReference({
      uploadId: input.uploadId,
      ...(input.languageCode === undefined
        ? {}
        : { languageCode: normaliseLanguageCode(input.languageCode) }),
    });
    await this.deps.staging.promote(input.uploadId, input.voiceProfileId);

    const referenceSamples: readonly ReferenceSample[] = [
      ...existing.referenceSamples,
      {
        uploadId: input.uploadId,
        durationMs: validation.probed.durationMs,
        sampleRate: validation.probed.sampleRate,
        format: validation.probed.format.toLowerCase(),
        referenceText: transcribed.kind === 'transcribed' ? transcribed.text : '',
      },
    ];

    const withSample: ClonedVoiceProfile = { ...existing, referenceSamples, voicePromptId: null };
    const profile: ClonedVoiceProfile = {
      ...withSample,
      // Requirement 26.8 — recombined, because the prompt is a function of every sample.
      voicePromptId: needsCombinedPrompt(withSample)
        ? await this.deps.prompts.combine({
            voiceProfileId: input.voiceProfileId,
            uploadIds: referenceSamples.map((sample) => sample.uploadId),
          })
        : null,
    };

    this.deps.profiles.save(profile);
    return profile;
  }
}
