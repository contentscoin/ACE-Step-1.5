import { describe, expect, it } from 'vitest';

import { WAVEFORM_BUCKETS_DEFAULT } from '../../../domain/playback/waveform';
import { GenerationError } from '../../../services/generation/errors';
import { createPlaybackService } from '../../../services/playback/playback-service';
import {
  ASSET_ID,
  OWNER_ID,
  STRANGER_ID,
  countingBytes,
  drain,
  playbackAsset,
  playbackHarness,
} from '../../support/playback-harness';

/**
 * Task 5.2's acceptance criteria — "Range 요청 임의 위치 재생 확인, 비소유자 접근 거부,
 * 루프 이음 연속 재생" — and the clauses behind them: Requirements 12.1-12.9.
 *
 * The three that are judgement calls, and where they are tested:
 *
 * - A private asset is refused as **404**, not 403 (`refuses a stranger`). A stream URL is
 *   reachable without a session, and a 403 would confirm the asset exists.
 * - The play count moves only for a request that **starts at byte 0** (`the play counter`).
 *   A player seeking issues a range request per seek; counting each would turn one listen
 *   into a dozen plays, and Requirement 11.4 sorts a library by that number.
 * - The window goes to the **store**, not to a slice afterwards (`asks the store for the
 *   window`). Requirement 12.3's one-second budget is a property of the call.
 */

const LENGTH = 1_000;

function service(options: Parameters<typeof playbackHarness>[0] = {}) {
  const ports = playbackHarness({ objectLength: LENGTH, ...options });
  return { ...ports, playback: createPlaybackService(ports) };
}

describe('streaming (Requirements 12.1, 12.8)', () => {
  it('serves the whole object with 200 when no range was asked for', async () => {
    const { playback } = service();

    const response = await playback.stream({ assetId: ASSET_ID, requesterId: OWNER_ID });

    expect(response.status).toBe(200);
    expect(response.contentLength).toBe(LENGTH);
    expect(response.headers['content-type']).toBe('audio/flac');
    expect(response.headers['accept-ranges']).toBe('bytes');
    expect(await drain(response.body)).toEqual(countingBytes(LENGTH));
  });

  it('refuses an asset whose audio has been purged (Requirement 11.8)', async () => {
    const { playback } = service({ assets: [playbackAsset({ objectKey: null })] });

    await expect(
      playback.stream({ assetId: ASSET_ID, requesterId: OWNER_ID }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'playback_audio_unavailable' });
  });

  it('refuses an asset that is not there at all', async () => {
    const { playback } = service();

    await expect(
      playback.stream({ assetId: 'nope', requesterId: OWNER_ID }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'playback_asset_not_found' });
  });

  it('refuses a soft-deleted asset as absent, so the deletion is not cosmetic', async () => {
    const { playback } = service({ assets: [playbackAsset({ isDeleted: true })] });

    await expect(
      playback.stream({ assetId: ASSET_ID, requesterId: OWNER_ID }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('range requests (Requirements 12.2, 12.3)', () => {
  it('plays from an arbitrary position with 206 and the right bytes', async () => {
    const { playback } = service();

    const response = await playback.stream({
      assetId: ASSET_ID,
      requesterId: OWNER_ID,
      rangeHeader: 'bytes=400-599',
    });

    expect(response.status).toBe(206);
    expect(response.contentLength).toBe(200);
    expect(response.headers['content-range']).toBe('bytes 400-599/1000');
    // Byte `i` is `i % 256`, so the served window identifies its own offset.
    expect(await drain(response.body)).toEqual(countingBytes(LENGTH).slice(400, 600));
  });

  it('asks the store for the window rather than reading everything and slicing', async () => {
    // Requirement 12.3's budget lives in this call. A port that fetched the whole object
    // would pass every assertion above while missing the requirement on a long asset.
    const { playback, objects } = service();

    await playback.stream({
      assetId: ASSET_ID,
      requesterId: OWNER_ID,
      rangeHeader: 'bytes=900-',
    });

    expect(objects.reads).toEqual([{ objectKey: 'audio/asset-a', start: 900, end: 999 }]);
  });

  it('serves a suffix range as the last N bytes', async () => {
    const { playback, objects } = service();

    const response = await playback.stream({
      assetId: ASSET_ID,
      requesterId: OWNER_ID,
      rangeHeader: 'bytes=-100',
    });

    expect(response.status).toBe(206);
    expect(objects.reads[0]).toEqual({ objectKey: 'audio/asset-a', start: 900, end: 999 });
  });

  it('answers a range past the end with 416 carrying the size', async () => {
    const { playback } = service();

    const failure = await playback
      .stream({ assetId: ASSET_ID, requesterId: OWNER_ID, rangeHeader: 'bytes=5000-' })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(GenerationError);
    expect(failure).toMatchObject({ statusCode: 416, code: 'playback_range_unsatisfiable' });
    expect((failure as GenerationError).details).toMatchObject({
      headers: { 'content-range': 'bytes */1000' },
    });
  });

  it('serves a header it cannot parse whole, rather than failing the client', async () => {
    const { playback } = service();

    const response = await playback.stream({
      assetId: ASSET_ID,
      requesterId: OWNER_ID,
      rangeHeader: 'bytes=0-99,200-299',
    });

    expect(response.status).toBe(200);
    expect(response.contentLength).toBe(LENGTH);
  });

  it('reassembles the whole object from consecutive windows', async () => {
    // The seam a player depends on when it streams in chunks: nothing lost, nothing repeated.
    const { playback } = service();
    const collected: number[] = [];

    let cursor = 0;
    while (cursor < LENGTH) {
      const response = await playback.stream({
        assetId: ASSET_ID,
        requesterId: OWNER_ID,
        rangeHeader: `bytes=${String(cursor)}-${String(cursor + 249)}`,
      });
      collected.push(...(await drain(response.body)));
      cursor += response.contentLength;
    }

    expect(Uint8Array.from(collected)).toEqual(countingBytes(LENGTH));
  });
});

describe('the private-asset gate (Requirement 12.6)', () => {
  it('serves the owner', async () => {
    const { playback } = service();

    await expect(
      playback.stream({ assetId: ASSET_ID, requesterId: OWNER_ID }),
    ).resolves.toMatchObject({ status: 200 });
  });

  it('refuses a stranger, and as 404 rather than 403', async () => {
    // A stream URL is reachable without a session; a 403 confirms the asset exists.
    const { playback } = service();

    await expect(
      playback.stream({ assetId: ASSET_ID, requesterId: STRANGER_ID }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'playback_asset_private' });
  });

  it('refuses an anonymous request for a private asset', async () => {
    const { playback } = service();

    await expect(
      playback.stream({ assetId: ASSET_ID, requesterId: null }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('serves a stranger once the asset is public', async () => {
    const { playback } = service({ publicIds: [ASSET_ID] });

    await expect(
      playback.stream({ assetId: ASSET_ID, requesterId: STRANGER_ID }),
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      playback.stream({ assetId: ASSET_ID, requesterId: null }),
    ).resolves.toMatchObject({ status: 200 });
  });

  it('gates the waveform, the lyric line and the position too', async () => {
    const { playback } = service();

    // Thunks rather than promises: three rejections created at once and awaited in turn
    // would be two unhandled rejections before the loop reached them.
    for (const call of [
      () => playback.waveform(ASSET_ID, STRANGER_ID),
      () => playback.lyricLineAt(ASSET_ID, STRANGER_ID, 0),
      () => playback.positionAfter(ASSET_ID, STRANGER_ID, 0),
    ]) {
      await expect(call()).rejects.toMatchObject({ statusCode: 404 });
    }
  });
});

describe('the play counter (Requirement 12.4)', () => {
  it('counts a request that starts at the beginning', async () => {
    const { playback, assets } = service();

    const first = await playback.stream({ assetId: ASSET_ID, requesterId: OWNER_ID });
    const second = await playback.stream({ assetId: ASSET_ID, requesterId: OWNER_ID });

    expect(first.playCount).toBe(1);
    expect(second.playCount).toBe(2);
    expect(assets.playCounts.get(ASSET_ID)).toBe(2);
  });

  it('counts a range request that starts at byte 0', async () => {
    const { playback } = service();

    const response = await playback.stream({
      assetId: ASSET_ID,
      requesterId: OWNER_ID,
      rangeHeader: 'bytes=0-99',
    });

    expect(response.playCount).toBe(1);
  });

  it('does not count a seek', async () => {
    // One listen with a dozen seeks is one play. Requirement 11.4 sorts a library by this
    // number, so a counter that moved per seek would reorder it by fidgetiness.
    const { playback, assets } = service();

    await playback.stream({ assetId: ASSET_ID, requesterId: OWNER_ID });
    for (const start of [100, 200, 300, 400]) {
      const response = await playback.stream({
        assetId: ASSET_ID,
        requesterId: OWNER_ID,
        rangeHeader: `bytes=${String(start)}-`,
      });
      expect(response.playCount).toBeNull();
    }

    expect(assets.playCounts.get(ASSET_ID)).toBe(1);
  });

  it('does not count a refused request', async () => {
    // Otherwise a stranger could inflate an owner s play count by requesting a stream they
    // are refused, and the number would be a record of failed attempts.
    const { playback, assets } = service();

    await playback
      .stream({ assetId: ASSET_ID, requesterId: STRANGER_ID })
      .catch(() => undefined);
    await playback
      .stream({ assetId: ASSET_ID, requesterId: OWNER_ID, rangeHeader: 'bytes=5000-' })
      .catch(() => undefined);

    expect(assets.playCounts.get(ASSET_ID)).toBeUndefined();
  });
});

describe('the waveform (Requirements 12.7, 12.8)', () => {
  it('computes at the default resolution and caches the result', async () => {
    const { playback, waveforms } = service();

    const first = await playback.waveform(ASSET_ID, OWNER_ID);
    const second = await playback.waveform(ASSET_ID, OWNER_ID);

    expect(first.buckets).toHaveLength(WAVEFORM_BUCKETS_DEFAULT);
    expect(second).toEqual(first);
    // The reduction reads the whole object, and the asset is immutable once stored.
    expect(waveforms.computed).toHaveLength(1);
  });

  it('computes once per resolution', async () => {
    const { playback, waveforms } = service();

    await playback.waveform(ASSET_ID, OWNER_ID, 256);
    await playback.waveform(ASSET_ID, OWNER_ID, 512);
    await playback.waveform(ASSET_ID, OWNER_ID, 256);

    expect(waveforms.computed.map((entry) => entry.buckets)).toEqual([256, 512]);
  });

  it('refuses a resolution outside the published bounds', async () => {
    const { playback } = service();

    for (const buckets of [15, 4_001, 0, 800.5]) {
      await expect(playback.waveform(ASSET_ID, OWNER_ID, buckets)).rejects.toMatchObject({
        statusCode: 400,
        code: 'playback_waveform_request_invalid',
      });
    }
  });

  it('never asks for more buckets than the asset has frames', async () => {
    const { playback, waveforms } = service({
      assets: [playbackAsset({ frameCount: 64 })],
    });

    const waveform = await playback.waveform(ASSET_ID, OWNER_ID, 4_000);

    expect(waveforms.computed[0]?.buckets).toBe(64);
    expect(waveform.buckets).toHaveLength(64);
  });
});

describe('lyric synchronisation (Requirement 12.5)', () => {
  it('returns the line showing at a position', async () => {
    const { playback, assets } = service();
    assets.lyrics.set(ASSET_ID, {
      lines: [
        { startMs: 1_000, text: 'first' },
        { startMs: 3_000, text: 'second' },
      ],
    });

    expect(await playback.lyricLineAt(ASSET_ID, OWNER_ID, 500)).toBeNull();
    expect((await playback.lyricLineAt(ASSET_ID, OWNER_ID, 3_500))?.text).toBe('second');
  });

  it('returns nothing for an asset with no Timed_Lyrics', async () => {
    const { playback } = service();

    expect(await playback.lyricLineAt(ASSET_ID, OWNER_ID, 3_500)).toBeNull();
  });
});

describe('loop playback (Requirement 12.9)', () => {
  it('wraps a loop asset at the end of each pass', async () => {
    const { playback } = service({
      assets: [playbackAsset({ isLoop: true, durationMs: 4_000 })],
    });

    expect(await playback.positionAfter(ASSET_ID, OWNER_ID, 3_999)).toEqual({
      positionMs: 3_999,
      pass: 0,
    });
    expect(await playback.positionAfter(ASSET_ID, OWNER_ID, 4_000)).toEqual({
      positionMs: 0,
      pass: 1,
    });
    expect(await playback.positionAfter(ASSET_ID, OWNER_ID, 10_500)).toEqual({
      positionMs: 2_500,
      pass: 2,
    });
  });

  it('stops a non-looping asset at its end', async () => {
    const { playback } = service({ assets: [playbackAsset({ durationMs: 4_000 })] });

    expect(await playback.positionAfter(ASSET_ID, OWNER_ID, 9_000)).toEqual({
      positionMs: 4_000,
      pass: 0,
    });
  });

  it('serves a loop asset s bytes from the beginning again on the next pass', async () => {
    // "루프 이음 연속 재생" end to end: a player that reaches the end asks for byte 0 again,
    // and the two windows are adjacent with nothing between them.
    const { playback } = service({
      assets: [playbackAsset({ isLoop: true, durationMs: 4_000 })],
    });

    const tail = await playback.stream({
      assetId: ASSET_ID,
      requesterId: OWNER_ID,
      rangeHeader: 'bytes=900-',
    });
    const head = await playback.stream({
      assetId: ASSET_ID,
      requesterId: OWNER_ID,
      rangeHeader: 'bytes=0-99',
    });

    expect(await drain(tail.body)).toEqual(countingBytes(LENGTH).slice(900));
    expect(await drain(head.body)).toEqual(countingBytes(LENGTH).slice(0, 100));
  });
});
