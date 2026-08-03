/**
 * The visual half (Requirements 32.15, 32.16, 32.19).
 *
 * The 200 ms budget of Requirement 32.15 is not measured with a stopwatch here. It is established
 * structurally: the announcer subscribes synchronously and React renders in the same task, so the
 * test asserts the text is present *without awaiting anything*. A `waitFor` would pass even for an
 * implementation that took a second, which is the assertion the clause is trying to make.
 */

import { render, screen, act, cleanup, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CUE_ANNOUNCE_MIN_MS, CueAnnouncer } from '../../src/components/sound/CueAnnouncer';
import { SEVERITY_PRESENTATION } from '../../src/components/sound/CueAnnouncer';
import { SoundProvider } from '../../src/sound/context';
import { cueDefinition } from '../../src/sound/cues';
import { createUISoundLayer, type UISoundLayer } from '../../src/sound/layer';
import { createMemoryStore, createRecordingEngine } from '../support/recording-engine';

afterEach(cleanup);

function mountAnnouncer(): UISoundLayer {
  const layer = createUISoundLayer({
    engine: createRecordingEngine(),
    store: createMemoryStore(),
  });
  render(
    <SoundProvider layer={layer}>
      <CueAnnouncer />
    </SoundProvider>,
  );
  return layer;
}

describe('CueAnnouncer (Req 32.15)', () => {
  it('shows the status sentence and the mapped element in the same task as the cue', async () => {
    const layer = mountAnnouncer();
    await act(async () => {
      await layer.unlock();
    });

    act(() => {
      layer.play('generation.succeeded');
    });

    // No `waitFor`, no timers: the text is already there. See the module header.
    const definition = cueDefinition('generation.succeeded');
    expect(screen.getByRole('status').textContent).toContain(definition.status);
    expect(screen.getByRole('status').textContent).toContain(definition.elements[0]);
  });

  it('keeps the announcement for at least three seconds', async () => {
    vi.useFakeTimers();
    try {
      const layer = mountAnnouncer();
      await act(async () => {
        await layer.unlock();
      });
      act(() => {
        layer.play('generation.failed');
      });

      act(() => {
        vi.advanceTimersByTime(CUE_ANNOUNCE_MIN_MS - 100);
      });
      expect(screen.queryByRole('status')).not.toBeNull();

      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(screen.queryByRole('status')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('replaces rather than queues, so the newest state is the one shown', async () => {
    const layer = mountAnnouncer();
    await act(async () => {
      await layer.unlock();
    });

    act(() => {
      layer.play('generation.running');
      layer.play('generation.succeeded');
    });

    const shown = screen.getByRole('status');
    expect(shown.dataset.cue).toBe('generation.succeeded');
    expect(shown.textContent).not.toContain(cueDefinition('generation.running').status);
  });

  it('announces nothing for a suppressed cue', () => {
    const layer = mountAnnouncer(); // never unlocked

    act(() => {
      const result = layer.play('generation.succeeded');
      expect(result.played).toBe(false);
    });

    expect(screen.queryByRole('status')).toBeNull();
  });

  it('distinguishes the three states without colour (Req 32.16)', async () => {
    const layer = mountAnnouncer();
    await act(async () => {
      await layer.unlock();
    });

    for (const [cue, severity] of [
      ['generation.succeeded', 'success'],
      ['generation.cancelled', 'warning'],
      ['generation.failed', 'error'],
    ] as const) {
      act(() => {
        layer.play(cue);
      });
      const text = screen.getByRole('status').textContent ?? '';
      // Both non-colour channels present: the shape and the word.
      expect(text).toContain(SEVERITY_PRESENTATION[severity].shape);
      expect(text).toContain(SEVERITY_PRESENTATION[severity].label);
    }
  });
});

describe('SoundProvider', () => {
  it('unlocks on a trusted gesture and ignores a synthetic one (Req 32.3)', async () => {
    const layer = createUISoundLayer({
      engine: createRecordingEngine(),
      store: createMemoryStore(),
    });
    render(
      <SoundProvider layer={layer}>
        <CueAnnouncer />
      </SoundProvider>,
    );

    // `fireEvent` dispatches with `isTrusted: false`, which is exactly the case the guard is for:
    // the browser will not resume an AudioContext for it, so marking the layer unlocked would
    // make every later cue claim it played and make no sound.
    fireEvent.keyDown(globalThis.document, { key: 'a' });
    expect(layer.play('generation.succeeded').suppressionReason).toBe('unlock_pending');

    // A trusted event, as the browser would deliver it.
    const trusted = new KeyboardEvent('keydown', { key: 'a' });
    Object.defineProperty(trusted, 'isTrusted', { value: true });
    // `unlock` resumes the AudioContext, so it is async and the handler cannot be synchronous.
    // Flushing the microtask is what a real gesture's next frame would do anyway.
    await act(async () => {
      globalThis.dispatchEvent(trusted);
      await Promise.resolve();
    });
    expect(layer.play('generation.succeeded').suppressionReason).toBeUndefined();
  });

  it('stops every loop when the document is hidden (Req 32.19)', async () => {
    const layer = createUISoundLayer({
      engine: createRecordingEngine(),
      store: createMemoryStore(),
    });
    render(
      <SoundProvider layer={layer}>
        <CueAnnouncer />
      </SoundProvider>,
    );
    await act(async () => {
      await layer.unlock();
    });
    act(() => {
      layer.play('generation.running');
    });
    expect(layer.voiceCount()).toBe(1);

    Object.defineProperty(globalThis.document, 'visibilityState', {
      value: 'hidden',
      configurable: true,
    });
    act(() => {
      globalThis.document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(layer.voiceCount()).toBe(0);
  });
});
