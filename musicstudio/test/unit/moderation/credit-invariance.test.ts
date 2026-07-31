import { describe, expect, it } from 'vitest';

import { withModerationGate } from '../../../services/moderation/generation-gate';
import { createFrozenCreditBalance } from '../../support/registry-harness';
import { createModerationHarness } from '../../support/moderation-harness';

/**
 * Requirements 16.2 and 16.11 — a blocked request leaves the credit balance at its
 * pre-request value.
 *
 * Credit_Service is task 1.4, so the guarantee is asserted structurally, exactly as
 * design §9.1 states it: moderation runs *before* anything that could charge. The
 * stand-in balance throws on any debit, so a debit reached on a blocked path would
 * fail the test rather than pass silently.
 */

const BLOCKED_CAPTION = { field: 'caption', value: '보이스피싱 안내' } as const;
const IMPERSONATING_SCRIPT = { field: 'dialogue_script', value: '저는 아이유입니다' } as const;

describe('credit invariance on a block (Requirements 16.2, 16.11)', () => {
  it('never reaches the charging step when text violates the policy (16.2)', async () => {
    const { moderation } = createModerationHarness();
    const credits = createFrozenCreditBalance(500);

    const outcome = await withModerationGate(
      () =>
        moderation.inspect({
          accountId: 'account-1',
          requestId: 'request-1',
          texts: [BLOCKED_CAPTION],
        }),
      // Everything that costs money lives here. It is unreachable on a block.
      async () => credits.debit(40),
    );

    expect(outcome.kind).toBe('blocked');
    expect(credits.balance).toBe(500);
  });

  it('never reaches the charging step for an impersonating script (16.11)', async () => {
    const { moderation } = createModerationHarness();
    const credits = createFrozenCreditBalance(120);

    const outcome = await withModerationGate(
      () =>
        moderation.inspect({
          accountId: 'account-1',
          requestId: 'request-2',
          texts: [IMPERSONATING_SCRIPT],
        }),
      async () => credits.debit(1),
    );

    expect(outcome.kind).toBe('blocked');
    if (outcome.kind !== 'blocked') throw new Error('unreachable');
    expect(outcome.decision.violationClasses).toEqual(['impersonation']);
    expect(credits.balance).toBe(120);
  });

  it('never reaches the charging step when consent is missing (16.4, 16.12, 16.14)', async () => {
    const { moderation } = createModerationHarness();
    const credits = createFrozenCreditBalance(9);

    for (const request of [
      {
        accountId: 'account-1',
        requestId: 'r-audio',
        texts: [],
        uploads: [{ uploadId: 'u1', purpose: 'audio_edit' as const, mediaKind: 'audio' as const }],
      },
      {
        accountId: 'account-1',
        requestId: 'r-video',
        texts: [],
        uploads: [{ uploadId: 'u2', purpose: 'foley_video' as const, mediaKind: 'video' as const }],
      },
      {
        accountId: 'account-1',
        requestId: 'r-voice',
        texts: [],
        voiceReference: { voiceProfileId: 'voice-1', uploadIds: ['s1'] },
      },
    ]) {
      const outcome = await withModerationGate(
        () => moderation.inspect(request),
        async () => credits.debit(1),
      );

      expect(outcome.kind).toBe('blocked');
    }

    expect(credits.balance).toBe(9);
  });

  it('does reach the charging step once the request is approved', async () => {
    // The mirror image: the gate is an ordering, not a blanket refusal to charge.
    const { moderation } = createModerationHarness();
    const debits: number[] = [];

    const outcome = await withModerationGate(
      () =>
        moderation.inspect({
          accountId: 'account-1',
          requestId: 'request-3',
          texts: [{ field: 'caption', value: 'gentle acoustic morning loop' }],
        }),
      async (approved) => {
        debits.push(40);
        return approved.texts.length;
      },
    );

    expect(outcome).toEqual({ kind: 'proceed', value: 1 });
    expect(debits).toEqual([40]);
  });

  it('hands the sanitized text to the charging step, not the original', async () => {
    // Requirement 16.3: what proceeds to the engine is the rewritten text.
    const { moderation } = createModerationHarness();

    const outcome = await withModerationGate(
      () =>
        moderation.inspect({
          accountId: 'account-1',
          requestId: 'request-4',
          texts: [{ field: 'caption', value: 'like Adele' }],
        }),
      async (approved) => approved.texts[0]?.sanitized ?? '',
    );

    expect(outcome.kind).toBe('proceed');
    if (outcome.kind !== 'proceed') throw new Error('unreachable');
    expect(outcome.value).not.toContain('Adele');
  });
});
