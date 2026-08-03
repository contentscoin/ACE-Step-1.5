/**
 * Sound settings, and where they live between sessions.
 *
 * **Validates: Requirements 32.11, 32.12, 32.13**
 *
 * ### Restore is per field, not per record
 *
 * Requirement 32.13 restores "값이 있는 항목" from storage and defaults **the ones with no value**.
 * That is deliberately not "load the record or use defaults": a session that stored only a volume,
 * or a stored record written before the pack setting existed, must come back with the volume it
 * saved and the default for the rest. A whole-record fallback would throw away a stored volume
 * because a later field was missing, which is the upgrade path this clause is describing.
 *
 * So each field is read, validated and defaulted independently, and a malformed value is treated
 * as absent rather than as a reason to discard the others.
 */

import { DEFAULT_PACK_ID, isSoundPackId, type SoundPackId } from './packs';

export const VOLUME_MIN = 0.0;
export const VOLUME_MAX = 1.0;

/** Requirement 32.13's defaults. */
export const DEFAULT_SOUND_SETTINGS: SoundSettings = {
  enabled: true,
  volume: 0.5,
  packId: DEFAULT_PACK_ID,
};

export interface SoundSettings {
  readonly enabled: boolean;
  readonly volume: number;
  readonly packId: SoundPackId;
}

/** The seam over `localStorage`, so the layer is testable and SSR-safe. */
export interface SettingsStorePort {
  read(key: string): string | null;
  write(key: string, value: string): void;
}

export const SETTINGS_KEYS = {
  enabled: 'musicstudio.sound.enabled',
  volume: 'musicstudio.sound.volume',
  packId: 'musicstudio.sound.pack',
} as const;

/** Requirement 32.11: the range, inclusive at both ends. */
export function isValidVolume(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= VOLUME_MIN && value <= VOLUME_MAX;
}

export function loadSettings(store: SettingsStorePort): SoundSettings {
  const enabled = store.read(SETTINGS_KEYS.enabled);
  const volumeText = store.read(SETTINGS_KEYS.volume);
  const packId = store.read(SETTINGS_KEYS.packId);

  const volume = volumeText === null ? Number.NaN : Number(volumeText);

  return {
    // Only the two strings the writer produces count as a stored value; anything else is absent.
    enabled: enabled === 'true' ? true : enabled === 'false' ? false : DEFAULT_SOUND_SETTINGS.enabled,
    volume: isValidVolume(volume) ? volume : DEFAULT_SOUND_SETTINGS.volume,
    packId: isSoundPackId(packId) ? packId : DEFAULT_SOUND_SETTINGS.packId,
  };
}

/** Requirement 32.12: a change is written when it happens, not on unload. */
export function saveSettings(store: SettingsStorePort, settings: SoundSettings): void {
  store.write(SETTINGS_KEYS.enabled, String(settings.enabled));
  store.write(SETTINGS_KEYS.volume, String(settings.volume));
  store.write(SETTINGS_KEYS.packId, settings.packId);
}

/** `localStorage`, or a store that forgets when there is none (a private window, or SSR). */
export function browserSettingsStore(): SettingsStorePort {
  const memory = new Map<string, string>();
  return {
    read(key) {
      try {
        return globalThis.localStorage?.getItem(key) ?? memory.get(key) ?? null;
      } catch {
        // A blocked `localStorage` throws on access rather than returning null. Falling back to
        // memory keeps the session's settings working; they just do not survive it.
        return memory.get(key) ?? null;
      }
    },
    write(key, value) {
      memory.set(key, value);
      try {
        globalThis.localStorage?.setItem(key, value);
      } catch {
        // Same reason. The in-memory copy above already took the write.
      }
    },
  };
}
