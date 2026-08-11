/**
 * The demo backend must not claim what it does not do (track A of `docs/ROADMAP.md`).
 *
 * These are regression tests for three statements the UI used to make and could not back:
 *
 * 1. "재생" moved a playhead and synced lyrics while making **no sound at all** — `streamUrl` was
 *    never read and no media element existed.
 * 2. The download panel printed "준비됨: <name> · 약 35MB" for a file no code produced; the number
 *    was `duration × 48000 × channels × 2`, arithmetic wearing the clothes of a measurement.
 * 3. Nothing anywhere said the backend was a demo, so a visitor could submit a generation request,
 *    watch it progress, and reach an asset without ever learning that no model ran.
 *
 * Each test below fails if one of those returns. They assert the *artefact*, not the wording —
 * a test that only checked for new copy would pass again the moment the copy was restored over an
 * empty implementation, which is the failure being prevented.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

import { App } from '../../src/App';
import { StudioApiProvider } from '../../src/lib/api/context';
import { createDemoApi } from '../../src/lib/api/demo-api';
import { encodeWav, renderDemoTone, DEMO_SAMPLE_RATE } from '../../src/lib/api/demo-audio';
import { SoundProvider } from '../../src/sound/context';
import type { StudioApi } from '../../src/lib/api/port';

// Auto-cleanup is not configured for this suite, and a leftover tree from the previous case would
// make "the banner is absent" pass or fail on whichever test ran before it.
afterEach(() => {
  cleanup();
});

function mount(api: StudioApi, node: ReactNode): void {
  render(
    <StudioApiProvider api={api}>
      <SoundProvider>{node}</SoundProvider>
    </StudioApiProvider>,
  );
}

describe('the demo backend produces the audio it offers', () => {
  it('renders a tone whose length is the asset length, not a capped stand-in', () => {
    const tone = renderDemoTone('asset-night-drive', 184_000);
    expect(tone.sampleRate).toBe(DEMO_SAMPLE_RATE);
    expect(tone.samples.length).toBe(Math.round((184_000 / 1000) * DEMO_SAMPLE_RATE));
    // A capped renderer would agree with the transport for thirty seconds and disagree after.
    expect(tone.durationMs).toBe(184_000);
  });

  it('renders silence for a zero-length asset rather than a click', () => {
    expect(renderDemoTone('asset-x', 0).samples.length).toBe(0);
  });

  it('is deterministic in the asset id, so a second download is the same file', () => {
    const first = renderDemoTone('asset-neon-rush', 4_000);
    const second = renderDemoTone('asset-neon-rush', 4_000);
    expect(Array.from(first.samples.slice(0, 64))).toEqual(Array.from(second.samples.slice(0, 64)));
  });

  it('gives different assets audibly different material', () => {
    const a = renderDemoTone('asset-night-drive', 2_000).samples.slice(0, 256);
    const b = renderDemoTone('asset-rain-window', 2_000).samples.slice(0, 256);
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  it('stays inside the rails, so encoding cannot wrap a sample to the opposite sign', () => {
    const tone = renderDemoTone('asset-night-drive', 3_000);
    for (const sample of tone.samples) expect(Math.abs(sample)).toBeLessThanOrEqual(1);
  });

  it('encodes a WAV whose header describes the samples that follow it', () => {
    const tone = renderDemoTone('asset-neon-rush', 1_000);
    const bytes = new Uint8Array(encodeWav(tone));
    const view = new DataView(bytes.buffer);
    const ascii = (offset: number, length: number): string =>
      String.fromCharCode(...bytes.slice(offset, offset + length));

    expect(ascii(0, 4)).toBe('RIFF');
    expect(ascii(8, 4)).toBe('WAVE');
    expect(ascii(12, 4)).toBe('fmt ');
    expect(ascii(36, 4)).toBe('data');
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(DEMO_SAMPLE_RATE);
    expect(view.getUint16(34, true)).toBe(16); // bits per sample
    // The declared data length and the buffer must agree; a header that over-declares produces a
    // file that plays as a burst of noise past the end of the samples.
    expect(view.getUint32(40, true)).toBe(tone.samples.length * 2);
    expect(bytes.byteLength).toBe(44 + tone.samples.length * 2);
  });
});

describe('the download panel reports a file that exists', () => {
  it('fetchDownload returns bytes, and planDownload reports that exact size', async () => {
    const api = createDemoApi();
    const outcome = await api.planDownload('asset-night-drive', 'mp3', false);
    expect(outcome.ruling.allowed).toBe(true);

    const file = await api.fetchDownload('asset-night-drive', 'mp3');
    expect(file.blob.size).toBeGreaterThan(0);
    // The panel prints `bytes`. If it is an estimate again, this is where it diverges.
    expect(outcome.bytes).toBe(file.blob.size);
  });

  it('names the file after what it contains, not after what was requested', async () => {
    const api = createDemoApi();
    const file = await api.fetchDownload('asset-night-drive', 'mp3');
    // The demo has no encoder. A `.mp3` holding RIFF bytes fails to open with an error naming the
    // wrong cause, so the delivered format is reported and the extension matches the container.
    expect(file.deliveredFormat).toBe('wav');
    expect(file.fileName.endsWith('.wav')).toBe(true);
  });

  it('a refused ruling carries no file to fetch', async () => {
    const api = createDemoApi();
    // Requirement 13.4: lossless without the entitlement. The refusal is the product's answer and
    // must not arrive as an empty download.
    const outcome = await api.planDownload('asset-night-drive', 'flac', true);
    expect(outcome.ruling.allowed).toBe(false);
    expect(outcome.bytes).toBeUndefined();
    expect(outcome.fileName).toBeUndefined();
  });
});

describe('the app says which backend it is talking to', () => {
  it('the demo backend identifies itself', () => {
    expect(createDemoApi().backend.kind).toBe('demo');
  });

  it('shows the demo banner, and it states that no music is generated', () => {
    render(<App />);
    const banner = screen.getByRole('note', { name: '데모 모드 안내' });
    expect(banner.textContent).toContain('데모 모드');
    expect(banner.textContent).toContain('음악은 생성되지 않습니다');
  });

  it('hides the banner for a gateway backend, without a build flag', () => {
    const gateway: StudioApi = { ...createDemoApi(), backend: { kind: 'gateway' } };
    mount(gateway, <div />);
    expect(screen.queryByRole('note', { name: '데모 모드 안내' })).toBeNull();
  });
});
