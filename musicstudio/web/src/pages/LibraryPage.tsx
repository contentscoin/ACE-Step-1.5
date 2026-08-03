/**
 * 라이브러리 화면 — 목록, 검색, 필터, 정렬, 커서 (Requirements 11.1-11.5, 11.12).
 *
 * The screen holds the *query*, not the results: `LibraryQueryInput` is the domain's own shape, so
 * a control changes one field of it and `applyLibraryQuery` decides everything else. What the
 * screen would otherwise be tempted to do — filter the fetched page client-side when the search box
 * changes — is exactly the drift 11.2's cursor makes visible, because a locally filtered page and a
 * server cursor disagree about where the next page starts.
 *
 * The cursor is kept as a stack rather than a single value so "이전" is possible at all: a cursor
 * points forward only, and remembering the one that produced the current page is the only way back
 * that does not renumber pages when a row changes underneath.
 */

import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { ASSET_KINDS } from '@domain/asset-kind';
import { LIBRARY_SORT_KEYS } from '@domain/library/bounds';
import type { LibraryCursor, LibraryPage } from '@domain/library/query';

import { EnterTransition } from '../components/amicro/EnterTransition';
import { HoverLift } from '../components/amicro/HoverLift';
import { useStudioApi } from '../lib/api/context';
import { navigate } from '../app/router';
import { button, chip, column, input, label, meta, panel, row, tabular } from '../styles/ui';

const SORT_LABELS: Readonly<Record<string, string>> = {
  created_at: '생성 시각',
  title: '제목',
  play_count: '재생 횟수',
};

const KIND_LABELS: Readonly<Record<string, string>> = {
  song: '곡',
  bgm: 'BGM',
  sfx: '효과음',
  dialogue: '대사',
  stem: '스템',
  mix: '믹스',
};

export function LibraryPage(): ReactNode {
  const api = useStudioApi();

  const [search, setSearch] = useState('');
  const [assetKind, setAssetKind] = useState<string>('');
  const [sortKey, setSortKey] = useState<string>('created_at');
  const [cursorStack, setCursorStack] = useState<readonly (LibraryCursor | null)[]>([null]);
  const [page, setPage] = useState<LibraryPage | null>(null);

  const cursor = cursorStack[cursorStack.length - 1] ?? null;

  const load = useCallback(async () => {
    setPage(
      await api.listAssets({
        ownerId: 'owner-1',
        sortKey,
        ...(search === '' ? {} : { search }),
        ...(assetKind === '' ? {} : { assetKind }),
        ...(cursor === null ? {} : { cursor }),
      }),
    );
  }, [api, search, assetKind, sortKey, cursor]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Any control other than the pager resets to the first page — the cursor was for that order. */
  function restart(change: () => void): void {
    change();
    setCursorStack([null]);
  }

  return (
    <EnterTransition>
      <div style={column}>
        <div style={{ ...panel, ...row, flexWrap: 'wrap' }}>
          <label style={{ flex: '1 1 240px' }}>
            <span style={label}>검색 (제목·캡션·가사·태그 — Req 11.3)</span>
            <input
              value={search}
              onChange={(event) => {
                restart(() => {
                  setSearch(event.target.value);
                });
              }}
              placeholder="예: 로파이"
              style={input}
            />
          </label>

          <label>
            <span style={label}>종류 (Req 11.12)</span>
            <select
              value={assetKind}
              onChange={(event) => {
                restart(() => {
                  setAssetKind(event.target.value);
                });
              }}
              style={input}
            >
              <option value="">전체</option>
              {ASSET_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {KIND_LABELS[kind] ?? kind}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span style={label}>정렬 (Req 11.4)</span>
            <select
              value={sortKey}
              onChange={(event) => {
                restart(() => {
                  setSortKey(event.target.value);
                });
              }}
              style={input}
            >
              {LIBRARY_SORT_KEYS.map((key) => (
                <option key={key} value={key}>
                  {SORT_LABELS[key] ?? key}
                </option>
              ))}
            </select>
          </label>
        </div>

        {page !== null && page.assets.length === 0 && (
          <div style={panel}>조건에 맞는 자산이 없습니다.</div>
        )}

        <div style={column}>
          {page?.assets.map((asset) => (
            <HoverLift key={asset.id}>
              <button
                type="button"
                onClick={() => {
                  navigate('asset', asset.id);
                }}
                style={{ ...panel, ...row, width: '100%', textAlign: 'left', cursor: 'pointer' }}
              >
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600 }}>{asset.name}</div>
                  <div style={meta}>{asset.caption || '캡션 없음'}</div>
                  <div style={{ ...row, marginTop: 6, gap: 6, flexWrap: 'wrap' }}>
                    <span style={chip}>{KIND_LABELS[asset.assetKind] ?? asset.assetKind}</span>
                    {asset.tags.map((tag) => (
                      <span key={tag} style={chip}>
                        #{tag}
                      </span>
                    ))}
                  </div>
                </div>
                <div style={{ ...meta, ...tabular, textAlign: 'right' }}>
                  <div>재생 {asset.playCount}</div>
                  <div>{new Date(asset.createdAtMs).toLocaleString('ko-KR')}</div>
                </div>
              </button>
            </HoverLift>
          ))}
        </div>

        <div style={row}>
          <button
            type="button"
            style={button}
            disabled={cursorStack.length <= 1}
            onClick={() => {
              setCursorStack((stack) => stack.slice(0, -1));
            }}
          >
            이전
          </button>
          <button
            type="button"
            style={button}
            disabled={page?.nextCursor == null}
            onClick={() => {
              // Requirement 11.2: the cursor the *server* issued, never a computed offset.
              if (page?.nextCursor != null) setCursorStack((stack) => [...stack, page.nextCursor]);
            }}
          >
            다음
          </button>
          <span style={meta}>{page?.assets.length ?? 0}건 표시</span>
        </div>
      </div>
    </EnterTransition>
  );
}
