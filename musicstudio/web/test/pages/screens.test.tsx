/**
 * The remaining screens of task 7.3: 라이브러리, 공유·탐색, 타임라인, 마스터링.
 *
 * **Validates: Requirements 11.1, 11.3, 11.12, 14.1, 14.2, 14.4, 14.5, 14.7, 14.8, 28.8, 28.14,
 * 28.16, 28.35, 29.1, 29.10, 29.13, 29.28, 29.34, 30.1, 30.3, 30.4, 30.21, 30.22, 30.23, 30.24**
 *
 * Each case is a claim about a *rule the screen must not have re-implemented*: that a private asset
 * is absent from the feed rather than hidden in it, that a second like does not increment a local
 * counter, that a refused edit leaves the project alone. Those are the places where a screen is
 * tempted to be clever, so those are what is pinned.
 */

import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ReactNode } from 'react';

import { CLIP_GAIN_DB_MAX } from '@domain/timeline/bounds';

import { StudioApiProvider } from '../../src/lib/api/context';
import { createDemoApi } from '../../src/lib/api/demo-api';
import type { StudioApi } from '../../src/lib/api/port';
import { AssetPage } from '../../src/pages/AssetPage';
import { ExplorePage } from '../../src/pages/ExplorePage';
import { LibraryPage } from '../../src/pages/LibraryPage';
import { MasteringPage } from '../../src/pages/MasteringPage';
import { TimelinePage } from '../../src/pages/TimelinePage';

afterEach(cleanup);

function mount(api: StudioApi, node: ReactNode) {
  return render(<StudioApiProvider api={api}>{node}</StudioApiProvider>);
}

describe('라이브러리', () => {
  it('lists the owner’s assets and narrows them by search (Reqs 11.1, 11.3)', async () => {
    mount(createDemoApi(), <LibraryPage />);

    await waitFor(() => {
      expect(screen.getByText(/건 표시/).textContent).not.toBe('0건 표시');
    });
    const before = screen.getByText(/건 표시/).textContent;

    fireEvent.change(screen.getByLabelText(/검색/), { target: { value: '존재하지않는가사' } });

    await waitFor(() => {
      expect(screen.getByText('조건에 맞는 자산이 없습니다.')).toBeTruthy();
    });
    expect(screen.getByText(/건 표시/).textContent).not.toBe(before);
  });

  it('filters by asset kind (Req 11.12)', async () => {
    mount(createDemoApi(), <LibraryPage />);
    await waitFor(() => {
      expect(screen.getByText(/건 표시/)).toBeTruthy();
    });

    expect(screen.getByRole('button', { name: /Night Drive/ })).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/종류/), { target: { value: 'sfx' } });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Neon Rush/ })).toBeTruthy();
    });
    // The 곡 row is gone. Queried by role rather than by the text '곡', which also appears as an
    // `<option>` in the filter itself — a page-wide text query would pass on the control.
    expect(screen.queryByRole('button', { name: /Night Drive/ })).toBeNull();
  });
});

describe('공유와 탐색', () => {
  it('keeps a private asset out of the feed entirely (Reqs 14.1, 14.5)', async () => {
    const api = createDemoApi();
    mount(api, <ExplorePage />);

    expect(
      await screen.findByText(/공개된 자산이 없습니다/),
    ).toBeTruthy();

    // `queryBy` over the whole document: the claim is that the row is *absent*, which a screen
    // that fetched everything and hid the private rows would fail even though it looks the same.
    expect(screen.queryByText('Night Drive')).toBeNull();
  });

  it('issues a link on publish and destroys it on revoke (Reqs 14.2, 14.4)', async () => {
    const api = createDemoApi();
    mount(api, <AssetPage assetId="asset-night-drive" />);

    const toggle = await screen.findByLabelText('공개');
    expect(screen.getByText(/비공개 상태입니다/)).toBeTruthy();

    fireEvent.click(toggle);
    const link = await screen.findByText(/^https:\/\/studio\.example\/s\//);
    // Requirement 14.2: a token that is not guessable — 43 characters of it.
    expect(link.textContent?.split('/s/')[1]).toHaveLength(43);

    fireEvent.click(toggle);
    await waitFor(() => {
      expect(screen.getByText(/비공개 상태입니다/)).toBeTruthy();
    });
  });

  it('shows the count the service returned, so a second like does not add one (Req 14.8)', async () => {
    const api = createDemoApi();
    await api.setPublished('asset-night-drive', true, false);
    mount(api, <ExplorePage />);

    const like = await screen.findByRole('button', { name: /좋아요/ });
    fireEvent.click(like);
    await waitFor(() => {
      expect(like.textContent).toContain('1');
    });

    fireEvent.click(like);
    // Property 20: idempotent. A local `++` would read 2 here.
    await waitFor(() => {
      expect(like.textContent).toContain('1');
    });
    expect(like.textContent).not.toContain('2');
  });
});

describe('타임라인', () => {
  it('applies a gain change and undoes it exactly (Reqs 28.16, 28.35)', async () => {
    mount(createDemoApi(), <TimelinePage />);

    const gain = await screen.findByLabelText(/게인/);
    const before = (gain as HTMLInputElement).value;

    fireEvent.change(gain, { target: { value: String(CLIP_GAIN_DB_MAX) } });
    await waitFor(() => {
      expect((screen.getByLabelText(/게인/) as HTMLInputElement).value).toBe(
        String(CLIP_GAIN_DB_MAX),
      );
    });

    fireEvent.click(screen.getByRole('button', { name: '되돌리기' }));
    await waitFor(() => {
      expect((screen.getByLabelText(/게인/) as HTMLInputElement).value).toBe(before);
    });
  });

  it('names the clip a refused move collided with, and does not move it (Req 28.8)', async () => {
    mount(createDemoApi(), <TimelinePage />);

    const start = await screen.findByLabelText(/시작 위치/);
    const startBefore = (start as HTMLInputElement).value;

    // clip-1 plays for 24 s from 0 on track 0; clip-3 is a 1.4 s stinger at 30 s on the same
    // track. Dragging clip-1 to 20 s would swallow it, so the planner must refuse.
    fireEvent.change(start, { target: { value: '20000' } });

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('clip-3');
    expect(alert.textContent).toMatch(/겹칩니다/);

    // The refusal left the clip where it was — a screen that clamped to the legal range would
    // move it somewhere the user did not ask for, and this is the assertion that forbids it.
    expect((screen.getByLabelText(/시작 위치/) as HTMLInputElement).value).toBe(startBefore);
  });

  it('splits a clip in the middle (Req 28.14)', async () => {
    mount(createDemoApi(), <TimelinePage />);

    const header = await screen.findByText(/클립 \d+개/);
    const before = Number(/클립 (\d+)개/.exec(header.textContent ?? '')?.[1]);

    fireEvent.click(screen.getByRole('button', { name: /분할/ }));

    await waitFor(() => {
      const after = Number(
        /클립 (\d+)개/.exec(screen.getByText(/클립 \d+개/).textContent ?? '')?.[1],
      );
      expect(after).toBe(before + 1);
    });
  });
});

describe('마스터링', () => {
  it('shows the suggestion’s provenance and licence beside the chain (Reqs 30.21, 30.23)', async () => {
    mount(createDemoApi(), <MasteringPage assetId="asset-night-drive" />);

    expect(await screen.findByText('모델 제안')).toBeTruthy();
    expect(screen.getByText('deepafx-st')).toBeTruthy();
    // Requirement 30.23: two identical chains can carry different licences, so it is shown.
    expect(screen.getByText(/상업적 이용 불가/)).toBeTruthy();
  });

  it('reports the measurement it was made against (Reqs 30.22, 30.24)', async () => {
    mount(createDemoApi(), <MasteringPage assetId="asset-night-drive" />);

    expect(await screen.findByText(/통합 라우드니스 -18\.2 LUFS/)).toBeTruthy();
    expect(screen.getByText(/트루 피크 -0\.4 dBTP/)).toBeTruthy();
    // Requirement 30.22: exactly ten octave bands.
    expect(screen.getAllByTitle(/Hz .*dB/)).toHaveLength(10);
  });

  it('keeps A and B side by side and only calls B edited when it differs (Reqs 30.3, 30.4)', async () => {
    mount(createDemoApi(), <MasteringPage assetId="asset-night-drive" />);

    // Nothing stored yet, so B starts as the suggestion — and must not be labelled an edit.
    expect(await screen.findByText(/제안과 동일/)).toBeTruthy();

    const b = screen.getByRole('heading', { name: /B · 내 편집/ }).parentElement as HTMLElement;
    fireEvent.change(within(b).getByLabelText('gain gain_db'), { target: { value: '6' } });

    await waitFor(() => {
      expect(screen.getByText(/편집됨/)).toBeTruthy();
    });
    // A is untouched: Requirement 30.3 keeps the suggestion whatever the user did to it.
    const a = screen.getByRole('heading', { name: /A · 제안/ }).parentElement as HTMLElement;
    expect((within(a).getByLabelText('gain gain_db') as HTMLInputElement).value).toBe('3.4');
  });

  it('adds and removes chain items across the eight kinds (Reqs 29.1, 29.13)', async () => {
    mount(createDemoApi(), <MasteringPage assetId="asset-night-drive" />);

    const b = (await screen.findByRole('heading', { name: /B · 내 편집/ }))
      .parentElement as HTMLElement;
    fireEvent.change(within(b).getByRole('combobox'), { target: { value: 'reverb' } });

    // By one of its parameter controls rather than by the text 'reverb', which also names an
    // `<option>` in the add-effect select — the control would satisfy a text query on its own.
    await waitFor(() => {
      expect(within(b).getByLabelText('reverb room_size')).toBeTruthy();
    });
    // Requirements 29.30/29.32: reverb is the tail-extending kind, and the screen says so.
    expect(within(b).getByText('꼬리 연장')).toBeTruthy();

    fireEvent.click(within(b).getByRole('button', { name: 'reverb 제거' }));
    await waitFor(() => {
      expect(within(b).queryByLabelText('reverb room_size')).toBeNull();
    });
  });

  it('previews without minting a version (Req 29.28)', async () => {
    const api = createDemoApi();
    mount(api, <MasteringPage assetId="asset-night-drive" />);

    const before = await api.versions('asset-night-drive');
    fireEvent.click(await screen.findByRole('button', { name: /미리듣기/ }));

    expect(await screen.findByText(/미리듣기 스트림/)).toBeTruthy();
    // The clause's whole content: a preview streams and stores nothing.
    expect(await api.versions('asset-night-drive')).toHaveLength(before.length);
  });

  it('saves a version, and promoting one demotes every other (Req 29.34)', async () => {
    const api = createDemoApi();
    mount(api, <MasteringPage assetId="asset-night-drive" />);

    // The original is the default until something else is promoted, so it has no promote button.
    expect(await screen.findByRole('heading', { name: /버전/ })).toBeTruthy();
    expect(screen.getAllByText('기본 버전')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /초기 마스터 기본 버전으로 지정/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '새 버전으로 저장' }));
    fireEvent.click(await screen.findByRole('button', { name: /마스터 1 기본 버전으로 지정/ }));

    // The original lost the default and now offers the button it did not have a moment ago.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /초기 마스터 기본 버전으로 지정/ })).toBeTruthy();
    });
    // Exactly one default, which is the invariant `validateVersionSet` states.
    expect(screen.getAllByText('기본 버전')).toHaveLength(1);
  });

  it('refuses to apply an empty chain, quoting the minimum (Req 29.13)', async () => {
    mount(createDemoApi(), <MasteringPage assetId="asset-night-drive" />);

    const b = (await screen.findByRole('heading', { name: /B · 내 편집/ }))
      .parentElement as HTMLElement;
    for (const name of ['highpass 제거', 'compressor 제거', 'gain 제거']) {
      fireEvent.click(within(b).getByRole('button', { name }));
    }

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('최소 1개');
    expect(
      (screen.getByRole('button', { name: '새 버전으로 저장' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    // Requirement 29.28's preview is refused for the same reason: there is no chain to hear.
    expect(
      (screen.getByRole('button', { name: /미리듣기/ }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
