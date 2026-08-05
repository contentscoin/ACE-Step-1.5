import { describe, expect, it } from 'vitest';

import type { ModerationDecision } from '../../../services/moderation/decision';
import { SongGateway, type SongModerationPort } from '../../../services/generation/song-gateway';
import { createGenerationHarness } from '../../support/generation-harness';

/**
 * The Moderation_Service seam on the song gateway (Requirement 16.1, 16.2).
 *
 * **Validates: Requirements 16.1, 16.2**
 *
 * `test/e2e/safety-flow.e2e.test.ts` proves the gate is reachable over HTTP and that a block
 * costs nothing. What it cannot show — it submits Simple_Mode, which has one text — is *which*
 * texts are inspected. Requirement 16.1 names three fields, and a gateway that forwarded only
 * the prompt would pass every test in the safety flow while leaving lyrics uninspected.
 */

interface Inspected {
  readonly accountId: string;
  readonly requestId: string;
  readonly texts: readonly { readonly field: string; readonly value: string }[];
}

function recordingModeration(decision: ModerationDecision): {
  readonly port: SongModerationPort;
  readonly seen: Inspected[];
} {
  const seen: Inspected[] = [];
  return {
    seen,
    port: {
      inspect(request) {
        seen.push({
          accountId: request.accountId,
          requestId: request.requestId,
          texts: request.texts.map((text) => ({ field: text.field, value: text.value })),
        });
        return decision;
      },
    },
  };
}

const APPROVED: ModerationDecision = { outcome: 'approved', texts: [], notices: [] };

function gatewayWith(moderation: SongModerationPort) {
  const harness = createGenerationHarness();
  let requests = 0;

  const gateway = new SongGateway({
    orchestrator: harness.orchestrator,
    moderation: {
      service: moderation,
      newRequestId: () => {
        requests += 1;
        return `moderation-${String(requests)}`;
      },
    },
  });

  return { gateway, harness };
}

describe('the texts the gateway submits for inspection (Requirement 16.1)', () => {
  it('sends the caption and the lyrics of a Custom_Mode request, both of them', async () => {
    const moderation = recordingModeration(APPROVED);
    const { gateway } = gatewayWith(moderation.port);

    await gateway.submit({
      accountId: 'account-1',
      request: {
        mode: 'custom',
        caption: 'dreamy synth pop',
        lyrics: '[verse]\nwalking home in the rain\n',
        durationSeconds: 60,
      },
    });

    expect(moderation.seen).toHaveLength(1);
    expect(moderation.seen[0]?.texts).toEqual([
      { field: 'caption', value: 'dreamy synth pop' },
      { field: 'lyrics', value: '[verse]\nwalking home in the rain\n' },
    ]);
    expect(moderation.seen[0]?.accountId).toBe('account-1');
  });

  it('sends the description of a Simple_Mode request under that field name', async () => {
    // The field name is not decoration: `STYLE_BEARING_FIELDS` in `domain/moderation/fields.ts`
    // makes Requirement 16.3's public-figure rule apply to `description` and `caption` and not
    // to lyrics, so a text filed under the wrong name is inspected under the wrong rules.
    const moderation = recordingModeration(APPROVED);
    const { gateway } = gatewayWith(moderation.port);

    await gateway.submit({
      accountId: 'account-1',
      request: { mode: 'simple', description: 'a warm lo-fi piano beat', durationSeconds: 60 },
    });

    expect(moderation.seen[0]?.texts).toEqual([
      { field: 'description', value: 'a warm lo-fi piano beat' },
    ]);
  });

  it('inspects the validated parameters, not the raw request body', async () => {
    // An instrumental request carries no lyrics; `validateSongRequest` fills in the engine's
    // `[instrumental]` marker, and that — the text the engine will actually receive — is what
    // reaches the gate. Inspecting the raw body instead would let a text the validator rewrote
    // reach the engine unexamined.
    const moderation = recordingModeration(APPROVED);
    const { gateway } = gatewayWith(moderation.port);

    await gateway.submit({
      accountId: 'account-1',
      request: { mode: 'custom', instrumental: true, bpm: 120, durationSeconds: 60 },
    });

    expect(moderation.seen[0]?.texts).toEqual([{ field: 'lyrics', value: '[instrumental]' }]);
  });
});

describe('when the gate refuses (Requirement 16.2)', () => {
  it('returns the block and never reaches the engine', async () => {
    const moderation = recordingModeration({
      outcome: 'blocked',
      texts: [],
      blocks: [
        {
          code: 'policy_violation',
          violations: [
            { violationClass: 'impersonation', field: 'caption', evidence: 'the president' },
          ],
        },
      ],
      violationClasses: ['impersonation'],
    });
    const { gateway, harness } = gatewayWith(moderation.port);

    const outcome = await gateway.submit({
      accountId: 'account-1',
      request: { mode: 'custom', caption: 'sing as the president', durationSeconds: 60 },
    });

    expect(outcome.kind).toBe('blocked');
    expect(harness.adapter.submitCount).toBe(0);
    expect(harness.charges.requests).toEqual([]);
  });

  it('is not consulted at all when the caller supplied its own verdict', async () => {
    // The Requirement 16.10 speech path inspects before it submits. Inspecting a second time
    // here would write a second Requirement 16.7 audit entry for one request, under a request
    // id nothing else knows.
    const moderation = recordingModeration(APPROVED);
    const { gateway } = gatewayWith(moderation.port);

    await gateway.submit({
      accountId: 'account-1',
      request: { mode: 'custom', caption: 'dreamy synth pop', durationSeconds: 60 },
      moderate: () => APPROVED,
    });

    expect(moderation.seen).toEqual([]);
  });

  it('mints one request id per submission, and none for a request it never gets to judge', async () => {
    const moderation = recordingModeration(APPROVED);
    const { gateway } = gatewayWith(moderation.port);

    // Refused by validation, before routing and before the gate.
    await expect(
      gateway.submit({
        accountId: 'account-1',
        request: { mode: 'custom', caption: 'x', durationSeconds: 5 },
      }),
    ).rejects.toThrow();

    await gateway.submit({
      accountId: 'account-1',
      request: { mode: 'custom', caption: 'dreamy synth pop', durationSeconds: 60 },
    });
    await gateway.submit({
      accountId: 'account-1',
      request: { mode: 'custom', caption: 'brushed drums', durationSeconds: 60 },
    });

    expect(moderation.seen.map((entry) => entry.requestId)).toEqual([
      'moderation-1',
      'moderation-2',
    ]);
  });
});
