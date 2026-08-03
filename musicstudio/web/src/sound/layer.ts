/**
 * `UISoundLayer` — design §8.3's interface, composed from the policy, an engine and a settings
 * store.
 *
 * **Validates: Requirements 32.2, 32.3, 32.4, 32.5, 32.6, 32.7, 32.8, 32.9, 32.10, 32.11, 32.12,
 * 32.13, 32.14, 32.19, 32.21, 32.22, 32.23**
 *
 * ### This file carries decisions out; it does not make them
 *
 * `policy.ts` answers "what should happen", `engine.ts` makes noise, `settings.ts` remembers. What
 * is left here is sequencing, and it is deliberately the smallest of the four: every rule that
 * could be got subtly wrong is somewhere a test can reach without a browser.
 *
 * ### A failed pack switch rolls back both halves
 *
 * Requirement 32.23 says that if the new pack lacks a sounding loop's cue, or the load exceeds
 * three seconds, the loop keeps the **old audio** *and* the selected-pack setting returns to its
 * previous value *and* an error is surfaced. Three things, and the tempting implementation does
 * the first two in the wrong order — setting the pack, starting the swaps, and unwinding on
 * failure leaves the setting written and the audio half-swapped.
 *
 * So the pack is resolved and every swap awaited **before** `settings.packId` moves. Nothing is
 * persisted until the switch has succeeded, which makes the rollback the absence of an action
 * rather than the undoing of one.
 */

import type { SemanticCue } from './cues';
import { createWebAudioEngine, type SoundEnginePort } from './engine';
import { soundPack, type SoundPackId } from './packs';
import {
  decidePlay,
  initialPolicyState,
  withAllStopped,
  withLoopsStopped,
  withVoiceStopped,
  type PlayResult,
  type PolicyState,
  type Voice,
} from './policy';
import {
  browserSettingsStore,
  DEFAULT_SOUND_SETTINGS,
  isValidVolume,
  loadSettings,
  saveSettings,
  type SettingsStorePort,
  type SoundSettings,
} from './settings';

/** Requirement 32.23's deadline for a pack's asset to be ready. */
export const PACK_SWITCH_TIMEOUT_MS = 3_000;

export type PackSwitchOutcome =
  | { readonly ok: true; readonly packId: SoundPackId }
  /** Requirement 32.23: what was kept, and why the switch did not happen. */
  | {
      readonly ok: false;
      readonly packId: SoundPackId;
      readonly reason: 'cue_missing_in_pack' | 'load_timeout';
      readonly message: string;
    };

export type VolumeOutcome =
  | { readonly ok: true; readonly volume: number }
  /** Requirement 32.11: the previous value is kept and the permitted range is named. */
  | { readonly ok: false; readonly volume: number; readonly message: string };

export interface UISoundLayer {
  play(cue: SemanticCue): PlayResult;
  stopLoop(handle: string): void;
  /** Requirement 32.7: stop the loop that represents this cue, whichever handle it has. */
  stopCue(cue: SemanticCue): void;
  setVolume(volume: number): VolumeOutcome;
  setEnabled(enabled: boolean): void;
  switchPack(packId: SoundPackId): Promise<PackSwitchOutcome>;
  /** Requirement 32.3. Idempotent — the gesture listener may fire more than once. */
  unlock(): Promise<void>;
  /** Requirement 32.19. */
  stopAllLoops(): void;
  settings(): SoundSettings;
  voiceCount(): number;
  subscribe(listener: (event: SoundLayerEvent) => void): () => void;
}

/** What the announcer (Requirement 32.15) and the settings panel listen to. */
export type SoundLayerEvent =
  | { readonly kind: 'cue'; readonly cue: SemanticCue; readonly result: PlayResult }
  | { readonly kind: 'settings'; readonly settings: SoundSettings }
  | { readonly kind: 'error'; readonly message: string };

export interface SoundLayerOptions {
  readonly engine?: SoundEnginePort;
  readonly store?: SettingsStorePort;
  readonly now?: () => number;
  /**
   * How a pack's asset for a cue is made ready. Present so Requirement 32.23's timeout and
   * missing-asset paths are reachable in a test; the synthesised packs resolve immediately.
   */
  readonly loadCue?: (packId: SoundPackId, cue: SemanticCue) => Promise<boolean>;
}

export function createUISoundLayer(options: SoundLayerOptions = {}): UISoundLayer {
  const engine = options.engine ?? createWebAudioEngine();
  const store = options.store ?? browserSettingsStore();
  const now = options.now ?? (() => Date.now());
  const loadCue = options.loadCue ?? (async () => true);

  // Requirement 32.13: restored per field, defaults for the rest.
  let settings = loadSettings(store);
  let state: PolicyState = initialPolicyState(settings.enabled);
  const listeners = new Set<(event: SoundLayerEvent) => void>();

  function emit(event: SoundLayerEvent): void {
    for (const listener of listeners) listener(event);
  }

  function handleFor(cue: SemanticCue, sequence: number): string {
    // The cue is in the handle so a log line is readable; the sequence is what makes it unique.
    return `${cue}#${String(sequence)}`;
  }

  function loopVoices(): readonly Voice[] {
    return state.voices.filter((voice) => voice.loop);
  }

  return {
    play(cue) {
      const decision = decidePlay(state, cue, now(), handleFor);
      state = decision.state;

      if (decision.kind === 'start') {
        const voicing = soundPack(settings.packId).voicing(cue);
        // Requirement 32.21: the evicted one-shot stops *before* the new voice starts, so the
        // count never momentarily exceeds eight even inside this function.
        if (decision.evict !== null) engine.stopVoice(decision.evict.handle);
        engine.startVoice(decision.voice.handle, voicing, decision.voice.loop, settings.volume);
        // A one-shot's voice ends on its own; the policy has to hear about it or the cap fills up
        // with sounds that already stopped. Scheduled off the voicing's own length — the pack
        // decides how long a cue is, so the pack is what the retirement timer reads.
        if (!decision.voice.loop) {
          const handle = decision.voice.handle;
          setTimeout(() => {
            state = withVoiceStopped(state, handle);
          }, voicing.durationMs);
        }
      }

      emit({ kind: 'cue', cue, result: decision.result });
      return decision.result;
    },

    stopLoop(handle) {
      engine.stopVoice(handle);
      state = withVoiceStopped(state, handle);
    },

    stopCue(cue) {
      for (const voice of state.voices) {
        if (voice.cue === cue) {
          engine.stopVoice(voice.handle);
          state = withVoiceStopped(state, voice.handle);
        }
      }
    },

    setVolume(volume) {
      // Requirement 32.11: refuse, keep the previous value, name the range.
      if (!isValidVolume(volume)) {
        const message = '음량은 0.0 이상 1.0 이하여야 합니다.';
        emit({ kind: 'error', message });
        return { ok: false, volume: settings.volume, message };
      }
      settings = { ...settings, volume };
      engine.setVolume(volume);
      saveSettings(store, settings);
      emit({ kind: 'settings', settings });
      return { ok: true, volume };
    },

    setEnabled(enabled) {
      settings = { ...settings, enabled };
      if (!enabled) {
        // Requirement 32.14: the voice count goes to zero, loops included — a status loop still
        // sounding after the user switched sound off is the one thing this clause forbids.
        const { state: next, stopped } = withAllStopped(state);
        for (const voice of stopped) engine.stopVoice(voice.handle);
        state = next;
      }
      state = { ...state, enabled };
      saveSettings(store, settings);
      emit({ kind: 'settings', settings });
    },

    async switchPack(packId) {
      const sounding = loopVoices();

      // Requirement 32.23's two failure modes, both resolved before anything changes.
      const ready = await Promise.all(
        sounding.map(async (voice) => {
          const decided = await Promise.race([
            loadCue(packId, voice.cue),
            new Promise<'timeout'>((resolve) => {
              setTimeout(() => {
                resolve('timeout');
              }, PACK_SWITCH_TIMEOUT_MS);
            }),
          ]);
          return { voice, decided };
        }),
      );

      const timedOut = ready.find((entry) => entry.decided === 'timeout');
      const missing = ready.find((entry) => entry.decided === false);
      if (timedOut !== undefined || missing !== undefined) {
        const reason = timedOut !== undefined ? 'load_timeout' : 'cue_missing_in_pack';
        const message =
          reason === 'load_timeout'
            ? '새 사운드 팩을 3초 안에 준비하지 못해 이전 팩을 유지합니다.'
            : '새 팩에 진행 중인 큐의 자산이 없어 이전 팩을 유지합니다.';
        // Nothing was written and nothing was swapped, so "roll back" is simply returning.
        emit({ kind: 'error', message });
        return { ok: false, packId: settings.packId, reason, message };
      }

      // Requirement 32.9: the handles do not move; only each loop's source does.
      const pack = soundPack(packId);
      await Promise.all(
        sounding.map((voice) =>
          engine.swapVoiceSource(voice.handle, pack.voicing(voice.cue), settings.volume),
        ),
      );

      settings = { ...settings, packId };
      saveSettings(store, settings);
      emit({ kind: 'settings', settings });
      return { ok: true, packId };
    },

    async unlock() {
      if (state.unlocked) return;
      await engine.unlock();
      // Requirement 32.4's last clause: playback resumes for requests arriving *after* this, and
      // the ones suppressed while locked are not replayed. Nothing is queued, so nothing can be.
      state = { ...state, unlocked: true };
    },

    stopAllLoops() {
      const { state: next, stopped } = withLoopsStopped(state);
      for (const voice of stopped) engine.stopVoice(voice.handle);
      state = next;
    },

    settings() {
      return settings;
    },

    voiceCount() {
      return state.voices.length;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export { DEFAULT_SOUND_SETTINGS };
