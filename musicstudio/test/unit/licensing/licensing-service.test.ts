import { describe, expect, it } from 'vitest';

import { createLicensingService } from '../../../services/licensing/licensing-service';
import { GenerationError } from '../../../services/generation/errors';
import {
  assetRecord,
  createAuditSink,
  createEngineCatalogue,
  createLicensingStore,
  createLineagePort,
  createNotificationRecorder,
  createRegenerationRecorder,
  fixedClock,
  provenance,
} from '../../support/licensing-harness';

/**
 * Licensing_Service.
 *
 * **Validates: Requirements 33.9, 33.10, 33.11, 33.15, 33.16, 33.17, 33.19, 33.23, 33.24**
 *
 * The cases here are the ones where the requirement says something a reasonable implementation
 * would get wrong: that a refusal is *audited before it throws*, that the ruling reads the
 * asset's stored flag rather than the engine's current one, that a licence change notifies each
 * owner once rather than once per asset, and that credits are attached to a non-commercial
 * download too.
 */

const NOW = 1_700_000_100_000;

function build(options: {
  readonly records?: Parameters<typeof createLicensingStore>[0];
  readonly edges?: Parameters<typeof createLineagePort>[0];
  readonly engines?: Parameters<typeof createEngineCatalogue>[0];
} = {}) {
  const store = createLicensingStore(options.records ?? [assetRecord('asset-1')]);
  const audit = createAuditSink();
  const notifications = createNotificationRecorder();
  const regeneration = createRegenerationRecorder();
  const { clock } = fixedClock(NOW);

  const service = createLicensingService({
    assets: store,
    lineage: createLineagePort(options.edges ?? []),
    engines: createEngineCatalogue(
      options.engines ?? [
        { engineId: 'ace-step-1.5', supportedAssetKinds: ['song'], commercialUseAllowed: true },
      ],
    ),
    audit: audit.port,
    clock,
    notifications: notifications.port,
    regeneration: regeneration.port,
  });

  return { service, store, audit, notifications, regeneration };
}

describe('the commercial gate (Reqs 33.11, 33.19, 33.23)', () => {
  it('allows a non_commercial request against a non-commercial asset', async () => {
    const { service } = build({
      records: [assetRecord('asset-1', { commercialUseAllowed: false })],
    });

    const outcome = await service.assertCommercialUseAllowed('owner-1', 'asset-1', undefined);

    // Requirement 33.19's default, and the gate is about `commercial` only.
    expect(outcome.usagePurpose).toBe('non_commercial');
    expect(outcome.ruling.allowed).toBe(true);
  });

  it('refuses a commercial request and names the licence and the alternatives', async () => {
    const { service } = build({
      records: [
        assetRecord('asset-1', {
          commercialUseAllowed: false,
          // The provenance says so too: the stored flag is a fold over this and the
          // lineage (`domain/commercial-use.ts`), and a record whose flag is false with
          // every licence in reach permitting commercial use is not a state the product
          // can reach. The deciding licences are read from provenance, so a fixture that
          // disagreed with itself would be asserting on an impossible asset.
          provenance: provenance({ weightLicenseId: 'cc-by-nc-4.0', commercialUseAllowed: false }),
        }),
      ],
      engines: [
        { engineId: 'zeta', supportedAssetKinds: ['song'], commercialUseAllowed: true },
        { engineId: 'alpha', supportedAssetKinds: ['song'], commercialUseAllowed: true },
        { engineId: 'nope', supportedAssetKinds: ['song'], commercialUseAllowed: false },
        { engineId: 'other-kind', supportedAssetKinds: ['sfx'], commercialUseAllowed: true },
      ],
    });

    const error = await service
      .assertCommercialUseAllowed('owner-1', 'asset-1', 'commercial')
      .then(() => null)
      .catch((thrown: unknown) => thrown as GenerationError);

    expect(error).toBeInstanceOf(GenerationError);
    expect(error?.statusCode).toBe(403);
    expect(error?.code).toBe('commercial_use_not_permitted');
    expect(error?.details.decidingLicenseIds).toEqual(['cc-by-nc-4.0']);
    // Only engines that permit it *and* support this kind, sorted so two refusals agree.
    expect(error?.details.alternativeEngineIds).toEqual(['alpha', 'zeta']);
  });

  it('writes the audit record before throwing (Req 33.23)', async () => {
    const { service, audit } = build({
      records: [assetRecord('asset-1', { commercialUseAllowed: false })],
    });

    await service
      .assertCommercialUseAllowed('account-9', 'asset-1', 'commercial')
      .catch(() => undefined);

    // The record exists even though the call threw — an audit written by the caller after
    // catching would be an audit that depends on the caller remembering.
    expect(audit.drafts).toHaveLength(1);
    const draft = audit.drafts[0];
    expect(draft?.eventType).toBe('commercial_use_denied');
    expect(draft?.actorId).toBe('account-9');
    expect(draft?.targetId).toBe('asset-1');
    expect(draft?.eventTime?.getTime()).toBe(NOW);
  });

  it('does not audit an allowed request', async () => {
    const { service, audit } = build();
    await service.assertCommercialUseAllowed('owner-1', 'asset-1', 'commercial');
    expect(audit.drafts).toHaveLength(0);
  });

  it('judges by the asset’s stored flag, not the engine’s current one (Req 33.17)', async () => {
    // The asset was made when the engine permitted it, and the engine has since flipped.
    const { service } = build({
      records: [
        assetRecord('asset-1', {
          commercialUseAllowed: true,
          provenance: provenance({ engineId: 'flipped', commercialUseAllowed: true }),
        }),
      ],
      engines: [
        { engineId: 'flipped', supportedAssetKinds: ['song'], commercialUseAllowed: false },
      ],
    });

    // Still allowed. Re-deriving from the catalogue would apply the change retroactively to
    // work the user has already delivered.
    const outcome = await service.assertCommercialUseAllowed('owner-1', 'asset-1', 'commercial');
    expect(outcome.ruling.allowed).toBe(true);
  });
});

describe('attribution (Reqs 33.9, 33.15)', () => {
  it('covers the asset and its ancestors, one entry each', async () => {
    const { service } = build({
      records: [
        assetRecord('asset-child', { provenance: provenance({ engineId: 'child-engine' }) }),
        assetRecord('asset-parent', { provenance: provenance({ engineId: 'parent-engine' }) }),
        assetRecord('asset-grandparent', {
          provenance: provenance({ engineId: 'gp-engine', attributionText: 'none' }),
        }),
      ],
      edges: [
        { childAssetId: 'asset-child', parentAssetId: 'asset-parent', derivationType: 'effect_apply' },
        {
          childAssetId: 'asset-parent',
          parentAssetId: 'asset-grandparent',
          derivationType: 'effect_apply',
        },
      ],
    });

    const file = await service.attributionFileFor('asset-child');

    expect(file.fileName).toBe('CREDITS-asset-child.txt');
    expect(file.manifest.entries.map((entry) => entry.assetId)).toEqual([
      'asset-child',
      'asset-grandparent',
      'asset-parent',
    ]);
    expect(file.manifest.entries[0]?.isSubject).toBe(true);
    // Every engine is named in the text a user forwards to a client.
    for (const engineId of ['child-engine', 'parent-engine', 'gp-engine']) {
      expect(file.text).toContain(engineId);
    }
    // A source needing no attribution still gets a line, saying so.
    expect(file.text).toContain('표시 요구 없음');
  });

  it('records an ancestor whose provenance is missing rather than dropping it', async () => {
    const { service } = build({
      records: [assetRecord('asset-child')],
      edges: [
        { childAssetId: 'asset-child', parentAssetId: 'asset-gone', derivationType: 'effect_apply' },
      ],
    });

    const file = await service.attributionFileFor('asset-child');

    // A short credits file is worse than one that says a line is missing: the user cannot tell.
    expect(file.manifest.entries.map((entry) => entry.assetId)).toContain('asset-gone');
    expect(file.text).toContain('(출처 정보 없음)');
  });

  it('exports a machine-readable document (Req 33.15)', async () => {
    const { service } = build();
    const exported = await service.exportProvenance('asset-1');

    expect(exported.formatVersion).toBe(1);
    expect(exported.subjectAssetId).toBe('asset-1');
    expect(exported.exportedAtMs).toBe(NOW);
    expect(exported.assets[0]).toMatchObject({
      assetId: 'asset-1',
      engineId: 'ace-step-1.5',
      licenseId: 'apache-2.0',
      commercialUseAllowed: true,
    });
  });
});

describe('the non-commercial notice (Req 33.10)', () => {
  it('refuses a request that did not confirm it', () => {
    const { service } = build();
    expect(() =>
      service.assertNonCommercialNoticeConfirmed({
        engineId: 'nc-engine',
        engineCommercialUseAllowed: false,
        userConfirmedNonCommercialNotice: false,
      }),
    ).toThrow(/non-commercial|notice/i);
  });

  it('accepts once confirmed, and never asks for a commercial engine', () => {
    const { service } = build();
    expect(() =>
      service.assertNonCommercialNoticeConfirmed({
        engineId: 'nc-engine',
        engineCommercialUseAllowed: false,
        userConfirmedNonCommercialNotice: true,
      }),
    ).not.toThrow();
    expect(() =>
      service.assertNonCommercialNoticeConfirmed({
        engineId: 'ok-engine',
        engineCommercialUseAllowed: true,
        userConfirmedNonCommercialNotice: false,
      }),
    ).not.toThrow();
  });
});

describe('a licence change (Reqs 33.16, 33.17)', () => {
  it('audits every change', async () => {
    const { service, audit } = build();

    await service.recordLicenseChange({
      engineId: 'ace-step-1.5',
      actorId: 'operator-1',
      before: { commercialUseAllowed: true },
      after: { commercialUseAllowed: true, attributionText: 'ACE-Step 1.5' },
    });

    expect(audit.drafts[0]?.eventType).toBe('license_changed');
    expect(audit.drafts[0]?.beforeValue).toEqual({ commercialUseAllowed: true });
    expect(audit.drafts[0]?.eventTime?.getTime()).toBe(NOW);
  });

  it('notifies each owner once with their own count when permission is revoked', async () => {
    const { service, notifications } = build({
      records: [
        assetRecord('a', { ownerId: 'owner-1', provenance: provenance({ engineId: 'e1' }) }),
        assetRecord('b', { ownerId: 'owner-1', provenance: provenance({ engineId: 'e1' }) }),
        assetRecord('c', { ownerId: 'owner-2', provenance: provenance({ engineId: 'e1' }) }),
        assetRecord('d', { ownerId: 'owner-3', provenance: provenance({ engineId: 'other' }) }),
      ],
    });

    const outcome = await service.recordLicenseChange({
      engineId: 'e1',
      actorId: 'operator-1',
      before: { commercialUseAllowed: true },
      after: { commercialUseAllowed: false },
    });

    // One message per owner, not per asset — a prolific account would otherwise get a mailbox.
    expect(notifications.sent).toHaveLength(2);
    expect(notifications.sent.find((sent) => sent.ownerId === 'owner-1')?.affectedAssetCount).toBe(2);
    expect(notifications.sent.find((sent) => sent.ownerId === 'owner-2')?.affectedAssetCount).toBe(1);
    // The owner of an asset from a different engine is untouched.
    expect(notifications.sent.map((sent) => sent.ownerId)).not.toContain('owner-3');
    expect(outcome.affectedAssets).toBe(3);
  });

  it('leaves the stored flags alone, which is what 33.17 judges by', async () => {
    const { service, store } = build({
      records: [
        assetRecord('a', { commercialUseAllowed: true, provenance: provenance({ engineId: 'e1' }) }),
      ],
    });

    await service.recordLicenseChange({
      engineId: 'e1',
      actorId: 'operator-1',
      before: { commercialUseAllowed: true },
      after: { commercialUseAllowed: false },
    });

    // A well-meaning migration that flipped this would destroy the evidence the clause needs.
    expect((await store.find('a'))?.commercialUseAllowed).toBe(true);
    const outcome = await service.assertCommercialUseAllowed('owner-1', 'a', 'commercial');
    expect(outcome.ruling.allowed).toBe(true);
  });

  it('does not notify when permission was not revoked', async () => {
    const { service, notifications } = build();
    await service.recordLicenseChange({
      engineId: 'ace-step-1.5',
      actorId: 'operator-1',
      before: { commercialUseAllowed: false },
      after: { commercialUseAllowed: true },
    });
    expect(notifications.sent).toHaveLength(0);
  });
});

describe('regeneration (Req 33.24)', () => {
  it('submits a new job with the original parameters and a permitted engine', async () => {
    const { service, regeneration } = build({
      records: [
        assetRecord('asset-1', {
          commercialUseAllowed: false,
          generationParameters: { description: '로파이', durationSeconds: 90 },
        }),
      ],
      engines: [
        { engineId: 'zeta', supportedAssetKinds: ['song'], commercialUseAllowed: true },
        { engineId: 'alpha', supportedAssetKinds: ['song'], commercialUseAllowed: true },
      ],
    });

    const outcome = await service.regenerateForCommercialUse('owner-1', 'asset-1');

    expect(outcome.engineId).toBe('alpha');
    expect(regeneration.submitted[0]).toMatchObject({
      engineId: 'alpha',
      assetKind: 'song',
      regeneratedFromAssetId: 'asset-1',
      parameters: { description: '로파이', durationSeconds: 90 },
    });
  });

  it('refuses when nothing registered for the kind permits commercial use', async () => {
    const { service } = build({
      records: [assetRecord('asset-1', { commercialUseAllowed: false })],
      engines: [{ engineId: 'nc', supportedAssetKinds: ['song'], commercialUseAllowed: false }],
    });

    await expect(service.regenerateForCommercialUse('owner-1', 'asset-1')).rejects.toThrow(
      /no registered engine/i,
    );
  });
});
