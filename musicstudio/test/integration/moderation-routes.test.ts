import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createGatewayHarness,
  requireModeration,
  type GatewayHarness,
} from '../support/gateway-harness';

/**
 * Report intake -> under review -> excluded from the discovery feed
 * (Requirements 16.8, 16.9), through the real gateway.
 *
 * The discovery feed itself is Sharing_Service (task 5.3). What is asserted here is
 * the state and the predicate 5.3 consumes: after a report the asset is
 * `under_review` and `excludedFromDiscoveryFeed` is true.
 */

const PUBLIC_ASSET = '11111111-1111-4111-8111-111111111111';
const PRIVATE_ASSET = '22222222-2222-4222-8222-222222222222';

let harness: GatewayHarness;

async function signIn(): Promise<string> {
  await harness.app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email: 'operator@example.com', password: 'correct-horse-battery-staple' },
  });
  const login = await harness.app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email: 'operator@example.com', password: 'correct-horse-battery-staple' },
  });
  const body = login.json<{ accessToken: string }>();
  return body.accessToken;
}

beforeEach(() => {
  harness = createGatewayHarness({ moderation: { publishedAssetIds: [PUBLIC_ASSET] } });
});

afterEach(async () => {
  await harness.close();
});

describe('report intake (Requirement 16.8)', () => {
  it('accepts a visitor report and marks the asset under review', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: `/v1/assets/${PUBLIC_ASSET}/reports`,
      payload: { reason: 'policy_violation', detail: 'the lyrics threaten a named person' },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      reportId: 'report-1',
      assetId: PUBLIC_ASSET,
      reason: 'policy_violation',
      reviewState: 'under_review',
      excludedFromDiscoveryFeed: true,
      openReportCount: 1,
    });
  });

  it('needs no session — Requirement 16.8 says 방문자', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: `/v1/assets/${PUBLIC_ASSET}/reports`,
      payload: { reason: 'other' },
    });

    expect(response.statusCode).toBe(202);
    expect(requireModeration(harness).store.all[0]?.reporterAccountId).toBeNull();
  });

  it('answers 404 for an asset that is not publicly visible, leaking nothing', async () => {
    const privateResponse = await harness.app.inject({
      method: 'POST',
      url: `/v1/assets/${PRIVATE_ASSET}/reports`,
      payload: { reason: 'policy_violation' },
    });
    const unknownResponse = await harness.app.inject({
      method: 'POST',
      url: '/v1/assets/33333333-3333-4333-8333-333333333333/reports',
      payload: { reason: 'policy_violation' },
    });

    // Identical status, code and message: a private asset is indistinguishable from
    // one that does not exist. Only the echoed id differs, which the caller supplied.
    expect(privateResponse.statusCode).toBe(404);
    expect(unknownResponse.statusCode).toBe(404);
    expect(privateResponse.json().error.code).toBe('asset_not_found');
    expect(privateResponse.json().error.message).toBe(unknownResponse.json().error.message);
  });

  it('rejects an unknown reason through the schema', async () => {
    const response = await harness.app.inject({
      method: 'POST',
      url: `/v1/assets/${PUBLIC_ASSET}/reports`,
      payload: { reason: 'i-do-not-like-it' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('validation_failed');
  });

  it('accumulates repeated reports while staying under review', async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await harness.app.inject({
        method: 'POST',
        url: `/v1/assets/${PUBLIC_ASSET}/reports`,
        payload: { reason: 'impersonation' },
      });
    }

    const last = await harness.app.inject({
      method: 'POST',
      url: `/v1/assets/${PUBLIC_ASSET}/reports`,
      payload: { reason: 'impersonation' },
    });

    expect(last.json()).toMatchObject({
      reviewState: 'under_review',
      excludedFromDiscoveryFeed: true,
      openReportCount: 4,
    });
  });
});

describe('review state and feed exclusion (Requirement 16.9)', () => {
  it('reports the asset as excluded for as long as the review is open', async () => {
    const token = await signIn();
    await harness.app.inject({
      method: 'POST',
      url: `/v1/assets/${PUBLIC_ASSET}/reports`,
      payload: { reason: 'policy_violation' },
    });

    const response = await harness.app.inject({
      method: 'GET',
      url: `/v1/assets/${PUBLIC_ASSET}/review-state`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      reviewState: 'under_review',
      excludedFromDiscoveryFeed: true,
    });
    // The same fact through the in-process seam task 5.3 will use.
    expect(requireModeration(harness).reports.isExcludedFromDiscoveryFeed(PUBLIC_ASSET)).toBe(true);
  });

  it('restores the asset to the feed when an operator clears the review', async () => {
    const token = await signIn();
    await harness.app.inject({
      method: 'POST',
      url: `/v1/assets/${PUBLIC_ASSET}/reports`,
      payload: { reason: 'other' },
    });

    const resolution = await harness.app.inject({
      method: 'POST',
      url: `/v1/assets/${PUBLIC_ASSET}/review-resolution`,
      headers: { authorization: `Bearer ${token}` },
      payload: { resolution: 'cleared' },
    });

    expect(resolution.json()).toMatchObject({
      reviewState: 'cleared',
      excludedFromDiscoveryFeed: false,
    });
  });

  it('keeps a withheld asset out of the feed', async () => {
    const token = await signIn();
    await harness.app.inject({
      method: 'POST',
      url: `/v1/assets/${PUBLIC_ASSET}/reports`,
      payload: { reason: 'rights_infringement' },
    });

    const resolution = await harness.app.inject({
      method: 'POST',
      url: `/v1/assets/${PUBLIC_ASSET}/review-resolution`,
      headers: { authorization: `Bearer ${token}` },
      payload: { resolution: 'withheld' },
    });

    expect(resolution.json()).toMatchObject({
      reviewState: 'withheld',
      excludedFromDiscoveryFeed: true,
    });

    // A further report must not resurrect it into the queue.
    const again = await harness.app.inject({
      method: 'POST',
      url: `/v1/assets/${PUBLIC_ASSET}/reports`,
      payload: { reason: 'other' },
    });
    expect(again.json().reviewState).toBe('withheld');
  });

  it('refuses to resolve an asset with no open review', async () => {
    const token = await signIn();

    const response = await harness.app.inject({
      method: 'POST',
      url: `/v1/assets/${PUBLIC_ASSET}/review-resolution`,
      headers: { authorization: `Bearer ${token}` },
      payload: { resolution: 'cleared' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('review_not_open');
  });

  it('answers 404 for an asset that has never been reported', async () => {
    // There is no review to report on, and answering `none` would assert that the
    // asset exists — which this route has no business confirming.
    const token = await signIn();

    const response = await harness.app.inject({
      method: 'GET',
      url: `/v1/assets/${PUBLIC_ASSET}/review-state`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('asset_not_found');
  });

  it('requires a session on the review-state and resolution routes', async () => {
    const stateResponse = await harness.app.inject({
      method: 'GET',
      url: `/v1/assets/${PUBLIC_ASSET}/review-state`,
    });
    const resolveResponse = await harness.app.inject({
      method: 'POST',
      url: `/v1/assets/${PUBLIC_ASSET}/review-resolution`,
      payload: { resolution: 'cleared' },
    });

    expect(stateResponse.statusCode).toBe(401);
    expect(resolveResponse.statusCode).toBe(401);
  });

  it('leaves the moderation routes off a gateway built without them', async () => {
    const plain = createGatewayHarness();
    try {
      const response = await plain.app.inject({
        method: 'POST',
        url: `/v1/assets/${PUBLIC_ASSET}/reports`,
        payload: { reason: 'other' },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe('route_not_found');
    } finally {
      await plain.close();
    }
  });
});
