/**
 * The two-stage consent withdrawal state machine (design §9.2), as a pure function.
 *
 * ### Why two stages
 *
 * An immediate full takedown on an unverified claim is a denial-of-service vector
 * against a legitimate creator: anyone who can name a profile could unpublish its
 * output. Verification-first leaves real harm unaddressed for as long as
 * verification takes. The split resolves both — `잠정_사용_제한` stops *new* harm
 * at once while costing the owner nothing that cannot be undone, and `사용_중지`
 * takes the irreversible steps only once identity is verified.
 *
 * That is why the two stages differ in exactly one respect, and it is the respect
 * this module exists to protect:
 *
 * | | new generation (26.29) | existing public assets |
 * |---|---|---|
 * | `잠정_사용_제한` | refused, 403 + reason code | **untouched** (26.30) |
 * | `사용_중지` | refused, 403 + reason code | private within 24h (26.33) |
 *
 * `mutatesAssetVisibility` is the machine-checkable form of that row. No transition
 * into `잠정_사용_제한` may emit an effect for which it is true, and
 * `test/unit/voice/withdrawal-machine.test.ts` asserts it over every reachable
 * transition rather than over one hand-picked case.
 *
 * ### Shape
 *
 * Total and pure: an inapplicable event is a `refused` result, never a throw and
 * never a silent no-op. Effects are returned as *data* — the caller executes them
 * through ports — so the timing rules live here and the I/O lives in
 * `services/voice/`.
 */

import {
  ASSET_UNPUBLISH_WINDOW_MS,
  IDENTITY_VERIFICATION_WINDOW_MS,
  VOICE_DATA_ERASURE_WINDOW_MS,
  WITHDRAWAL_INTAKE_WINDOW_MS,
} from './windows';
import {
  isProfileDeleted,
  type VoiceProfileConsentState,
} from './consent-state';

export const WITHDRAWAL_EVENT_KINDS = [
  /** Requirement 26.28 — a claim arrived from the speaker or their agent. */
  '동의_철회_접수',
  /** Requirement 26.32 — the claimant's identity was verified. */
  '신원_확인_성공',
  /** Requirement 26.34 — verification was attempted and failed. */
  '신원_확인_실패',
  /** Requirement 26.34 — the 14-day window closed with nothing submitted. */
  '신원_확인_기한_경과',
  /** Design §9.2 — the `사용_중지` erasure finished; the profile leaves the machine. */
  '데이터_삭제_완료',
  /** Requirement 26.21 — the owner asked for deletion. */
  '소유자_삭제_요청',
] as const;

export type WithdrawalEventKind = (typeof WITHDRAWAL_EVENT_KINDS)[number];

export const WITHDRAWAL_EFFECT_KINDS = [
  /** Requirement 26.31 — ask the claimant for a challenge phrase or a document. */
  'require_identity_verification',
  /** Requirement 26.21 / 26.32 — erase reference samples, embeddings and caches. */
  'erase_voice_data',
  /** Requirement 26.33 — turn public generated assets private. */
  'unpublish_generated_assets',
  /** Requirement 26.30 — leave generated assets' visibility exactly as it was. */
  'preserve_asset_visibility',
  /** Requirement 26.23 — already-generated assets survive the deletion unchanged. */
  'preserve_generated_assets',
  /** Requirements 26.28, 26.33, 26.34 — tell the profile owner. */
  'notify_owner',
  /** Requirement 26.34 — tell the claimant the profile was restored. */
  'notify_claimant',
] as const;

export type WithdrawalEffectKind = (typeof WITHDRAWAL_EFFECT_KINDS)[number];

export interface WithdrawalEffect {
  readonly kind: WithdrawalEffectKind;
  /** Deadline the criterion attaches, or `null` where it names none. */
  readonly dueAtMs: number | null;
}

/**
 * The single effect kind that changes what the public can see.
 *
 * Requirement 26.30 is the reason this predicate exists rather than being inlined:
 * it turns "a provisional restriction must not touch visibility" from a review
 * comment into an assertion.
 */
export function mutatesAssetVisibility(effect: WithdrawalEffect): boolean {
  return effect.kind === 'unpublish_generated_assets';
}

export interface WithdrawalContext {
  readonly state: VoiceProfileConsentState;
  /**
   * Requirement 26.34's restore target — the state held before the claim.
   *
   * Recorded rather than assumed to be `정상`, so a revert cannot silently promote a
   * profile that was already restricted for another reason.
   */
  readonly stateBeforeWithdrawal: VoiceProfileConsentState | null;
  /** Requirement 26.28's intake instant; the 24-hour transition budget runs from it. */
  readonly withdrawalReceivedAtMs: number | null;
  /** Requirement 26.31's 14-day clock origin: entry into `잠정_사용_제한`. */
  readonly provisionalSinceMs: number | null;
}

export interface WithdrawalEventInput {
  readonly kind: WithdrawalEventKind;
  /** When the event is being applied. Always a `Clock` reading at the call site. */
  readonly atMs: number;
  /**
   * For `동의_철회_접수`: when the claim actually arrived, if earlier than `atMs`.
   * Requirement 26.28's 24-hour budget is measured from this, not from the moment
   * the queue got round to it.
   */
  readonly claimReceivedAtMs?: number;
}

export interface WithdrawalTransition {
  readonly from: VoiceProfileConsentState;
  readonly to: VoiceProfileConsentState;
  readonly event: WithdrawalEventKind;
  readonly atMs: number;
  readonly effects: readonly WithdrawalEffect[];
  /** Context to persist alongside the new state. */
  readonly next: WithdrawalContext;
  /**
   * Requirement 26.28 — false when the `잠정_사용_제한` transition landed more than
   * 24 hours after intake. Reported, not enforced: a late transition is an
   * operational failure to alert on, and refusing the claim instead would let a
   * slow queue defeat the withdrawal.
   */
  readonly withinIntakeWindow: boolean;
}

export const WITHDRAWAL_REFUSAL_REASONS = [
  /** The event has no meaning from the current state. */
  'state_not_applicable',
  /** Requirement 26.32 — verification arrived after the 14-day window closed. */
  'verification_window_elapsed',
  /** Requirement 26.34 — the window has not closed yet, so nothing has expired. */
  'verification_window_open',
] as const;

export type WithdrawalRefusalReason = (typeof WITHDRAWAL_REFUSAL_REASONS)[number];

export type WithdrawalTransitionResult =
  | { readonly outcome: 'transitioned'; readonly transition: WithdrawalTransition }
  | {
      readonly outcome: 'refused';
      readonly reason: WithdrawalRefusalReason;
      readonly from: VoiceProfileConsentState;
      readonly event: WithdrawalEventKind;
    };

export function initialWithdrawalContext(
  state: VoiceProfileConsentState = '정상',
): WithdrawalContext {
  return {
    state,
    stateBeforeWithdrawal: null,
    withdrawalReceivedAtMs: null,
    provisionalSinceMs: null,
  };
}

/** Elapsed time in `잠정_사용_제한`, or `null` when the profile is not in it. */
export function provisionalElapsedMs(
  context: WithdrawalContext,
  nowMs: number,
): number | null {
  if (context.state !== '잠정_사용_제한' || context.provisionalSinceMs === null) return null;
  return nowMs - context.provisionalSinceMs;
}

/** Requirement 26.34 — has the 14-day verification window closed? */
export function isVerificationWindowElapsed(
  context: WithdrawalContext,
  nowMs: number,
): boolean {
  const elapsed = provisionalElapsedMs(context, nowMs);
  return elapsed !== null && elapsed >= IDENTITY_VERIFICATION_WINDOW_MS;
}

/** Requirement 26.31 — the instant by which verification material is due. */
export function verificationDeadlineMs(context: WithdrawalContext): number | null {
  return context.provisionalSinceMs === null
    ? null
    : context.provisionalSinceMs + IDENTITY_VERIFICATION_WINDOW_MS;
}

/**
 * Apply one event. The whole state machine is this function.
 */
export function applyWithdrawalEvent(
  context: WithdrawalContext,
  event: WithdrawalEventInput,
): WithdrawalTransitionResult {
  switch (event.kind) {
    case '동의_철회_접수':
      return receiveWithdrawal(context, event);
    case '신원_확인_성공':
      return verifyIdentity(context, event);
    case '신원_확인_실패':
      return revert(context, event);
    case '신원_확인_기한_경과':
      return expire(context, event);
    case '데이터_삭제_완료':
      return completeErasure(context, event);
    case '소유자_삭제_요청':
      return deleteByOwner(context, event);
  }
}

/** Requirement 26.28: `정상` → `잠정_사용_제한`, within 24 hours of intake. */
function receiveWithdrawal(
  context: WithdrawalContext,
  event: WithdrawalEventInput,
): WithdrawalTransitionResult {
  // A claim against a profile that is already restricted, withdrawn or deleted has
  // nothing left to restrict. The quota rule (26.35) counts claims separately, so
  // this refusal does not hide a repeat claimant from the cap.
  if (context.state !== '정상') {
    return refused(context.state, event.kind, 'state_not_applicable');
  }

  const receivedAtMs = event.claimReceivedAtMs ?? event.atMs;

  return transitioned({
    from: context.state,
    to: '잠정_사용_제한',
    event: event.kind,
    atMs: event.atMs,
    effects: [
      // Requirement 26.31 — the 14-day clock starts at this transition.
      {
        kind: 'require_identity_verification',
        dueAtMs: event.atMs + IDENTITY_VERIFICATION_WINDOW_MS,
      },
      // Requirement 26.30 — stated as an obligation so the *absence* of a
      // visibility change is part of the transition rather than an omission
      // nobody notices. `mutatesAssetVisibility` is false for it.
      { kind: 'preserve_asset_visibility', dueAtMs: null },
      // Requirement 26.28 — intake notice plus how to object (26.36).
      { kind: 'notify_owner', dueAtMs: null },
    ],
    next: {
      state: '잠정_사용_제한',
      stateBeforeWithdrawal: context.state,
      withdrawalReceivedAtMs: receivedAtMs,
      provisionalSinceMs: event.atMs,
    },
    withinIntakeWindow: event.atMs - receivedAtMs <= WITHDRAWAL_INTAKE_WINDOW_MS,
  });
}

/** Requirement 26.32: `잠정_사용_제한` → `사용_중지` on verification, within 14 days. */
function verifyIdentity(
  context: WithdrawalContext,
  event: WithdrawalEventInput,
): WithdrawalTransitionResult {
  if (context.state !== '잠정_사용_제한') {
    return refused(context.state, event.kind, 'state_not_applicable');
  }
  // Verification that arrives after the window has closed cannot promote the
  // profile: 26.34 has already made the revert due. The caller applies
  // `신원_확인_기한_경과` instead, which is why this is a refusal with a distinct
  // reason rather than a silent success.
  if (isVerificationWindowElapsed(context, event.atMs)) {
    return refused(context.state, event.kind, 'verification_window_elapsed');
  }

  return transitioned({
    from: context.state,
    to: '사용_중지',
    event: event.kind,
    atMs: event.atMs,
    effects: [
      // Requirement 26.32 — the 26.21 data set, within 24 hours.
      { kind: 'erase_voice_data', dueAtMs: event.atMs + VOICE_DATA_ERASURE_WINDOW_MS },
      // Requirement 26.33 — and only now does visibility change.
      {
        kind: 'unpublish_generated_assets',
        dueAtMs: event.atMs + ASSET_UNPUBLISH_WINDOW_MS,
      },
      // Requirement 26.33 — the owner is told the reason and the asset ids.
      { kind: 'notify_owner', dueAtMs: null },
    ],
    next: {
      state: '사용_중지',
      // The 14-day context is dropped, not carried. It is only meaningful while a claim
      // is open: 26.34's revert is unreachable from `사용_중지`, and a surviving
      // `provisionalSinceMs` would make `verificationDeadlineMs` report a deadline for a
      // claim that has already been decided. `0011_voice_consent.sql` states the same
      // rule as a CHECK — the context columns are non-null exactly in `잠정_사용_제한` —
      // so keeping them here would make the domain write a row the database refuses.
      stateBeforeWithdrawal: null,
      withdrawalReceivedAtMs: context.withdrawalReceivedAtMs,
      provisionalSinceMs: null,
    },
    withinIntakeWindow: true,
  });
}

/** Requirement 26.34 — verification failed: back to the pre-withdrawal state. */
function revert(
  context: WithdrawalContext,
  event: WithdrawalEventInput,
): WithdrawalTransitionResult {
  if (context.state !== '잠정_사용_제한') {
    return refused(context.state, event.kind, 'state_not_applicable');
  }
  return restoreTransition(context, event);
}

/** Requirement 26.34 — nothing submitted within 14 days: back to the prior state. */
function expire(
  context: WithdrawalContext,
  event: WithdrawalEventInput,
): WithdrawalTransitionResult {
  if (context.state !== '잠정_사용_제한') {
    return refused(context.state, event.kind, 'state_not_applicable');
  }
  // Expiry before the window closes would cut the claimant's 14 days short, which
  // is the one direction this criterion is not allowed to err in.
  if (!isVerificationWindowElapsed(context, event.atMs)) {
    return refused(context.state, event.kind, 'verification_window_open');
  }
  return restoreTransition(context, event);
}

function restoreTransition(
  context: WithdrawalContext,
  event: WithdrawalEventInput,
): WithdrawalTransitionResult {
  const to = context.stateBeforeWithdrawal ?? '정상';

  return transitioned({
    from: context.state,
    to,
    event: event.kind,
    atMs: event.atMs,
    effects: [
      // Requirement 26.30 held throughout, so a restore has nothing to undo. Saying
      // so explicitly is what makes "the provisional stage was reversible" checkable.
      { kind: 'preserve_asset_visibility', dueAtMs: null },
      { kind: 'notify_owner', dueAtMs: null },
      { kind: 'notify_claimant', dueAtMs: null },
    ],
    next: {
      state: to,
      stateBeforeWithdrawal: null,
      withdrawalReceivedAtMs: null,
      provisionalSinceMs: null,
    },
    withinIntakeWindow: true,
  });
}

/** Design §9.2 — erasure finished; `사용_중지` leaves the machine as `삭제됨`. */
function completeErasure(
  context: WithdrawalContext,
  event: WithdrawalEventInput,
): WithdrawalTransitionResult {
  if (context.state !== '사용_중지') {
    return refused(context.state, event.kind, 'state_not_applicable');
  }

  return transitioned({
    from: context.state,
    to: '삭제됨',
    event: event.kind,
    atMs: event.atMs,
    // 26.33 already unpublished the generated assets; erasure destroys the profile's
    // own data, not its output, so the assets are preserved here too.
    effects: [{ kind: 'preserve_generated_assets', dueAtMs: null }],
    next: {
      state: '삭제됨',
      stateBeforeWithdrawal: null,
      withdrawalReceivedAtMs: context.withdrawalReceivedAtMs,
      provisionalSinceMs: null,
    },
    withinIntakeWindow: true,
  });
}

/**
 * Requirement 26.21 — the owner's own deletion, from any live state.
 *
 * Deliberately **not** a visibility change: Requirement 26.23 keeps
 * already-generated assets unchanged. That is the opposite of 26.33, and the two are
 * reached by different events, which is the whole reason owner deletion is a separate
 * event rather than a shortcut into `사용_중지`.
 */
function deleteByOwner(
  context: WithdrawalContext,
  event: WithdrawalEventInput,
): WithdrawalTransitionResult {
  if (isProfileDeleted(context.state)) {
    return refused(context.state, event.kind, 'state_not_applicable');
  }

  return transitioned({
    from: context.state,
    to: '삭제됨',
    event: event.kind,
    atMs: event.atMs,
    effects: [
      { kind: 'erase_voice_data', dueAtMs: event.atMs + VOICE_DATA_ERASURE_WINDOW_MS },
      { kind: 'preserve_generated_assets', dueAtMs: null },
    ],
    next: {
      state: '삭제됨',
      stateBeforeWithdrawal: null,
      withdrawalReceivedAtMs: context.withdrawalReceivedAtMs,
      provisionalSinceMs: null,
    },
    withinIntakeWindow: true,
  });
}

function transitioned(transition: WithdrawalTransition): WithdrawalTransitionResult {
  return { outcome: 'transitioned', transition };
}

function refused(
  from: VoiceProfileConsentState,
  event: WithdrawalEventKind,
  reason: WithdrawalRefusalReason,
): WithdrawalTransitionResult {
  return { outcome: 'refused', reason, from, event };
}

/** Requirement 26.30's guard, for callers and the parity test. */
export function transitionMutatesAssetVisibility(transition: WithdrawalTransition): boolean {
  return transition.effects.some(mutatesAssetVisibility);
}

/** The effect of `kind` on a transition, if it carries one. */
export function effectOf(
  transition: WithdrawalTransition,
  kind: WithdrawalEffectKind,
): WithdrawalEffect | undefined {
  return transition.effects.find((effect) => effect.kind === kind);
}
