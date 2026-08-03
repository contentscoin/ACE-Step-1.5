/**
 * The acceptance criterion of task 7.3: 생성 → 결과 확인 → 다운로드, rendered.
 *
 * **Validates: Requirements 3.1, 3.5, 3.6, 5.4, 5.5, 5.6, 6.1, 6.4, 11.5, 13.1, 13.4**
 *
 * ### The clock is moved, not waited for
 *
 * The demo backend derives a job's state from `now()` (see `demo-api.ts`), so this file passes its
 * own clock and steps it. A test that waited 8 real seconds for the same three states would be the
 * slowest file in the suite and would still be a race on a loaded machine.
 *
 * ### What is asserted is what the user can see
 *
 * Queries are by role and by text throughout — `getByRole('button', {name: 'WAV'})` rather than a
 * test id — because the claim being made is "the user can reach the download", and a test id can
 * be present on an element no user can reach. The one `data-testid` used is on the job panel,
 * where "the panel exists at all" has no accessible name to hang on.
 */

import { render, screen, act, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ReactNode } from 'react';

import { StudioApiProvider } from '../../src/lib/api/context';
import { createUISoundLayer } from '../../src/sound/layer';
import { SoundProvider } from '../../src/sound/context';
import { createMemoryStore, createRecordingEngine } from '../support/recording-engine';
import { createDemoApi } from '../../src/lib/api/demo-api';
import type { StudioApi } from '../../src/lib/api/port';
import { GeneratePage } from '../../src/pages/GeneratePage';
import { AssetPage } from '../../src/pages/AssetPage';

afterEach(cleanup);

/** A clock the test moves. */
function movableClock(startMs = 1_700_000_000_000) {
  let current = startMs;
  return {
    now: () => current,
    advance(ms: number) {
      current += ms;
    },
  };
}

/**
 * The screens fire sound cues, so they need a `SoundProvider` — and a recording engine rather than
 * a real one, because there is no `AudioContext` here. The layer is otherwise the production one:
 * a screen that played a cue with no table entry would still fail to typecheck.
 */
function mount(api: StudioApi, screenNode: ReactNode) {
  const sound = createUISoundLayer({
    engine: createRecordingEngine(),
    store: createMemoryStore(),
  });
  return render(
    <StudioApiProvider api={api}>
      <SoundProvider layer={sound}>{screenNode}</SoundProvider>
    </StudioApiProvider>,
  );
}

describe('생성 → 결과 확인 → 다운로드', () => {
  it('renders the whole flow, ending at a permitted download', async () => {
    const clock = movableClock();
    const api = createDemoApi({ now: clock.now, losslessAllowed: true });

    mount(api, <GeneratePage />);

    fireEvent.click(screen.getByRole('button', { name: '생성 요청' }));

    // Requirement 5.4: queued, with the queue position rather than a percentage.
    const panel = await screen.findByTestId('job-panel');
    expect(panel.textContent).toContain('대기');

    // Requirement 5.5: running, with a percentage. The demo job queues for 2 s and runs for 6 s.
    clock.advance(2_000 + 3_000);
    await act(async () => {
      await Promise.resolve();
    });
    // The screen polls every `PROGRESS_TEXT_REFRESH_MS` (1 s), so the wait has to be longer than
    // one interval — a 1 s default would be a coin flip on whether the tick landed inside it.
    await waitFor(
      () => {
        expect(screen.getByTestId('job-panel').textContent).toMatch(/\d+%/);
      },
      { timeout: 4_000 },
    );

    // Requirement 5.6: finished, and the asset it produced is reachable.
    clock.advance(6_000);
    const done = await screen.findByRole('button', { name: '결과 확인' }, { timeout: 4_000 });
    expect(done).toBeTruthy();

    // The button navigates by hash; asserting the id came back from the API is the same claim
    // without depending on `location` in a test environment.
    const produced = await api.jobStatus('job-1');
    const assetId = produced?.assetIds[0];
    expect(assetId).toBeTruthy();

    cleanup();
    mount(api, <AssetPage assetId={assetId as string} />);

    // Requirement 16.5's label is on the detail screen, and the player rendered its waveform.
    expect(await screen.findByText('AI 생성')).toBeTruthy();
    expect(screen.getByRole('group', { name: '파형' })).toBeTruthy();

    // Requirement 13.1: the formats this asset kind offers, and a permitted lossless download.
    fireEvent.click(screen.getByRole('button', { name: 'WAV' }));
    expect(await screen.findByText(/준비됨/)).toBeTruthy();
  });

  it('refuses a lossless download on a plan without it, and names the plans (Req 13.4)', async () => {
    const api = createDemoApi({ losslessAllowed: false });
    mount(api, <AssetPage assetId="asset-night-drive" />);

    fireEvent.click(await screen.findByRole('button', { name: 'WAV' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('상위 요금제');
    // The clause requires the *plans* to be named, not only that the download was refused.
    expect(alert.textContent).toContain('creator');
    expect(alert.textContent).toContain('studio');
  });

  it('shows every violated field at once rather than the first (Req 3.5)', async () => {
    const api = createDemoApi();
    mount(api, <GeneratePage />);

    fireEvent.click(screen.getByRole('button', { name: 'Custom 모드' }));
    // Two fields wrong in one submission: an out-of-range BPM and an out-of-range batch size.
    fireEvent.change(screen.getByLabelText(/BPM/), { target: { value: '9999' } });
    fireEvent.change(screen.getByLabelText(/배치/), { target: { value: '99' } });
    fireEvent.click(screen.getByRole('button', { name: '생성 요청' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('bpm');
    expect(alert.textContent).toContain('batchSize');
  });

  it('leaves an untouched field out of the request entirely (Reqs 3.3, 3.6, 4.7)', async () => {
    const seen: unknown[] = [];
    const inner = createDemoApi();
    const api: StudioApi = {
      ...inner,
      async submitSong(request) {
        seen.push(request);
        return inner.submitSong(request);
      },
    };

    mount(api, <GeneratePage />);
    fireEvent.click(screen.getByRole('button', { name: '생성 요청' }));

    await waitFor(() => {
      expect(seen).toHaveLength(1);
    });
    // Not `bpm === undefined`: the claim is that the *key* is absent, which is what the engine
    // reads as "you choose" and what `{bpm: undefined}` would not be.
    expect(Object.hasOwn(seen[0] as object, 'durationSeconds')).toBe(false);
    expect(Object.hasOwn(seen[0] as object, 'seed')).toBe(false);
  });
});
