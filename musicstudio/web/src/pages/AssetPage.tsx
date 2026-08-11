/**
 * 자산 상세 — 재생, 파형, 가사 싱크, 다운로드, 공유 (Requirements 11.5, 12.1, 12.3, 12.5, 12.7,
 * 12.9, 13.1-13.4, 14.2-14.4, 16.5).
 *
 * ### The download button asks before it offers
 *
 * Requirement 13.4 refuses a lossless download on a plan without the entitlement, **and names the
 * plans that have it**. So the screen calls `planDownload` and renders whatever ruling comes back,
 * rather than hiding formats it guesses are unavailable: hiding them would leave a user who *has*
 * the plan wondering where WAV went, and a user who does not with no idea what to upgrade to.
 *
 * ### Publishing and unpublishing are the same control
 *
 * Requirement 14.2 issues a link, 14.4 destroys it. One switch, and the link appears and disappears
 * with it — because they are one state, and a screen with separate 공개/철회 buttons would let a
 * user press the one that does nothing.
 */

import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import type { DownloadFormat, DownloadRefusalCode } from '@domain/library/download';

import { DisclosureBadges } from '../components/DisclosureBadges';
import { EnterTransition } from '../components/amicro/EnterTransition';
import { HoverLift } from '../components/amicro/HoverLift';
import { TextReveal } from '../components/amicro/TextReveal';
import { Player } from '../components/playback/Player';
import { StatusMessage } from '../components/StatusMessage';
import { useStudioApi } from '../lib/api/context';
import { useSound } from '../sound/context';
import type { DownloadFile, DownloadOutcome, ShareState } from '../lib/api/port';

/** A file that reached the user, beside the format they asked for — the two can differ. */
interface DeliveredDownload {
  readonly file: DownloadFile;
  readonly requestedFormat: DownloadFormat;
}

/** Bytes as the user reads them. Sizes here span a few KB to tens of MB. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Hands a blob to the browser's download machinery.
 *
 * An anchor with `download` rather than `window.open`: the object URL has no file name of its own,
 * and an opened tab would show the user a media player rather than saving the file they asked to
 * save.
 *
 * The anchor and the URL are both torn down on a later turn rather than immediately after the
 * click. Removing the element synchronously cost the file its name — the browser had started the
 * download but had not yet read `download` off the node, so the file landed as `download` with no
 * extension; revoking synchronously loses the same race with the bytes and lands an empty file.
 */
function saveFile(file: DownloadFile): void {
  if (typeof URL.createObjectURL !== 'function' || typeof document === 'undefined') return;
  const url = URL.createObjectURL(file.blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = file.fileName;
  document.body.append(anchor);
  anchor.click();
  globalThis.setTimeout(() => {
    anchor.remove();
    URL.revokeObjectURL(url);
  }, 10_000);
}
import type { StudioAsset } from '../lib/api/types';
import { hrefFor, navigate } from '../app/router';
import { button, chip, column, input, label, meta, panel, row } from '../styles/ui';

/**
 * Keyed by `DownloadRefusalCode` rather than by `string`, so a code with no Korean here is a type
 * error. It was a `string` map first, and a mistyped key silently fell through to the generic
 * message — which is the failure mode a closed key type removes.
 */
const REFUSAL_LABELS: Readonly<Record<DownloadRefusalCode, string>> = {
  download_format_unknown: '알 수 없는 형식입니다.',
  download_format_unsupported_for_kind: '이 자산 종류가 제공하지 않는 형식입니다.',
  download_lossless_not_entitled: '무손실 다운로드는 상위 요금제에서 제공됩니다.',
};

export interface AssetPageProps {
  readonly assetId: string;
}

export function AssetPage({ assetId }: AssetPageProps): ReactNode {
  const api = useStudioApi();
  const sound = useSound();

  const [asset, setAsset] = useState<StudioAsset | null>(null);
  const [share, setShare] = useState<ShareState | null>(null);
  const [download, setDownload] = useState<DownloadOutcome | null>(null);
  const [delivered, setDelivered] = useState<DeliveredDownload | null>(null);
  const [name, setName] = useState('');

  const load = useCallback(async () => {
    const found = await api.findAsset(assetId);
    setAsset(found);
    setName(found?.name ?? '');
    setShare(await api.shareState(assetId));
  }, [api, assetId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (asset === null) {
    return (
      <div style={panel}>
        <p>자산을 찾을 수 없습니다.</p>
        <button type="button" style={button} onClick={() => { navigate('library'); }}>
          라이브러리로
        </button>
      </div>
    );
  }

  const formats = api.downloadFormatsFor(asset.assetKind);

  return (
    <EnterTransition>
      <div style={column}>
        <div style={panel}>
          <div style={row}>
            <h2 style={{ margin: 0, fontSize: 22, flex: 1 }}>
              <TextReveal text={asset.name} />
            </h2>
            {/* Requirements 16.5, 16.13 — the same component the public page uses. */}
            <DisclosureBadges assetKind={asset.assetKind} />
            {asset.isLoop && <span style={chip}>루프</span>}
          </div>
          <p style={meta}>{asset.caption}</p>
          <div style={{ ...row, gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
            {asset.tags.map((tag) => (
              <span key={tag} style={chip}>#{tag}</span>
            ))}
            {asset.genres.map((genre) => (
              <span key={genre} style={chip}>{genre}</span>
            ))}
          </div>
        </div>

        <Player asset={asset} />

        <div style={panel}>
          <h3 style={{ marginTop: 0, fontSize: 16 }}>이름 변경 (Req 11.5)</h3>
          <div style={row}>
            <input
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
              style={input}
              aria-label="자산 이름"
            />
            <button
              type="button"
              style={button}
              onClick={() =>
                void api.renameAsset(asset.id, name).then((next) => {
                  setAsset(next);
                  sound.play('library.asset.renamed');
                })
              }
            >
              저장
            </button>
          </div>
        </div>

        <div style={panel}>
          <h3 style={{ marginTop: 0, fontSize: 16 }}>다운로드 (Req 13.1–13.4)</h3>
          <div style={{ ...row, flexWrap: 'wrap' }}>
            {formats.map((format: DownloadFormat) => (
              <HoverLift key={format}>
                <button
                  type="button"
                  style={button}
                  onClick={() =>
                    void api
                      .planDownload(asset.id, format, format === 'wav' || format === 'flac')
                      .then(async (outcome) => {
                        setDownload(outcome);
                        // The cue names the *reason*, so the sound and the message on screen are
                        // the same fact rather than a generic failure beep beside a specific one.
                        sound.play(
                          outcome.ruling.allowed
                            ? 'download.prepared'
                            : outcome.ruling.refusal === 'download_lossless_not_entitled'
                              ? 'download.refused.plan'
                              : 'download.refused.format',
                        );
                        if (!outcome.ruling.allowed) {
                          setDelivered(null);
                          return;
                        }
                        // The ruling allowed it, so the file is fetched and handed to the browser
                        // in the same gesture. This panel used to stop at the ruling and print
                        // "준비됨" — a success message for a file no code produced.
                        const file = await api.fetchDownload(asset.id, format);
                        setDelivered({ file, requestedFormat: format });
                        saveFile(file);
                      })
                  }
                >
                  {format.toUpperCase()}
                </button>
              </HoverLift>
            ))}
          </div>

          {delivered !== null && (
            <p style={{ ...meta, marginTop: 12 }}>
              내려받음: <code>{delivered.file.fileName}</code> ·{' '}
              {formatBytes(delivered.file.blob.size)}
              {delivered.file.deliveredFormat !== delivered.requestedFormat && (
                // Stated, not hidden behind the extension. The demo backend has no encoder, so a
                // request for MP3 comes back as WAV; a gateway returns what the DSP worker
                // encoded and this line never appears.
                <>
                  {' '}
                  — 요청한 형식은 {delivered.requestedFormat.toUpperCase()}이지만{' '}
                  {delivered.file.deliveredFormat.toUpperCase()}으로 전달되었습니다.
                </>
              )}
            </p>
          )}

          {download !== null && !download.ruling.allowed && (
            <StatusMessage kind="error" style={{ marginTop: 12 }}>
              <div>
                {download.ruling.refusal === undefined
                  ? '다운로드가 거부되었습니다.'
                  : REFUSAL_LABELS[download.ruling.refusal]}
              </div>
              {download.ruling.requiredPlanIds !== undefined && (
                // Requirement 13.4: the refusal names the plans that would allow it.
                <div>필요한 요금제: {download.ruling.requiredPlanIds.join(', ')}</div>
              )}
              {download.ruling.offeredFormats !== undefined && (
                <div>제공 형식: {download.ruling.offeredFormats.join(', ')}</div>
              )}
            </StatusMessage>
          )}
        </div>

        <div style={panel}>
          <h3 style={{ marginTop: 0, fontSize: 16 }}>공유 (Req 14.2–14.4)</h3>
          <label style={row}>
            <input
              type="checkbox"
              checked={share?.published ?? false}
              onChange={(event) =>
                void api
                  .setPublished(asset.id, event.target.checked, share?.remixAllowed ?? false)
                  .then((next) => {
                    setShare(next);
                    sound.play(next.published ? 'sharing.published' : 'sharing.revoked');
                  })
              }
            />
            <span>공개</span>
          </label>
          <label style={{ ...row, marginTop: 8 }}>
            <input
              type="checkbox"
              disabled={!(share?.published ?? false)}
              checked={share?.remixAllowed ?? false}
              onChange={(event) =>
                void api.setPublished(asset.id, true, event.target.checked).then(setShare)
              }
            />
            <span>원격 리믹스 허용 (Req 14.9)</span>
          </label>

          {share?.url != null ? (
            <p style={{ marginTop: 12 }}>
              <span style={label}>공개 링크 (Req 14.2 — 추측이 어려운 43자 토큰)</span>
              <code style={{ wordBreak: 'break-all' }}>{share.url}</code>
              {/* The same token against this build's own visitor route, so the page an owner
                  publishes is a page they can look at rather than a string they have to trust. */}
              <a
                href={hrefFor('s', share.url.split('/').at(-1) ?? '')}
                style={{ display: 'inline-block', marginTop: 6 }}
              >
                공개 페이지 열기
              </a>
            </p>
          ) : (
            <p style={{ ...meta, marginTop: 12 }}>비공개 상태입니다 (Req 14.1 — 기본값).</p>
          )}
        </div>
      </div>
    </EnterTransition>
  );
}
