import { describe, expect, it } from 'vitest';

import { ACE_FORMAT_INPUT_PATH } from '../../../adapters/ace/format-input';
import { createFrozenCreditBalance } from '../../support/registry-harness';
import { createLyricsHarness } from '../../support/lyrics-harness';

/**
 * Requirement 8.6 — enrichment leaves the credit balance unchanged.
 *
 * Asserted structurally, the same way `test/unit/moderation/credit-invariance.test.ts`
 * asserts Requirements 16.2 and 16.11: the stand-in balance throws on any debit, so a
 * charge reached on this path would fail the test rather than pass silently.
 *
 * The stronger guarantee is one a test cannot phrase, so it is recorded here: the
 * assistant is constructed with a single dependency, a `LyricsFormatPort`. It holds no
 * `CreditService`, no debit port and no account id, and it creates no Generation_Job —
 * so there is no route by which enrichment could reach the Requirement 2.2 charging
 * path even if someone tried. The two assertions below pin the observable half; the
 * dependency assertion at the end pins the structural half.
 */

const REQUEST = { caption: 'a caption', lyrics: '[Verse]\nsome words' } as const;

describe('credit invariance during enrichment (Requirement 8.6)', () => {
  it('charges nothing for a successful enrichment', async () => {
    const { assistant } = createLyricsHarness();
    const credits = createFrozenCreditBalance(500);

    const outcome = await assistant.enrich(REQUEST);

    expect(outcome.kind).toBe('proposed');
    expect(credits.balance).toBe(500);
  });

  it('charges nothing for a successful draft', async () => {
    const { assistant } = createLyricsHarness();
    const credits = createFrozenCreditBalance(120);

    expect((await assistant.draft({ topic: 'summer rain' })).kind).toBe('drafted');
    expect(credits.balance).toBe(120);
  });

  it('charges nothing when the engine fails, and refunds nothing either', async () => {
    // Requirement 8.5's path. There is nothing to refund because nothing was charged,
    // which is what makes the invariance total rather than net-zero.
    const { assistant, transport } = createLyricsHarness();
    const credits = createFrozenCreditBalance(9);

    transport.failNext(ACE_FORMAT_INPUT_PATH, 500, 'format_sample failed');
    expect((await assistant.enrich(REQUEST)).kind).toBe('failed');
    expect(credits.balance).toBe(9);
  });

  it('charges nothing when a draft is refused for missing structure', async () => {
    const { assistant, transport } = createLyricsHarness();
    const credits = createFrozenCreditBalance(9);

    transport.setFormattedSample({ caption: 'c', lyrics: '[Verse]\nno chorus here' });
    expect((await assistant.draft({ topic: 't' })).kind).toBe('failed');
    expect(credits.balance).toBe(9);
  });

  it('is built with no dependency that could charge', () => {
    // The structural half of the guarantee: were a credit dependency ever added, this
    // assertion is where it would have to be justified.
    const { assistant } = createLyricsHarness();
    expect(Object.keys(assistant).sort()).toEqual(['draft', 'enrich']);
  });
});
