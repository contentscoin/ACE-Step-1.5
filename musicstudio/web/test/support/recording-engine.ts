/**
 * A `SoundEnginePort` that records instead of sounding.
 *
 * There is no `AudioContext` in the test environment, and there should not be: every rule
 * Requirement 32 states about playing is a rule about *which voices exist*, and asserting it
 * against real audio would mean asserting on sound. This double answers the same questions the
 * real engine does — which handles are live, which sources they carry, what order things happened
 * in — and answers them exactly.
 *
 * `swapDelayMs` exists for Requirement 32.9's 500 ms budget: a swap that resolved instantly would
 * make the deadline unmeasurable, so the test can give it a cost and check the total.
 */

import type { CueVoicing } from '../../src/sound/packs';
import type { SoundEnginePort } from '../../src/sound/engine';

export interface EngineEvent {
  readonly kind: 'start' | 'stop' | 'swap' | 'volume' | 'unlock' | 'stopAll';
  readonly handle?: string;
  readonly voicing?: CueVoicing;
  readonly volume?: number;
}

export interface RecordingEngine extends SoundEnginePort {
  readonly events: readonly EngineEvent[];
  /** Handles the engine believes are currently sounding. */
  live(): readonly string[];
  sourceOf(handle: string): CueVoicing | undefined;
  unlockCount(): number;
}

export function createRecordingEngine(swapDelayMs = 0): RecordingEngine {
  const events: EngineEvent[] = [];
  const sources = new Map<string, CueVoicing>();
  let unlocks = 0;

  return {
    events,

    startVoice(handle, voicing, _loop, volume) {
      sources.set(handle, voicing);
      events.push({ kind: 'start', handle, voicing, volume });
    },

    stopVoice(handle) {
      sources.delete(handle);
      events.push({ kind: 'stop', handle });
    },

    async swapVoiceSource(handle, voicing, volume) {
      if (swapDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, swapDelayMs));
      }
      // A swap on a handle the engine does not hold is a no-op, as in the real engine — the
      // layer may have stopped the loop while the load was in flight.
      if (sources.has(handle)) sources.set(handle, voicing);
      events.push({ kind: 'swap', handle, voicing, volume });
    },

    setVolume(volume) {
      events.push({ kind: 'volume', volume });
    },

    async unlock() {
      unlocks += 1;
      events.push({ kind: 'unlock' });
    },

    stopAll() {
      sources.clear();
      events.push({ kind: 'stopAll' });
    },

    live() {
      return [...sources.keys()];
    },

    sourceOf(handle) {
      return sources.get(handle);
    },

    unlockCount() {
      return unlocks;
    },
  };
}

/** A `SettingsStorePort` backed by a plain map, so a test can seed and inspect it. */
export function createMemoryStore(seed: Readonly<Record<string, string>> = {}) {
  const entries = new Map<string, string>(Object.entries(seed));
  return {
    read(key: string): string | null {
      return entries.get(key) ?? null;
    },
    write(key: string, value: string): void {
      entries.set(key, value);
    },
    snapshot(): Readonly<Record<string, string>> {
      return Object.fromEntries(entries);
    },
  };
}
