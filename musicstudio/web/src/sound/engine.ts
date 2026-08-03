/**
 * The seam between the policy and the Web Audio API.
 *
 * **Validates: Requirements 32.2, 32.9, 32.18**
 *
 * ### One port, two implementations, and the reason for both
 *
 * Requirement 32.5's voice cap, 32.6's idempotence and 32.21's eviction are checked over generated
 * sequences, and a generated sequence cannot run against a real `AudioContext` — there is none in
 * the test environment, and even in a browser the assertions would be about audible output rather
 * than about the rule. `SoundEnginePort` is therefore the only thing the layer talks to, and the
 * deterministic engine in `test/support/` records what it was asked to do.
 *
 * The Web Audio implementation is small on purpose: create nodes, connect, schedule, stop. Every
 * decision worth arguing about happens before it is called.
 *
 * ### The context is created on first play, not on load
 *
 * Requirement 32.2 is explicit, and it is not a performance note: a page that constructs an
 * `AudioContext` at import time gets one in the `suspended` state, and Chrome logs a warning about
 * it on every load. `ensureContext` is called from `startVoice`, which is the first moment the
 * product has actually asked for a sound.
 *
 * ### Switching a loop's source keeps the gain node
 *
 * Requirement 32.9 keeps the *handle* stable across a pack change and caps the silent gap at
 * 50 ms. The handle is stable because the layer never re-registers the voice; the gap is bounded
 * because the gain node stays connected and only the oscillator is replaced, started at the
 * context's current time. Tearing down the gain node would make the gap a scheduling race.
 */

import type { CueVoicing } from './packs';

export interface SoundEnginePort {
  /** Requirement 32.2: creates the context if there is not one yet. */
  startVoice(handle: string, voicing: CueVoicing, loop: boolean, volume: number): void;
  stopVoice(handle: string): void;
  /** Requirement 32.9: same handle, new source, gap ≤ 50 ms. */
  swapVoiceSource(handle: string, voicing: CueVoicing, volume: number): Promise<void>;
  setVolume(volume: number): void;
  /** Requirement 32.3: called from the first trusted gesture. */
  unlock(): Promise<void>;
  stopAll(): void;
}

/** Requirement 32.9's ceiling, and the fade the swap uses so the join is not a click. */
export const SOURCE_SWAP_FADE_MS = 12;

interface LiveVoice {
  readonly gain: GainNode;
  oscillator: OscillatorNode;
  readonly loop: boolean;
  readonly peak: number;
}

/**
 * The Web Audio engine.
 *
 * Written against the minimal surface — `OscillatorNode`, `GainNode`, `AudioContext.currentTime` —
 * so it works in every browser the product targets without a compatibility layer.
 */
export function createWebAudioEngine(): SoundEnginePort {
  let context: AudioContext | null = null;
  let master: GainNode | null = null;
  const voices = new Map<string, LiveVoice>();

  function ensureContext(volume: number): { context: AudioContext; master: GainNode } {
    if (context !== null && master !== null) return { context, master };
    // Requirement 32.2 — here, and nowhere earlier.
    const created = new AudioContext();
    const gain = created.createGain();
    gain.gain.value = volume;
    gain.connect(created.destination);
    context = created;
    master = gain;
    return { context: created, master: gain };
  }

  function makeOscillator(
    audio: AudioContext,
    target: GainNode,
    voicing: CueVoicing,
    loop: boolean,
  ): OscillatorNode {
    const oscillator = audio.createOscillator();
    oscillator.type = voicing.wave;
    oscillator.frequency.value = voicing.frequencyHz;
    oscillator.connect(target);
    oscillator.start();
    // A one-shot ends itself. A loop runs until `stopVoice`, which is what makes Requirement
    // 32.7's "stop within 200 ms" a matter of calling it rather than of waiting for a length.
    if (!loop) oscillator.stop(audio.currentTime + voicing.durationMs / 1000);
    return oscillator;
  }

  return {
    startVoice(handle, voicing, loop, volume) {
      const { context: audio, master: bus } = ensureContext(volume);
      const gain = audio.createGain();
      // A short attack and release: a square wave started at full amplitude is a click, and a
      // click is what the user hears rather than the cue.
      gain.gain.setValueAtTime(0, audio.currentTime);
      gain.gain.linearRampToValueAtTime(voicing.peak, audio.currentTime + 0.01);
      if (!loop) {
        gain.gain.linearRampToValueAtTime(0, audio.currentTime + voicing.durationMs / 1000);
      }
      gain.connect(bus);
      voices.set(handle, {
        gain,
        oscillator: makeOscillator(audio, gain, voicing, loop),
        loop,
        peak: voicing.peak,
      });
    },

    stopVoice(handle) {
      const voice = voices.get(handle);
      if (voice === undefined) return;
      try {
        voice.oscillator.stop();
      } catch {
        // A one-shot whose `stop` was already scheduled throws on a second call. Nothing to do:
        // the voice is over either way, which is the state the caller wanted.
      }
      voice.oscillator.disconnect();
      voice.gain.disconnect();
      voices.delete(handle);
    },

    async swapVoiceSource(handle, voicing, volume) {
      const voice = voices.get(handle);
      if (voice === undefined) return;
      const { context: audio } = ensureContext(volume);

      // The gain node — and therefore the handle and the connection — survives. Only the
      // oscillator is replaced, and the new one starts before the old one stops, so the join is a
      // crossfade of `SOURCE_SWAP_FADE_MS` rather than a gap.
      const next = makeOscillator(audio, voice.gain, voicing, voice.loop);
      const previous = voice.oscillator;
      voice.oscillator = next;
      try {
        previous.stop(audio.currentTime + SOURCE_SWAP_FADE_MS / 1000);
      } catch {
        previous.disconnect();
      }
    },

    setVolume(volume) {
      if (master !== null && context !== null) {
        master.gain.setTargetAtTime(volume, context.currentTime, 0.01);
      }
    },

    async unlock() {
      // Requirement 32.3. `resume` is the whole of it: a context created inside a trusted gesture
      // is already running, and one created outside is suspended until this call.
      if (context !== null && context.state === 'suspended') await context.resume();
    },

    stopAll() {
      for (const handle of [...voices.keys()]) this.stopVoice(handle);
    },
  };
}
