/**
 * The sound settings a user actually turns (Requirements 32.10, 32.11, 32.12, 32.13, 32.20).
 *
 * The controls do not hold the settings — the layer does, and this reads them back from the event
 * it emits. A slider that kept its own number would show a volume the layer refused (Requirement
 * 32.11 keeps the *previous* value on a bad request), and the two would disagree exactly when the
 * refusal message was on screen saying they should not.
 */

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { SEMANTIC_CUE_NAMES } from '../../sound/cues';
import { useSound } from '../../sound/context';
import { SOUND_PACKS, SOUND_PACK_IDS, type SoundPackId } from '../../sound/packs';
import { VOLUME_MAX, VOLUME_MIN, type SoundSettings } from '../../sound/settings';
import { button, chip, label, meta, panel, refusal, row, tabular } from '../../styles/ui';

export function SoundSettingsPanel(): ReactNode {
  const sound = useSound();
  const [settings, setSettings] = useState<SoundSettings>(() => sound.settings());
  const [error, setError] = useState<string | null>(null);

  useEffect(
    () =>
      sound.subscribe((event) => {
        if (event.kind === 'settings') {
          setSettings(event.settings);
          setError(null);
        }
        if (event.kind === 'error') setError(event.message);
      }),
    [sound],
  );

  return (
    <div style={panel}>
      <h2 style={{ marginTop: 0, fontSize: 18 }}>인터페이스 사운드 (Req 32)</h2>
      <p style={meta}>
        {SEMANTIC_CUE_NAMES.length}개 Semantic_Cue · 동시 재생 {sound.voiceCount()}개 · 소리는
        화면 표시를 보강할 뿐이며, 꺼도 모든 정보는 화면에 남습니다.
      </p>

      <label style={{ ...row, marginTop: 12 }}>
        <input
          type="checkbox"
          checked={settings.enabled}
          onChange={(event) => {
            sound.setEnabled(event.target.checked);
          }}
        />
        <span>사운드 사용 (Req 32.14)</span>
      </label>

      <label style={{ display: 'block', marginTop: 12 }}>
        <span style={label}>음량 {VOLUME_MIN}–{VOLUME_MAX} (Req 32.11)</span>
        <div style={row}>
          <input
            type="range"
            min={VOLUME_MIN}
            max={VOLUME_MAX}
            step={0.05}
            value={settings.volume}
            onChange={(event) => {
              sound.setVolume(Number(event.target.value));
            }}
            style={{ flex: 1 }}
            aria-label="사운드 음량"
          />
          <span style={{ ...meta, ...tabular, width: 48, textAlign: 'right' }}>
            {settings.volume.toFixed(2)}
          </span>
        </div>
      </label>

      <div style={{ marginTop: 12 }}>
        <span style={label}>사운드 팩 (Req 32.10 — 2개 이상)</span>
        <div style={row}>
          {SOUND_PACK_IDS.map((packId: SoundPackId) => (
            <button
              key={packId}
              type="button"
              style={settings.packId === packId ? { ...button, borderColor: 'var(--accent)' } : button}
              aria-pressed={settings.packId === packId}
              onClick={() => void sound.switchPack(packId)}
            >
              {SOUND_PACKS[packId].name}
            </button>
          ))}
        </div>
      </div>

      {error !== null && (
        <div style={{ ...refusal, marginTop: 12 }} role="alert">
          {error}
        </div>
      )}

      {/* Requirement 32.20: the interface-sound licence, on the open-source notice screen. */}
      <p style={{ ...meta, marginTop: 12 }}>
        {SOUND_PACK_IDS.map((packId) => (
          <span key={packId} style={{ ...chip, marginRight: 6 }}>
            {SOUND_PACKS[packId].name}: {SOUND_PACKS[packId].licence}
          </span>
        ))}
      </p>
    </div>
  );
}
