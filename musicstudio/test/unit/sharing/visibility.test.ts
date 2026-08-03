import { describe, expect, it } from 'vitest';

import { createPlaybackService } from '../../../services/playback/playback-service';
import {
  moderationPublicAssetPort,
  playbackVisibilityPort,
  voiceAssetVisibilityPort,
} from '../../../services/sharing/visibility-adapters';
import { createSharingService } from '../../../services/sharing/sharing-service';
import {
  ASSET_ID,
  OWNER_ID,
  STRANGER_ID,
  inMemoryLikeStore,
  inMemoryShareStore,
  shareableAsset,
} from '../../support/sharing-harness';
import { playbackHarness } from '../../support/playback-harness';

/**
 * The visibility ports three other services declared and this one answers.
 *
 * **Validates: Requirements 12.6, 14.5, 16.8, 26.30, 26.33**
 *
 * The point of these tests is *agreement*. Each of the three ports could be satisfied by its
 * own lookup, and the resulting product would be one where a withheld asset is invisible in
 * the feed, still streamable, and un-reportable — three surfaces, three answers, no single
 * place where the inconsistency is visible. So each test asserts the port and the feed move
 * together.
 */

function sharing(seed = [shareableAsset()]) {
  const assets = inMemoryShareStore(seed, new Map([['voice-1', [ASSET_ID]]]));
  return { assets, service: createSharingService({ assets, likes: inMemoryLikeStore() }) };
}

describe('the playback port (Requirement 12.6)', () => {
  it('refuses a stranger until the asset is published, and again once it is revoked', async () => {
    const { service } = sharing();
    const port = playbackVisibilityPort(service);

    expect(await port.isPubliclyVisible(ASSET_ID)).toBe(false);
    await service.publish({ ownerId: OWNER_ID, assetId: ASSET_ID });
    expect(await port.isPubliclyVisible(ASSET_ID)).toBe(true);
    await service.revoke({ ownerId: OWNER_ID, assetId: ASSET_ID });
    expect(await port.isPubliclyVisible(ASSET_ID)).toBe(false);
  });

  it('closes the stream when a report puts the asset under review (16.9)', async () => {
    // The failure this pairing exists to prevent: hidden from the feed, still streaming.
    const { assets, service } = sharing();
    await service.publish({ ownerId: OWNER_ID, assetId: ASSET_ID });

    const ports = playbackHarness();
    const playback = createPlaybackService({ ...ports, visibility: playbackVisibilityPort(service) });

    await expect(
      playback.stream({ assetId: ASSET_ID, requesterId: STRANGER_ID }),
    ).resolves.toMatchObject({ status: 200 });

    assets.patch(ASSET_ID, { reviewState: 'under_review' });

    expect((await service.feed()).assets).toEqual([]);
    await expect(
      playback.stream({ assetId: ASSET_ID, requesterId: STRANGER_ID }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('the moderation port (Requirement 16.8)', () => {
  it('answers from the snapshot the composition root refreshes', () => {
    const port = moderationPublicAssetPort(new Set([ASSET_ID]));
    expect(port.isPubliclyVisible(ASSET_ID)).toBe(true);
    expect(port.isPubliclyVisible('other')).toBe(false);
  });
});

describe('the voice-consent port (Requirements 26.30, 26.33)', () => {
  it('lists the public assets a profile made, and unpublishes them', async () => {
    const { service } = sharing();
    await service.publish({ ownerId: OWNER_ID, assetId: ASSET_ID });

    const listed = await service.publicAssetIdsForVoiceProfile('voice-1');
    expect(listed).toEqual([ASSET_ID]);

    await service.makePrivateForConsentWithdrawal(listed, 'withdrawal-1');

    expect(await service.isPubliclyVisible(ASSET_ID)).toBe(false);
    expect(await service.publicAssetIdsForVoiceProfile('voice-1')).toEqual([]);
  });

  it('routes a failure to onError rather than leaving an unhandled rejection', async () => {
    // 26.33 has a deadline; a silent failure to unpublish is the one outcome nobody notices.
    const errors: unknown[] = [];
    const failing = {
      isPubliclyVisible: async () => true,
      publicAssetIdsForVoiceProfile: async () => [ASSET_ID],
      makePrivateForConsentWithdrawal: async () => {
        throw new Error('store unavailable');
      },
    };

    const port = voiceAssetVisibilityPort(
      failing,
      { publicAssetIdsFor: () => [ASSET_ID] },
      { onError: (error) => errors.push(error) },
    );

    port.makePrivate([ASSET_ID], 0);
    await new Promise((resolve) => setImmediate(resolve));

    expect(errors).toHaveLength(1);
  });

  it('skips an asset that is already private rather than auditing a non-change', async () => {
    const { service } = sharing();
    await service.makePrivateForConsentWithdrawal([ASSET_ID, 'missing'], 'withdrawal-1');
    expect(await service.isPubliclyVisible(ASSET_ID)).toBe(false);
  });
});
