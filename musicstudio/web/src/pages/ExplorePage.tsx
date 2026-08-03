/**
 * 탐색 피드 — 공개된 자산만, 필터와 좋아요 (Requirements 14.5, 14.6, 14.7).
 *
 * The feed is `applyFeedQuery`'s answer, so a private asset is not something this screen filters
 * out — it is something the feed never contains. That distinction is worth keeping: a screen that
 * fetched everything and hid the private rows would put them in the browser, where "hidden" is a
 * CSS property.
 *
 * The like button shows the count from the outcome the API returned rather than incrementing its
 * own copy. Requirement 14.8 says a repeat returns the current state *unchanged*, and a local
 * counter would happily show 2 for one user pressing twice.
 */

import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { ASSET_KINDS } from '@domain/asset-kind';
import type { FeedPage } from '@domain/sharing/feed';

import { EnterTransition } from '../components/amicro/EnterTransition';
import { HoverLift } from '../components/amicro/HoverLift';
import { useStudioApi } from '../lib/api/context';
import { useSound } from '../sound/context';
import { navigate } from '../app/router';
import { button, chip, column, input, label, meta, panel, row, tabular } from '../styles/ui';

export function ExplorePage(): ReactNode {
  const api = useStudioApi();
  const sound = useSound();

  const [assetKind, setAssetKind] = useState('');
  const [genre, setGenre] = useState('');
  const [page, setPage] = useState<FeedPage | null>(null);
  const [likes, setLikes] = useState<Readonly<Record<string, number>>>({});

  const load = useCallback(async () => {
    setPage(
      await api.feed({
        ...(assetKind === '' ? {} : { assetKind }),
        ...(genre === '' ? {} : { genre }),
      }),
    );
  }, [api, assetKind, genre]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <EnterTransition>
      <div style={column}>
        <div style={{ ...panel, ...row, flexWrap: 'wrap' }}>
          <label>
            <span style={label}>종류 (Req 14.6)</span>
            <select
              value={assetKind}
              onChange={(event) => {
                setAssetKind(event.target.value);
              }}
              style={input}
            >
              <option value="">전체</option>
              {ASSET_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {kind}
                </option>
              ))}
            </select>
          </label>
          <label style={{ flex: '1 1 200px' }}>
            <span style={label}>장르</span>
            <input
              value={genre}
              onChange={(event) => {
                setGenre(event.target.value);
              }}
              placeholder="예: lo-fi"
              style={input}
            />
          </label>
        </div>

        {page !== null && page.assets.length === 0 && (
          <div style={panel}>
            공개된 자산이 없습니다. 자산 상세 화면에서 공개하면 여기에 나타납니다 (Req 14.1, 14.5).
          </div>
        )}

        {page?.assets.map((asset) => (
          <div key={asset.id} style={{ ...panel, ...row }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600 }}>{asset.name}</div>
              <div style={meta}>{asset.caption}</div>
              <div style={{ ...row, gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                <span style={chip}>{asset.assetKind}</span>
                {asset.genres.map((entry) => (
                  <span key={entry} style={chip}>
                    {entry}
                  </span>
                ))}
              </div>
            </div>
            <div style={{ ...column, gap: 6, alignItems: 'flex-end' }}>
              <HoverLift>
                <button
                  type="button"
                  style={button}
                  aria-label={`${asset.name} 좋아요`}
                  onClick={() =>
                    void api.like(asset.id).then((outcome) => {
                      // The count the service returned — see the header on why not a local ++.
                      setLikes((current) => ({ ...current, [asset.id]: outcome.likeCount }));
                      // Requirement 14.8's "unchanged" has its own cue: a repeat that sounded
                      // like a first like would tell the user something happened.
                      sound.play(outcome.changed ? 'sharing.like.added' : 'sharing.like.repeat');
                    })
                  }
                >
                  ♥ <span style={tabular}>{likes[asset.id] ?? asset.likeCount}</span>
                </button>
              </HoverLift>
              <button
                type="button"
                style={button}
                onClick={() => {
                  navigate('asset', asset.id);
                }}
              >
                열기
              </button>
            </div>
          </div>
        ))}
      </div>
    </EnterTransition>
  );
}
