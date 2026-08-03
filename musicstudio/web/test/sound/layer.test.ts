/**
 * The layer end to end, against a recording engine.
 *
 * **Validates: Requirements 32.4, 32.7, 32.9, 32.11, 32.12, 32.13, 32.14, 32.19, 32.23**
 *
 * These are the clauses that are about *sequencing* rather than about a decision — an unlock that
 * gates, a pack switch that either happens completely or not at all, a disable that empties the
 * layer. The policy tests cover what should happen; this covers whether it did.
 */

import { describe, expect, it, vi } from 'vitest';

import { PACK_SWITCH_TIMEOUT_MS, createUISoundLayer } from '../../src/sound/layer';
import { SETTINGS_KEYS } from '../../src/sound/settings';
import { createMemoryStore, createRecordingEngine } from '../support/recording-engine';

function makeLayer(
  overrides: Partial<Parameters<typeof createUISoundLayer>[0]> = {},
  seed: Readonly<Record<string, string>> = {},
) {
  const engine = createRecordingEngine();
  const store = createMemoryStore(seed);
  let clock = 10_000;
  const layer = createUISoundLayer({
    engine,
    store,
    now: () => clock,
    ...overrides,
  });
  return {
    engine,
    store,
    layer,
    advance(ms: number) {
      clock += ms;
    },
  };
}

describe('잠금 해제 (Reqs 32.3, 32.4)', () => {
  it('plays nothing before unlock, and says why', () => {
    const { layer, engine } = makeLayer();

    const result = layer.play('generation.succeeded');

    expect(result.played).toBe(false);
    expect(result.suppressionReason).toBe('unlock_pending');
    expect(engine.events).toHaveLength(0);
    expect(layer.voiceCount()).toBe(0);
  });

  it('plays only requests arriving after the unlock — nothing is replayed', async () => {
    const { layer, engine } = makeLayer();

    layer.play('generation.succeeded');
    layer.play('generation.failed');
    await layer.unlock();

    // The two suppressed requests are gone, not queued: Requirement 32.4's last clause.
    expect(engine.events.filter((event) => event.kind === 'start')).toHaveLength(0);

    layer.play('generation.cancelled');
    expect(engine.events.filter((event) => event.kind === 'start')).toHaveLength(1);
  });

  it('unlocks the engine once however many times it is asked', async () => {
    const { layer, engine } = makeLayer();
    await layer.unlock();
    await layer.unlock();
    await layer.unlock();
    expect(engine.unlockCount()).toBe(1);
  });
});

describe('사운드 비활성 (Req 32.14)', () => {
  it('reports the reason and holds the voice count at zero', async () => {
    const { layer, engine } = makeLayer();
    await layer.unlock();

    layer.play('generation.running');
    expect(layer.voiceCount()).toBe(1);

    layer.setEnabled(false);
    // Loops included: a status loop still sounding after the user switched sound off is the one
    // thing this clause forbids.
    expect(layer.voiceCount()).toBe(0);
    expect(engine.live()).toHaveLength(0);

    const result = layer.play('generation.running');
    expect(result.played).toBe(false);
    expect(result.suppressionReason).toBe('sound_disabled');
    expect(layer.voiceCount()).toBe(0);
  });
});

describe('루프 정지 (Reqs 32.7, 32.19)', () => {
  it('stops the loop for a cue whose state ended', async () => {
    const { layer, engine } = makeLayer();
    await layer.unlock();

    const started = layer.play('generation.running');
    expect(engine.live()).toContain(started.handle);

    layer.stopCue('generation.running');
    expect(engine.live()).not.toContain(started.handle);
    expect(layer.voiceCount()).toBe(0);
  });

  it('stops every loop and leaves one-shots alone (Req 32.19)', async () => {
    const { layer, engine } = makeLayer();
    await layer.unlock();

    const loop = layer.play('generation.running');
    const oneShot = layer.play('generation.succeeded');
    expect(layer.voiceCount()).toBe(2);

    layer.stopAllLoops();

    expect(engine.live()).not.toContain(loop.handle);
    // The one-shot is a few hundred milliseconds long and ends by itself; stopping it would be
    // this clause doing more than it says.
    expect(engine.live()).toContain(oneShot.handle);
  });
});

describe('음량 (Reqs 32.11, 32.12)', () => {
  it('accepts both ends of the range and persists them', () => {
    const { layer, store } = makeLayer();

    expect(layer.setVolume(0).ok).toBe(true);
    expect(store.read(SETTINGS_KEYS.volume)).toBe('0');
    expect(layer.setVolume(1).ok).toBe(true);
    expect(store.read(SETTINGS_KEYS.volume)).toBe('1');
  });

  it('refuses out of range, keeps the previous value and names the range (Req 32.11)', () => {
    const { layer, store } = makeLayer();
    layer.setVolume(0.4);

    for (const bad of [-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const outcome = layer.setVolume(bad);
      expect(outcome.ok).toBe(false);
      expect(outcome.volume).toBe(0.4);
      expect(outcome.ok || outcome.message).toContain('0.0');
    }
    // Nothing was written, so a reload comes back to the value the user last set successfully.
    expect(store.read(SETTINGS_KEYS.volume)).toBe('0.4');
    expect(layer.settings().volume).toBe(0.4);
  });
});

describe('설정 복원 (Req 32.13)', () => {
  it('applies the defaults when storage is empty', () => {
    const { layer } = makeLayer();
    expect(layer.settings()).toEqual({ enabled: true, volume: 0.5, packId: 'soft' });
  });

  it('restores the fields that have a value and defaults the rest', () => {
    // Only a volume stored — the shape a session written before the pack setting existed has.
    const { layer } = makeLayer({}, { [SETTINGS_KEYS.volume]: '0.2' });
    expect(layer.settings()).toEqual({ enabled: true, volume: 0.2, packId: 'soft' });
  });

  it('treats a malformed value as absent without discarding its neighbours', () => {
    const { layer } = makeLayer(
      {},
      {
        [SETTINGS_KEYS.volume]: 'loud',
        [SETTINGS_KEYS.packId]: 'nonexistent-pack',
        [SETTINGS_KEYS.enabled]: 'false',
      },
    );
    // The one good field survives; a whole-record fallback would have thrown it away.
    expect(layer.settings()).toEqual({ enabled: false, volume: 0.5, packId: 'soft' });
  });
});

describe('팩 전환 (Reqs 32.9, 32.23)', () => {
  it('keeps every loop handle and swaps only the source, inside 500 ms', async () => {
    const engine = createRecordingEngine(60);
    const layer = createUISoundLayer({ engine, store: createMemoryStore(), now: () => 1_000 });
    await layer.unlock();

    const a = layer.play('generation.running');
    const b = layer.play('mastering.analysis.running');
    const before = engine.sourceOf(a.handle as string);

    const startedAt = Date.now();
    const outcome = await layer.switchPack('crisp');
    const elapsed = Date.now() - startedAt;

    expect(outcome.ok).toBe(true);
    // Requirement 32.9: the handles are the same values they were.
    expect(engine.live()).toContain(a.handle);
    expect(engine.live()).toContain(b.handle);
    expect(engine.sourceOf(a.handle as string)).not.toEqual(before);
    // The swaps run concurrently, so two 60 ms loads are not 120 ms — and both are far inside
    // the clause's 500 ms.
    expect(elapsed).toBeLessThan(500);
  });

  it('rolls back the setting and the audio when the new pack lacks a sounding cue (Req 32.23)', async () => {
    const engine = createRecordingEngine();
    const store = createMemoryStore();
    const layer = createUISoundLayer({
      engine,
      store,
      now: () => 1_000,
      loadCue: async (_packId, cue) => cue !== 'generation.running',
    });
    await layer.unlock();

    const running = layer.play('generation.running');
    const before = engine.sourceOf(running.handle as string);

    const outcome = await layer.switchPack('crisp');

    expect(outcome.ok).toBe(false);
    expect(outcome.ok || outcome.reason).toBe('cue_missing_in_pack');
    // All three halves of the clause: the setting, the audio, and an error the user can see.
    expect(layer.settings().packId).toBe('soft');
    expect(store.read(SETTINGS_KEYS.packId)).toBeNull();
    expect(engine.sourceOf(running.handle as string)).toEqual(before);
    expect(engine.events.some((event) => event.kind === 'swap')).toBe(false);
  });

  it('rolls back when the load exceeds three seconds (Req 32.23)', async () => {
    vi.useFakeTimers();
    try {
      const engine = createRecordingEngine();
      const layer = createUISoundLayer({
        engine,
        store: createMemoryStore(),
        now: () => 1_000,
        // Never resolves inside the deadline.
        loadCue: () => new Promise<boolean>(() => undefined),
      });
      await layer.unlock();
      layer.play('generation.running');

      const pending = layer.switchPack('crisp');
      await vi.advanceTimersByTimeAsync(PACK_SWITCH_TIMEOUT_MS + 10);
      const outcome = await pending;

      expect(outcome.ok).toBe(false);
      expect(outcome.ok || outcome.reason).toBe('load_timeout');
      expect(layer.settings().packId).toBe('soft');
    } finally {
      vi.useRealTimers();
    }
  });

  it('switches with no loops sounding, because there is nothing to keep', async () => {
    const { layer } = makeLayer();
    await layer.unlock();
    const outcome = await layer.switchPack('crisp');
    expect(outcome.ok).toBe(true);
    expect(layer.settings().packId).toBe('crisp');
  });
});

describe('이벤트 구독', () => {
  it('reports every request, played or suppressed, so the announcer can decide', async () => {
    const { layer } = makeLayer();
    const seen: { cue: string; played: boolean }[] = [];
    layer.subscribe((event) => {
      if (event.kind === 'cue') seen.push({ cue: event.cue, played: event.result.played });
    });

    layer.play('generation.succeeded'); // locked
    await layer.unlock();
    layer.play('generation.succeeded');

    expect(seen).toEqual([
      { cue: 'generation.succeeded', played: false },
      { cue: 'generation.succeeded', played: true },
    ]);
  });
});
