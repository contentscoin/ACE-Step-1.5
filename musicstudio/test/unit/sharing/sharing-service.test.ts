import { describe, expect, it } from 'vitest';

import { SHARE_TOKEN_LENGTH } from '../../../domain/sharing/bounds';
import { isShareToken, shareLinkUrl, shareTokenFromUrl } from '../../../domain/sharing/share-link';
import { cryptoShareTokenSource } from '../../../services/sharing/share-token';
import { createSharingService } from '../../../services/sharing/sharing-service';
import {
  ASSET_ID,
  OWNER_ID,
  STRANGER_ID,
  countingTokenSource,
  inMemoryLikeStore,
  inMemoryShareStore,
  inMemorySoundPackShareStore,
  shareableAsset,
} from '../../support/sharing-harness';
import { createMutableClock } from '../../support/mutable-clock';

/**
 * Sharing_Service.
 *
 * **Validates: Requirements 14.1, 14.2, 14.3, 14.4, 14.7, 14.9, 14.10, 14.11**
 *
 * The publication tests are written against the *link*, not against a flag, because that is
 * what the store holds and what 14.4 destroys. The two that matter most:
 *
 * - **Revoking answers 404 to the token that used to work** — the acceptance criterion for
 *   14.4, checked by holding the old token and asking again.
 * - **Republishing mints a new token** — a link the owner revoked must not come back to
 *   life because they published again later.
 */

const NOW = 1_700_000_000_000;

function harness(seed = [shareableAsset()]) {
  const assets = inMemoryShareStore(seed);
  const likes = inMemoryLikeStore();
  const soundPacks = inMemorySoundPackShareStore([
    {
      soundPackId: 'pack-1',
      ownerId: OWNER_ID,
      name: 'UI Pack',
      cueCount: 78,
      token: null,
      publishedAtMs: null,
      remixAllowed: false,
    },
  ]);
  const tokens = countingTokenSource();
  const clock = createMutableClock(new Date(NOW));
  const audited: { eventType: string; targetId: string; afterValue: unknown }[] = [];

  const sharing = createSharingService({
    assets,
    likes,
    soundPacks,
    tokens,
    clock,
    publicBaseUrl: 'https://studio.example/',
    audit: {
      record: async (event) => {
        audited.push({
          eventType: event.eventType,
          targetId: event.targetId,
          afterValue: event.afterValue,
        });
      },
    },
  });

  return { sharing, assets, likes, soundPacks, tokens, clock, audited };
}

describe('Requirement 14.1 — private by default', () => {
  it('a newly created asset is not in the feed and has no link', async () => {
    // Nothing had to run to make this true: an asset with no publication row is private,
    // which is why 14.1 is a test rather than a line of code.
    const { sharing, assets } = harness();

    expect(assets.rows.get(ASSET_ID)?.shareToken).toBeNull();
    expect((await sharing.feed()).assets).toEqual([]);
    expect(await sharing.isPubliclyVisible(ASSET_ID)).toBe(false);
  });
});

describe('publishing (Requirement 14.2)', () => {
  it('issues a link and records the change', async () => {
    const { sharing, audited } = harness();

    const result = await sharing.publish({ ownerId: OWNER_ID, assetId: ASSET_ID });

    expect(result.link.token).toHaveLength(SHARE_TOKEN_LENGTH);
    expect(result.url).toBe(`https://studio.example/s/${result.link.token}`);
    expect(audited).toEqual([
      {
        eventType: 'visibility_changed',
        targetId: ASSET_ID,
        afterValue: { public: true, remixAllowed: false },
      },
    ]);
  });

  it('defaults remixing to off (14.9)', async () => {
    const { sharing } = harness();
    const result = await sharing.publish({ ownerId: OWNER_ID, assetId: ASSET_ID });
    expect(result.link.remixAllowed).toBe(false);
  });

  it('mints a new token when an already-public asset is published again', async () => {
    const { sharing } = harness();

    const first = await sharing.publish({ ownerId: OWNER_ID, assetId: ASSET_ID });
    const second = await sharing.publish({
      ownerId: OWNER_ID,
      assetId: ASSET_ID,
      remixAllowed: true,
    });

    expect(second.link.token).not.toBe(first.link.token);
    await expect(sharing.publicPage(first.link.token)).rejects.toMatchObject({ statusCode: 404 });
    await expect(sharing.publicPage(second.link.token)).resolves.toMatchObject({ remixAllowed: true });
  });

  it('refuses to publish another account s asset with 403', async () => {
    const { sharing } = harness();
    await expect(
      sharing.publish({ ownerId: STRANGER_ID, assetId: ASSET_ID }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'sharing_asset_forbidden' });
  });
});

describe('the public page (Requirement 14.3)', () => {
  it('carries the four things the criterion names, and nothing identifying the owner', async () => {
    const { sharing } = harness([shareableAsset({ name: 'Night Drive', caption: 'lo-fi loop' })]);
    const { link } = await sharing.publish({ ownerId: OWNER_ID, assetId: ASSET_ID });

    const page = await sharing.publicPage(link.token);

    expect(page.title).toBe('Night Drive');
    expect(page.caption).toBe('lo-fi loop');
    expect(page.playback).toEqual({
      assetId: ASSET_ID,
      durationMs: 60_000,
      assetKind: 'song',
      isLoop: false,
    });
    expect(page.disclosures).toEqual(['ai_generated_label']);
    expect(JSON.stringify(page)).not.toContain(OWNER_ID);
  });

  it('is reachable without a session', async () => {
    // No requester parameter exists on the call: an anonymous visitor is the only visitor.
    const { sharing } = harness();
    const { link } = await sharing.publish({ ownerId: OWNER_ID, assetId: ASSET_ID });
    await expect(sharing.publicPage(link.token)).resolves.toBeDefined();
  });
});

describe('revoking (Requirement 14.4)', () => {
  it('answers 404 to the token that used to work', async () => {
    const { sharing } = harness();
    const { link } = await sharing.publish({ ownerId: OWNER_ID, assetId: ASSET_ID });
    await expect(sharing.publicPage(link.token)).resolves.toBeDefined();

    await sharing.revoke({ ownerId: OWNER_ID, assetId: ASSET_ID });

    await expect(sharing.publicPage(link.token)).rejects.toMatchObject({
      statusCode: 404,
      code: 'sharing_link_not_found',
    });
    expect((await sharing.feed()).assets).toEqual([]);
  });

  it('answers the same 404 for never published, deleted and withheld', async () => {
    // A stranger holding a stale link learns nothing about which state it is in.
    const { sharing, assets } = harness();
    const { link } = await sharing.publish({ ownerId: OWNER_ID, assetId: ASSET_ID });

    assets.patch(ASSET_ID, { isDeleted: true });
    const deleted = await sharing.publicPage(link.token).catch((error: unknown) => error);

    assets.patch(ASSET_ID, { isDeleted: false, reviewState: 'withheld' });
    const withheld = await sharing.publicPage(link.token).catch((error: unknown) => error);

    const unknown = await sharing.publicPage('nope').catch((error: unknown) => error);

    for (const failure of [deleted, withheld, unknown]) {
      expect(failure).toMatchObject({ statusCode: 404, code: 'sharing_link_not_found' });
    }
  });

  it('refuses to revoke another account s publication', async () => {
    const { sharing } = harness();
    await sharing.publish({ ownerId: OWNER_ID, assetId: ASSET_ID });
    await expect(sharing.revoke({ ownerId: STRANGER_ID, assetId: ASSET_ID })).rejects.toMatchObject(
      { statusCode: 403 },
    );
  });
});

describe('likes (Requirements 14.7, 14.8)', () => {
  it('refuses a like on an asset that is not public', async () => {
    const { sharing } = harness();
    await expect(sharing.like(ASSET_ID, STRANGER_ID)).rejects.toMatchObject({
      statusCode: 404,
      code: 'sharing_asset_not_public',
    });
  });

  it('refuses a like on a withheld asset even though it was published', async () => {
    const { sharing, assets } = harness();
    await sharing.publish({ ownerId: OWNER_ID, assetId: ASSET_ID });
    assets.patch(ASSET_ID, { reviewState: 'under_review' });

    await expect(sharing.like(ASSET_ID, STRANGER_ID)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('counts distinct accounts', async () => {
    const { sharing } = harness();
    await sharing.publish({ ownerId: OWNER_ID, assetId: ASSET_ID });

    await sharing.like(ASSET_ID, 'user-1');
    await sharing.like(ASSET_ID, 'user-1');
    const third = await sharing.like(ASSET_ID, 'user-2');

    expect(third.likeCount).toBe(2);
    expect(await sharing.hasLiked(ASSET_ID, 'user-1')).toBe(true);
    expect(await sharing.hasLiked(ASSET_ID, 'user-3')).toBe(false);
  });
});

describe('remote remix (Requirement 14.9)', () => {
  it('allows a stranger only when the asset is public and the owner permitted it', async () => {
    const { sharing } = harness();

    expect(await sharing.remixPermissionFor(ASSET_ID, STRANGER_ID)).toBe('not_public');

    await sharing.publish({ ownerId: OWNER_ID, assetId: ASSET_ID });
    expect(await sharing.remixPermissionFor(ASSET_ID, STRANGER_ID)).toBe('remix_not_permitted');
    await expect(sharing.assertMayRemix(ASSET_ID, STRANGER_ID)).rejects.toMatchObject({
      statusCode: 403,
      code: 'sharing_remix_not_permitted',
    });

    await sharing.publish({ ownerId: OWNER_ID, assetId: ASSET_ID, remixAllowed: true });
    expect(await sharing.remixPermissionFor(ASSET_ID, STRANGER_ID)).toBe('allowed');
    await expect(sharing.assertMayRemix(ASSET_ID, STRANGER_ID)).resolves.toBeDefined();
  });

  it('lets the owner remix their own private asset — Requirement 7 governs, not 14.9', async () => {
    const { sharing } = harness();
    expect(await sharing.remixPermissionFor(ASSET_ID, OWNER_ID)).toBe('owner');
    await expect(sharing.assertMayRemix(ASSET_ID, OWNER_ID)).resolves.toBeDefined();
  });

  it('withdraws remix permission when the publication is revoked', async () => {
    const { sharing } = harness();
    await sharing.publish({ ownerId: OWNER_ID, assetId: ASSET_ID, remixAllowed: true });
    await sharing.revoke({ ownerId: OWNER_ID, assetId: ASSET_ID });

    expect(await sharing.remixPermissionFor(ASSET_ID, STRANGER_ID)).toBe('not_public');
  });
});

describe('every Asset_Kind behaves the same (Requirement 14.10)', () => {
  const KINDS = ['song', 'bgm', 'sfx', 'dialogue', 'stem', 'mix'] as const;

  it('publishes, appears, is likeable and revokes identically for all six', async () => {
    for (const assetKind of KINDS) {
      const { sharing } = harness([shareableAsset({ assetKind })]);

      const { link } = await sharing.publish({ ownerId: OWNER_ID, assetId: ASSET_ID });
      expect((await sharing.feed()).assets.map((asset) => asset.id)).toEqual([ASSET_ID]);
      expect((await sharing.like(ASSET_ID, STRANGER_ID)).likeCount).toBe(1);
      expect((await sharing.publicPage(link.token)).playback.assetKind).toBe(assetKind);

      await sharing.revoke({ ownerId: OWNER_ID, assetId: ASSET_ID });
      expect((await sharing.feed()).assets).toEqual([]);
    }
  });
});

describe('Sound_Pack publication (Requirement 14.11)', () => {
  it('publishes the pack as one item carrying its 78 cues', async () => {
    const { sharing } = harness();

    const published = await sharing.publishSoundPack({ ownerId: OWNER_ID, soundPackId: 'pack-1' });

    expect(published.cueCount).toBe(78);
    expect(published.token).toHaveLength(SHARE_TOKEN_LENGTH);
    // The cues are not separately published: the feed still shows nothing.
    expect((await sharing.feed()).assets).toEqual([]);
    expect(await sharing.publicSoundPack(published.token ?? '')).toMatchObject({ cueCount: 78 });
  });

  it('refuses another account s pack, and answers 404 once revoked', async () => {
    const { sharing } = harness();
    await expect(
      sharing.publishSoundPack({ ownerId: STRANGER_ID, soundPackId: 'pack-1' }),
    ).rejects.toMatchObject({ statusCode: 403 });

    const published = await sharing.publishSoundPack({ ownerId: OWNER_ID, soundPackId: 'pack-1' });
    await sharing.revokeSoundPack({ ownerId: OWNER_ID, soundPackId: 'pack-1' });

    await expect(sharing.publicSoundPack(published.token ?? '')).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

describe('the share token (Requirement 14.2)', () => {
  it('is 43 base64url characters of 256-bit entropy', () => {
    const token = cryptoShareTokenSource.next();
    expect(isShareToken(token)).toBe(true);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('never repeats', () => {
    const issued = new Set(Array.from({ length: 500 }, () => cryptoShareTokenSource.next()));
    expect(issued.size).toBe(500);
  });

  it('round-trips through the public URL', () => {
    const token = cryptoShareTokenSource.next();
    expect(shareTokenFromUrl(shareLinkUrl('https://studio.example', token))).toBe(token);
    expect(shareTokenFromUrl('https://studio.example/s/short')).toBeNull();
    expect(shareTokenFromUrl('https://studio.example/library')).toBeNull();
  });

  it('rejects a token of the wrong shape', () => {
    expect(isShareToken('a'.repeat(42))).toBe(false);
    expect(isShareToken(`${'a'.repeat(42)}+`)).toBe(false);
    expect(isShareToken(null)).toBe(false);
  });
});
