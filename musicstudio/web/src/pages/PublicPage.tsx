/**
 * 공개 페이지 — what a visitor holding a link sees (Requirements 14.3, 14.4, 16.5, 16.13).
 *
 * > 자산 제목, 캡션, 오디오 재생, AI 생성 표기
 *
 * Four things, and this screen renders exactly those four. It is deliberately not the asset
 * detail screen with controls hidden: a visitor is **not signed in**, and a screen that starts
 * from the owner's screen is one where a rename field or a download button survives a refactor
 * that was only meant to change a layout.
 *
 * ### The AI notice is not optional here
 *
 * Requirement 16.5 names the public page specifically, and 16.13 adds 합성 음성 for `dialogue`.
 * Both come from `DisclosureBadges`, the same component the detail screen uses, so the two
 * cannot disagree about what an asset discloses. That was not always true: the service that
 * builds this page used to default its disclosure list to `[]` when nothing was wired, which
 * meant an unwired deployment served every public page with no notice at all.
 *
 * ### A revoked link is a 404, not an empty page
 *
 * Requirement 14.4 answers a revoked link with 404. On a screen that is "이 링크는 더 이상
 * 유효하지 않습니다" and nothing else — in particular, not the asset's title, which would
 * survive the revocation as a leak of the very thing that was withdrawn.
 */

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { EnterTransition } from '../components/amicro/EnterTransition';
import { DisclosureBadges } from '../components/DisclosureBadges';
import { TextReveal } from '../components/amicro/TextReveal';
import { StatusMessage } from '../components/StatusMessage';
import { useStudioApi } from '../lib/api/context';
import type { PublicAssetPage } from '../lib/api/port';
import { chip, column, meta, panel, row } from '../styles/ui';

export interface PublicPageProps {
  readonly token: string | null;
}

type Loaded = { readonly state: 'loading' } | { readonly state: 'done'; readonly page: PublicAssetPage | null };

export function PublicPage({ token }: PublicPageProps): ReactNode {
  const api = useStudioApi();
  const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' });

  useEffect(() => {
    if (token === null) {
      setLoaded({ state: 'done', page: null });
      return;
    }
    let live = true;
    void api.publicPage(token).then((page) => {
      if (live) setLoaded({ state: 'done', page });
    });
    return () => {
      live = false;
    };
  }, [api, token]);

  if (loaded.state === 'loading') {
    return (
      <div style={panel}>
        <p style={meta}>불러오는 중…</p>
      </div>
    );
  }

  if (loaded.page === null) {
    return (
      <StatusMessage kind="error">
        이 링크는 더 이상 유효하지 않습니다. (Req 14.4)
      </StatusMessage>
    );
  }

  const { page } = loaded;

  return (
    <EnterTransition>
      <div style={column}>
        <div style={panel}>
          <div style={row}>
            <h2 style={{ margin: 0, fontSize: 22, flex: 1 }}>
              <TextReveal text={page.title} />
            </h2>
            {/* Requirements 16.5, 16.13. */}
            <DisclosureBadges assetKind={page.assetKind} />
          </div>
          <p style={meta}>{page.caption}</p>
        </div>

        <div style={panel}>
          <h3 style={{ marginTop: 0, fontSize: 16 }}>재생</h3>
          {/* The stream URL is the only thing a visitor needs; nothing here names the owner. */}
          <audio controls src={api.streamUrl(page.assetId)} style={{ width: '100%' }}>
            <track kind="captions" />
          </audio>
          <div style={{ ...row, gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
            <span style={chip}>{Math.round(page.durationMs / 1_000)}초</span>
            {page.isLoop && <span style={chip}>루프</span>}
            <span style={chip}>좋아요 {page.likeCount}</span>
            {page.remixAllowed && <span style={chip}>리믹스 허용 (Req 14.9)</span>}
          </div>
        </div>
      </div>
    </EnterTransition>
  );
}
