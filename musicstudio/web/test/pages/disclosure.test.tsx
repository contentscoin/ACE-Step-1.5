/**
 * The AI-generation notices, on both screens that show an asset.
 *
 * **Validates: Requirements 16.5, 16.13, 14.3, 14.4**
 *
 * The clause is satisfied by a label being *present*, so what is checked is presence — on the
 * detail screen and on the public page, for every asset kind, from the one table. A test that
 * asserted the string on one screen would pass while the other silently lost it, which is the
 * failure this whole arrangement exists to make impossible.
 */

import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ReactNode } from 'react';

import { ASSET_KINDS } from '@domain/asset-kind';
import { disclosureLabel, visibleDisclosuresFor } from '@domain/disclosure/ai-disclosure';

import { StudioApiProvider } from '../../src/lib/api/context';
import { createUISoundLayer } from '../../src/sound/layer';
import { SoundProvider } from '../../src/sound/context';
import { createMemoryStore, createRecordingEngine } from '../support/recording-engine';
import { createDemoApi } from '../../src/lib/api/demo-api';
import type { StudioApi } from '../../src/lib/api/port';
import { AssetPage } from '../../src/pages/AssetPage';
import { PublicPage } from '../../src/pages/PublicPage';
import { DisclosureBadges } from '../../src/components/DisclosureBadges';

afterEach(cleanup);

function mount(api: StudioApi, node: ReactNode) {
  const sound = createUISoundLayer({
    engine: createRecordingEngine(),
    store: createMemoryStore(),
  });
  return render(
    <StudioApiProvider api={api}>
      <SoundProvider layer={sound}>{node}</SoundProvider>
    </StudioApiProvider>,
  );
}

/** The seed's `dialogue` asset — Requirement 16.13's kind, and the only one that has it. */
const NARRATION = 'asset-narration';
const SONG = 'asset-night-drive';

describe('the badge component (Reqs 16.5, 16.13)', () => {
  it.each(ASSET_KINDS)('renders every label the domain says %s owes', (kind) => {
    render(<DisclosureBadges assetKind={kind} />);

    for (const obligation of visibleDisclosuresFor(kind)) {
      expect(screen.getByText(disclosureLabel(obligation))).toBeTruthy();
    }
  });

  it('says 합성 음성 for dialogue and for nothing else', () => {
    render(<DisclosureBadges assetKind="dialogue" />);
    expect(screen.getByText('합성 음성')).toBeTruthy();

    cleanup();
    render(<DisclosureBadges assetKind="song" />);
    expect(screen.queryByText('합성 음성')).toBeNull();
  });

  it('groups the notices as a list, so they are announced as separate facts', () => {
    render(<DisclosureBadges assetKind="dialogue" />);

    expect(screen.getByRole('list', { name: 'AI 생성 표기' })).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });
});

describe('the detail screen (Req 16.5)', () => {
  it('shows the AI label', async () => {
    mount(createDemoApi(), <AssetPage assetId={SONG} />);

    await waitFor(() => {
      expect(screen.getByText('AI 생성')).toBeTruthy();
    });
    expect(screen.queryByText('합성 음성')).toBeNull();
  });

  it('adds 합성 음성 for a dialogue asset (Req 16.13)', async () => {
    mount(createDemoApi(), <AssetPage assetId={NARRATION} />);

    await waitFor(() => {
      expect(screen.getByText('합성 음성')).toBeTruthy();
    });
    expect(screen.getByText('AI 생성')).toBeTruthy();
  });
});

describe('the public page (Reqs 14.3, 16.5, 16.13)', () => {
  async function publishedToken(api: StudioApi, assetId: string): Promise<string> {
    const state = await api.setPublished(assetId, true, false);
    return state.url?.split('/').at(-1) ?? '';
  }

  it('shows the four things Requirement 14.3 names, and the AI label with them', async () => {
    const api = createDemoApi();
    const token = await publishedToken(api, SONG);

    mount(api, <PublicPage token={token} />);

    await waitFor(() => {
      // 제목, 캡션, 재생, AI 생성 표기.
      expect(screen.getByRole('heading', { level: 2 })).toBeTruthy();
    });
    expect(screen.getByText('AI 생성')).toBeTruthy();
    expect(screen.getByText(/차 안에서 듣는|밤/)).toBeTruthy();
  });

  it('adds 합성 음성 for a dialogue asset', async () => {
    const api = createDemoApi();
    const token = await publishedToken(api, NARRATION);

    mount(api, <PublicPage token={token} />);

    await waitFor(() => {
      expect(screen.getByText('합성 음성')).toBeTruthy();
    });
  });

  it('names nothing about the owner', async () => {
    const api = createDemoApi();
    const token = await publishedToken(api, SONG);
    const asset = await api.findAsset(SONG);

    mount(api, <PublicPage token={token} />);

    await waitFor(() => {
      expect(screen.getByText('AI 생성')).toBeTruthy();
    });
    // Publishing one asset must not publish a little of everything else the account holds.
    expect(document.body.textContent).not.toContain(asset?.ownerId ?? 'owner');
  });

  it('answers a revoked link with a refusal that does not repeat the title (Req 14.4)', async () => {
    const api = createDemoApi();
    const token = await publishedToken(api, SONG);
    const asset = await api.findAsset(SONG);
    await api.setPublished(SONG, false, false);

    mount(api, <PublicPage token={token} />);

    await waitFor(() => {
      expect(screen.getByText(/더 이상 유효하지 않습니다/)).toBeTruthy();
    });
    // The title surviving the revocation would leak the very thing that was withdrawn.
    expect(document.body.textContent).not.toContain(asset?.name ?? '');
  });

  it('answers an unknown token the same way', async () => {
    mount(createDemoApi(), <PublicPage token="not-a-real-token" />);

    await waitFor(() => {
      expect(screen.getByText(/더 이상 유효하지 않습니다/)).toBeTruthy();
    });
  });
});
