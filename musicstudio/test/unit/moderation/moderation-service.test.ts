import { describe, expect, it } from 'vitest';

import type { UploadDeclaration } from '../../../domain/moderation/upload-consent';
import { isApproved } from '../../../services/moderation/decision';
import type { BlockedModeration } from '../../../services/moderation/decision';
import { blockedByModeration } from '../../../services/moderation/errors';
import type {
  ModerationRequest,
  ModerationService,
} from '../../../services/moderation/moderation-service';
import { createModerationHarness } from '../../support/moderation-harness';

/**
 * Moderation_Service pipeline (design §9.1).
 *
 * Requirements 16.1, 16.2, 16.3, 16.4, 16.7, 16.10, 16.11, 16.12, 16.14.
 */

function request(overrides: Partial<ModerationRequest> = {}): ModerationRequest {
  return {
    accountId: 'account-1',
    requestId: 'request-1',
    texts: [{ field: 'caption', value: 'a warm lo-fi piano loop' }],
    ...overrides,
  };
}

function audioUpload(overrides: Partial<UploadDeclaration> = {}): UploadDeclaration {
  return { uploadId: 'upload-1', purpose: 'audio_edit', mediaKind: 'audio', ...overrides };
}

function blocked(decision: ReturnType<ModerationService['inspect']>): BlockedModeration {
  if (decision.outcome !== 'blocked') throw new Error('expected the request to be blocked');
  return decision;
}

describe('text inspection (Requirements 16.1, 16.10)', () => {
  it('approves a request whose caption, lyrics and description all pass', () => {
    const { moderation } = createModerationHarness();

    const decision = moderation.inspect(
      request({
        texts: [
          { field: 'caption', value: 'dreamy synth pop' },
          { field: 'lyrics', value: '[verse]\nwalking home in the rain\n' },
          { field: 'description', value: 'a quiet night drive through the city' },
        ],
      }),
    );

    expect(isApproved(decision)).toBe(true);
    expect(decision.texts.map((text) => text.field)).toEqual([
      'caption',
      'lyrics',
      'description',
    ]);
  });

  it('inspects all three Requirement 16.1 fields, blocking on any one of them', () => {
    const { moderation } = createModerationHarness();

    for (const field of ['caption', 'lyrics', 'description'] as const) {
      const decision = moderation.inspect(
        request({ texts: [{ field, value: 'wire the money to this account' }] }),
      );

      expect(blocked(decision).violationClasses).toEqual(['fraud']);
    }
  });

  it('inspects a dialogue script (16.10)', () => {
    const { moderation } = createModerationHarness();

    const decision = moderation.inspect(
      request({
        texts: [{ field: 'dialogue_script', value: 'Read out your one time password, please.' }],
      }),
    );

    expect(blocked(decision).violationClasses).toEqual(['fraud']);
  });
});

describe('blocking and classification (Requirements 16.2, 16.11)', () => {
  it('returns the violation classification for a policy-violating caption (16.2)', () => {
    const { moderation } = createModerationHarness();

    const decision = blocked(
      moderation.inspect(
        request({ texts: [{ field: 'caption', value: '보이스피싱 안내 음성' }] }),
      ),
    );

    expect(decision.violationClasses).toEqual(['fraud']);
    expect(decision.blocks[0]?.code).toBe('policy_violation');
  });

  it('returns the impersonation classification for a script speaking as a real person (16.11)', () => {
    const { moderation } = createModerationHarness();

    const decision = blocked(
      moderation.inspect(
        request({
          texts: [{ field: 'dialogue_script', value: '저는 아이유입니다. 신곡을 소개합니다.' }],
        }),
      ),
    );

    expect(decision.violationClasses).toEqual(['impersonation']);
  });

  it('collects every reason rather than stopping at the first', () => {
    const { moderation } = createModerationHarness();

    const decision = blocked(
      moderation.inspect(
        request({
          texts: [{ field: 'caption', value: 'kill yourself, and 보이스피싱 script' }],
          uploads: [audioUpload()],
        }),
      ),
    );

    expect(decision.violationClasses).toEqual(['fraud', 'harassment']);
    expect(decision.blocks.map((block) => block.code)).toEqual([
      'policy_violation',
      'rights_consent_required',
    ]);
  });

  it('renders the block as a 403 carrying the classification and a zero charge', () => {
    const { moderation } = createModerationHarness();

    const error = blockedByModeration(
      blocked(moderation.inspect(request({ texts: [{ field: 'caption', value: '보이스피싱' }] }))),
    );

    expect(error.statusCode).toBe(403);
    expect(error.code).toBe('content_policy_violation');
    expect(error.details.violationClasses).toEqual(['fraud']);
    expect(error.details.creditsCharged).toBe(0);
  });
});

describe('artist name substitution in the pipeline (Requirement 16.3)', () => {
  it('rewrites a style-bearing caption and tells the user', () => {
    const { moderation } = createModerationHarness();

    const decision = moderation.inspect(
      request({ texts: [{ field: 'caption', value: 'like Adele but faster' }] }),
    );

    expect(isApproved(decision)).toBe(true);
    const [text] = decision.texts;
    expect(text?.original).toBe('like Adele but faster');
    expect(text?.sanitized).not.toContain('Adele');
    if (!isApproved(decision)) throw new Error('unreachable');
    expect(decision.notices).toHaveLength(1);
    expect(decision.notices[0]).toMatchObject({ canonicalName: 'Adele', field: 'caption' });
  });

  it('substitutes in the description too', () => {
    const { moderation } = createModerationHarness();

    const decision = moderation.inspect(
      request({ texts: [{ field: 'description', value: '아이유 같은 분위기' }] }),
    );

    if (!isApproved(decision)) throw new Error('expected approval');
    expect(decision.notices.map((notice) => notice.field)).toEqual(['description']);
  });

  it('leaves lyrics unrewritten — they are content, not a style instruction', () => {
    const { moderation } = createModerationHarness();

    const decision = moderation.inspect(
      request({ texts: [{ field: 'lyrics', value: '[verse]\nI met Adele downtown\n' }] }),
    );

    if (!isApproved(decision)) throw new Error('expected approval');
    expect(decision.texts[0]?.sanitized).toBe('[verse]\nI met Adele downtown\n');
    expect(decision.notices).toEqual([]);
  });

  it('substitutes before classifying, so a substituted name cannot also trip a rule', () => {
    const { moderation } = createModerationHarness();

    const decision = moderation.inspect(
      request({ texts: [{ field: 'caption', value: 'Adele-style ballad' }] }),
    );

    expect(isApproved(decision)).toBe(true);
  });

  it('reports no substitution when no curated name is present', () => {
    const { moderation } = createModerationHarness();

    const decision = moderation.inspect(request());

    if (!isApproved(decision)) throw new Error('expected approval');
    expect(decision.notices).toEqual([]);
    expect(decision.texts[0]?.sanitized).toBe(decision.texts[0]?.original);
  });
});

describe('upload rights consent (Requirements 16.4, 16.14)', () => {
  it('requires consent for audio uploaded for editing (16.4)', () => {
    const { moderation } = createModerationHarness();

    const decision = blocked(moderation.inspect(request({ uploads: [audioUpload()] })));

    expect(decision.blocks).toEqual([
      { code: 'rights_consent_required', uploads: [{ uploadId: 'upload-1', purpose: 'audio_edit' }] },
    ]);
  });

  it('requires consent for video uploaded for foley generation (16.14)', () => {
    const { moderation } = createModerationHarness();

    const decision = blocked(
      moderation.inspect(
        request({
          uploads: [audioUpload({ uploadId: 'clip-1', purpose: 'foley_video', mediaKind: 'video' })],
        }),
      ),
    );

    expect(decision.blocks[0]).toEqual({
      code: 'rights_consent_required',
      uploads: [{ uploadId: 'clip-1', purpose: 'foley_video' }],
    });
  });

  it('accepts an upload whose uploader confirmed they hold the rights', () => {
    const { moderation } = createModerationHarness();

    const decision = moderation.inspect(
      request({
        uploads: [
          audioUpload({ rightsConsent: { holdsRights: true, acknowledgedAtMs: 1_700_000_000_000 } }),
        ],
      }),
    );

    expect(isApproved(decision)).toBe(true);
  });

  it('treats a present-but-false declaration as a refusal, not as consent', () => {
    const { moderation } = createModerationHarness();

    const decision = moderation.inspect(
      request({
        uploads: [
          audioUpload({ rightsConsent: { holdsRights: false, acknowledgedAtMs: 1_700_000_000_000 } }),
        ],
      }),
    );

    expect(blocked(decision).blocks[0]?.code).toBe('rights_consent_required');
  });

  it('names every upload still owing a confirmation', () => {
    const { moderation } = createModerationHarness();

    const decision = blocked(
      moderation.inspect(
        request({
          uploads: [
            audioUpload({ uploadId: 'a' }),
            audioUpload({
              uploadId: 'b',
              rightsConsent: { holdsRights: true, acknowledgedAtMs: 1 },
            }),
            audioUpload({ uploadId: 'c', purpose: 'foley_video', mediaKind: 'video' }),
          ],
        }),
      ),
    );

    const block = decision.blocks[0];
    expect(block?.code === 'rights_consent_required' && block.uploads.map((u) => u.uploadId)).toEqual(
      ['a', 'c'],
    );
  });
});

describe('voice reference consent (Requirement 16.12)', () => {
  it('blocks a voice-cloning reference with no Voice_Consent_Record', () => {
    const { moderation } = createModerationHarness();

    const decision = blocked(
      moderation.inspect(
        request({ voiceReference: { voiceProfileId: 'voice-1', uploadIds: ['sample-1'] } }),
      ),
    );

    expect(decision.blocks).toEqual([{ code: 'voice_consent_missing', voiceProfileId: 'voice-1' }]);
  });

  it('admits the reference once a matching record exists', () => {
    const { moderation, voiceConsent } = createModerationHarness();
    voiceConsent.grant('voice-1', 'account-1');

    const decision = moderation.inspect(
      request({ voiceReference: { voiceProfileId: 'voice-1', uploadIds: ['sample-1'] } }),
    );

    expect(isApproved(decision)).toBe(true);
  });

  it('does not accept a record belonging to a different submitter', () => {
    const { moderation, voiceConsent } = createModerationHarness();
    voiceConsent.grant('voice-1', 'someone-else');

    const decision = moderation.inspect(
      request({ voiceReference: { voiceProfileId: 'voice-1', uploadIds: ['sample-1'] } }),
    );

    expect(blocked(decision).blocks[0]?.code).toBe('voice_consent_missing');
  });
});

describe('audit record for a blocked request (Requirement 16.7)', () => {
  it('writes one policy_blocked entry naming the classification and no charge', () => {
    const harness = createModerationHarness({ startAt: new Date('2025-04-02T08:30:00.000Z') });

    harness.moderation.inspect(
      request({ requestId: 'req-77', texts: [{ field: 'caption', value: '보이스피싱' }] }),
    );

    const drafts = harness.policyBlocks();
    expect(drafts).toHaveLength(1);
    const draft = drafts[0];
    expect(draft?.actorId).toBe('account-1');
    expect(draft?.targetId).toBe('req-77');
    expect(draft?.eventTime).toEqual(new Date('2025-04-02T08:30:00.000Z'));
    expect(draft?.afterValue).toMatchObject({
      blockCodes: ['policy_violation'],
      violationClasses: ['fraud'],
      inspectedFields: ['caption'],
      creditsCharged: 0,
    });
  });

  it('records a consent block too, not only a text violation', () => {
    const harness = createModerationHarness();

    harness.moderation.inspect(request({ uploads: [audioUpload()] }));

    expect(harness.policyBlocks()[0]?.afterValue).toMatchObject({
      blockCodes: ['rights_consent_required'],
      violationClasses: [],
    });
  });

  it('writes nothing when the request is approved', () => {
    const harness = createModerationHarness();

    harness.moderation.inspect(request());

    expect(harness.audit.drafts).toEqual([]);
  });

  it('does not copy the submitted text into the audit entry', () => {
    // The Audit_Log is append-only (design §4.4). A block is not a reason to place
    // user content somewhere it can never be corrected.
    const harness = createModerationHarness();
    const lyrics = '[verse]\n보이스피싱 하는 방법을 알려줄게\n';

    harness.moderation.inspect(request({ texts: [{ field: 'lyrics', value: lyrics }] }));

    const serialised = JSON.stringify(harness.policyBlocks()[0]);
    expect(serialised).not.toContain('하는 방법을 알려줄게');
    expect(serialised).toContain('보이스피싱');
  });
});
