/**
 * The sound layer as React context, plus the trusted-gesture unlock.
 *
 * **Validates: Requirements 32.3, 32.19**
 *
 * ### The unlock listener is `isTrusted`-gated and removes itself
 *
 * Requirement 32.3 says the **first trusted** pointer or keyboard interaction unlocks audio. Not
 * any event: `event.isTrusted` is false for anything a script dispatched, and a browser will not
 * resume an `AudioContext` for a synthetic gesture anyway. Unlocking on one would mark the layer
 * unlocked while the context stayed suspended, and every cue afterwards would report `played: true`
 * and make no sound — the worst of the available failures, because nothing reports it.
 *
 * ### The visibility handler is where Requirement 32.19 actually lives
 *
 * `visibilitychange` and `pagehide`, not `beforeunload`: `beforeunload` does not fire on mobile
 * Safari when an app is backgrounded, which is exactly the case the clause is about.
 */

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

import { createUISoundLayer, type SoundLayerOptions, type UISoundLayer } from './layer';

const SoundContext = createContext<UISoundLayer | null>(null);

export interface SoundProviderProps extends SoundLayerOptions {
  readonly layer?: UISoundLayer;
  readonly children: ReactNode;
}

export function SoundProvider({ layer, children, ...options }: SoundProviderProps): ReactNode {
  // Created once: the layer holds the voice list, and rebuilding it would silently orphan every
  // sounding loop's handle.
  const [fallback] = useState(() => createUISoundLayer(options));
  const sound = layer ?? fallback;

  useEffect(() => {
    const onGesture = (event: Event): void => {
      if (!event.isTrusted) return; // See the module header.
      void sound.unlock();
      remove();
    };
    const remove = (): void => {
      globalThis.removeEventListener('pointerdown', onGesture);
      globalThis.removeEventListener('keydown', onGesture);
    };
    globalThis.addEventListener('pointerdown', onGesture);
    globalThis.addEventListener('keydown', onGesture);
    return remove;
  }, [sound]);

  useEffect(() => {
    // Requirement 32.19: hidden document or ended session → every loop stops.
    const onHidden = (): void => {
      if (globalThis.document?.visibilityState === 'hidden') sound.stopAllLoops();
    };
    const onPageHide = (): void => {
      sound.stopAllLoops();
    };
    globalThis.document?.addEventListener('visibilitychange', onHidden);
    globalThis.addEventListener('pagehide', onPageHide);
    return () => {
      globalThis.document?.removeEventListener('visibilitychange', onHidden);
      globalThis.removeEventListener('pagehide', onPageHide);
    };
  }, [sound]);

  return <SoundContext.Provider value={sound}>{children}</SoundContext.Provider>;
}

export function useSound(): UISoundLayer {
  const sound = useContext(SoundContext);
  if (sound === null) throw new Error('a component used sound outside SoundProvider');
  return sound;
}
