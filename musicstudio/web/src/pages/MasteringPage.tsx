/**
 * 이펙트 체인과 마스터링 제안 A/B (Requirements 29.1, 29.9, 29.10, 29.13, 30.1, 30.3, 30.4,
 * 30.21, 30.22, 30.23, 30.24).
 *
 * ### The parameter editor is generated from the registry
 *
 * Requirement 29.1 fixes eight kinds and 29.2–29.8 fix each one's parameters and ranges. This
 * screen reads `EFFECT_REGISTRY` for the controls rather than listing them again, so a slider's
 * `min`/`max` and the range the server would enforce are the same two numbers. Hand-written
 * controls would be a second copy of the ranges, and the copy that drifts is always the one the
 * user is looking at.
 *
 * A control is still not the authority: the chain is validated by `chainViolations` before it is
 * saved, and 29.9's rejection names the offending item and 29.10's names the permitted range. The
 * slider makes the illegal value hard to reach; the validator makes it impossible to store.
 *
 * ### A/B is the suggestion against the edit, both kept
 *
 * Requirement 30.3 stores the suggested chain *and* the applied one whether or not they differ, so
 * "A" here is `suggestion.chain` and "B" is the working copy. `wasEdited` decides whether they
 * differ, by chain equivalence within `CHAIN_PARAMETER_TOLERANCE` — not by `===`, which would call
 * a round trip through JSON an edit, and not by a deep equality that would call `3.4` and
 * `3.4000000001` two different masters.
 *
 * ### The suggestion's provenance is shown, not just its numbers
 *
 * 30.21 asks for `model` or `builtin`, and 30.23 for the suggesting model's commercial-use
 * permission. Both are rendered beside the chain because they are the parts a user cannot infer
 * from the parameters: two identical chains can carry different licences.
 */

import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import {
  CHAIN_ITEM_COUNT_MAX,
  CHAIN_ITEM_COUNT_MIN,
  EFFECT_KINDS,
  EFFECT_REGISTRY,
  type EffectKind,
} from '@domain/effects/registry';
import { chainViolations, type ChainViolation, type EffectChain, type EffectItem } from '@domain/effects/chain';
import { effectChainsEquivalent } from '@domain/effects/equivalence';
import { wasEdited, type MasteringSuggestion } from '@domain/mastering/suggestion';
import { reportMeasurement } from '@domain/mastering/measurement';
import { LOUDNESS_TARGET_DEFAULT_LUFS, TRUE_PEAK_CEILING_DBTP } from '@domain/mastering/bounds';

import { EnterTransition } from '../components/amicro/EnterTransition';
import { StatusMessage } from '../components/StatusMessage';
import { useStudioApi } from '../lib/api/context';
import { useSound } from '../sound/context';
import type { PreviewStream, StudioVersion } from '../lib/api/port';
import { button, chip, column, input, label, meta, panel, primaryButton, row, tabular } from '../styles/ui';

const VIOLATION_LABELS: Readonly<Record<ChainViolation['violation'], string>> = {
  chain_not_array: '체인은 배열이어야 합니다.',
  chain_too_few_items: `체인에는 최소 ${String(CHAIN_ITEM_COUNT_MIN)}개의 이펙트가 필요합니다 (Req 29.13).`,
  chain_too_many_items: `체인은 최대 ${String(CHAIN_ITEM_COUNT_MAX)}개까지입니다 (Req 29.13).`,
  item_not_object: '이펙트 항목의 형식이 올바르지 않습니다.',
  unknown_effect_kind: '등록되지 않은 이펙트 종류입니다 (Req 29.9).',
  unknown_parameter_name: '등록되지 않은 파라미터 이름입니다 (Req 29.9).',
  missing_parameter: '필수 파라미터가 빠졌습니다.',
  parameter_not_finite_number: '파라미터는 유한한 수여야 합니다.',
  parameter_out_of_range: '파라미터가 허용 범위를 벗어났습니다 (Req 29.10).',
};

/** The midpoint of every parameter's range: a newly added effect is in bounds by construction. */
function defaultItem(kind: EffectKind): EffectItem {
  const parameters: Record<string, number> = {};
  for (const [name, range] of Object.entries(EFFECT_REGISTRY[kind].parameters)) {
    parameters[name] = Number(((range.min + range.max) / 2).toFixed(3));
  }
  return { kind, parameters };
}

/** A slider step fine enough that the whole range is reachable in ~200 notches. */
function stepFor(min: number, max: number): number {
  const span = max - min;
  if (span <= 2) return 0.01;
  if (span <= 40) return 0.1;
  return 1;
}

function ChainEditor({
  chain,
  onChange,
  readOnly,
}: {
  readonly chain: EffectChain;
  readonly onChange?: (next: EffectChain) => void;
  readonly readOnly?: boolean;
}): ReactNode {
  function replaceItem(index: number, item: EffectItem): void {
    onChange?.({ items: chain.items.map((current, at) => (at === index ? item : current)) });
  }

  return (
    <div style={column}>
      {chain.items.length === 0 && <div style={meta}>이펙트가 없습니다.</div>}
      {chain.items.map((item, index) => (
        <div
          key={`${item.kind}-${String(index)}`}
          style={{ borderWidth: 1, borderStyle: 'solid', borderColor: 'var(--line)', borderRadius: 8, padding: 12 }}
        >
          <div style={{ ...row, marginBottom: 8 }}>
            <span style={{ ...chip, ...tabular }}>{index + 1}</span>
            <strong style={{ flex: 1 }}>{item.kind}</strong>
            {EFFECT_REGISTRY[item.kind].extendsTail && (
              // Requirements 29.30, 29.32: this is why the rendered length may grow.
              <span style={chip}>꼬리 연장</span>
            )}
            {readOnly !== true && (
              <button
                type="button"
                style={button}
                aria-label={`${item.kind} 제거`}
                onClick={() => {
                  onChange?.({ items: chain.items.filter((_unused, at) => at !== index) });
                }}
              >
                제거
              </button>
            )}
          </div>

          {Object.entries(EFFECT_REGISTRY[item.kind].parameters).map(([name, range]) => (
            <label key={name} style={{ display: 'block', marginBottom: 6 }}>
              <span style={label}>
                {name} · {range.min}–{range.max}
              </span>
              <div style={row}>
                <input
                  type="range"
                  disabled={readOnly === true}
                  min={range.min}
                  max={range.max}
                  step={stepFor(range.min, range.max)}
                  value={item.parameters[name] ?? range.min}
                  onChange={(event) => {
                    replaceItem(index, {
                      ...item,
                      parameters: { ...item.parameters, [name]: Number(event.target.value) },
                    });
                  }}
                  style={{ flex: 1 }}
                  aria-label={`${item.kind} ${name}`}
                />
                <span style={{ ...meta, ...tabular, width: 72, textAlign: 'right' }}>
                  {item.parameters[name] ?? '—'}
                </span>
              </div>
            </label>
          ))}
        </div>
      ))}
    </div>
  );
}

export interface MasteringPageProps {
  readonly assetId: string;
}

export function MasteringPage({ assetId }: MasteringPageProps): ReactNode {
  const api = useStudioApi();
  const sound = useSound();

  const [suggestion, setSuggestion] = useState<MasteringSuggestion | null>(null);
  const [working, setWorking] = useState<EffectChain | null>(null);
  const [saved, setSaved] = useState(false);
  const [listening, setListening] = useState<'a' | 'b'>('b');
  const [versionList, setVersionList] = useState<readonly StudioVersion[]>([]);
  const [preview, setPreview] = useState<PreviewStream | null>(null);

  const load = useCallback(async () => {
    const next = await api.masteringSuggestion(assetId);
    setSuggestion(next);
    const stored = await api.effectChain(assetId);
    // An asset with nothing stored starts from the suggestion — Requirement 30.4's comparison
    // needs two chains, and "nothing" is not one of them.
    setWorking(stored.items.length === 0 ? next.chain : stored);
    setVersionList(await api.versions(assetId));
  }, [api, assetId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (suggestion === null || working === null) return <div style={panel}>불러오는 중…</div>;

  const violations = chainViolations(working.items);
  const measurement = reportMeasurement(suggestion.measurement);
  const edited = wasEdited({
    suggested: suggestion.chain,
    applied: working,
    source: suggestion.source,
    engineId: suggestion.engineId,
  });
  const difference = effectChainsEquivalent(suggestion.chain, working);
  const bandPeakDb = Math.max(...measurement.octaveBands.map((band) => band.energyDb));
  const bandFloorDb = Math.min(...measurement.octaveBands.map((band) => band.energyDb));

  return (
    <EnterTransition>
      <div style={column}>
        <div style={{ ...panel, ...row, flexWrap: 'wrap' }}>
          <strong style={{ flex: 1 }}>마스터링 제안</strong>
          {/* Requirement 30.21 — 모델 제안 또는 기본 제안. */}
          <span style={chip}>{suggestion.source === 'model' ? '모델 제안' : '기본 제안'}</span>
          {suggestion.engineId !== null && <span style={chip}>{suggestion.engineId}</span>}
          {/* Requirement 30.23 — the suggesting model's licence, which the chain cannot show. */}
          <span style={chip}>
            상업적 이용 {suggestion.commercialUseAllowed ? '가능' : '불가'}
          </span>
        </div>

        {/* Requirements 30.22, 30.24 — the measurements, at the reported 0.1 precision. */}
        <div style={panel}>
          <h3 style={{ marginTop: 0, fontSize: 16 }}>측정값 (Req 30.22, 30.24)</h3>
          <div style={{ ...row, flexWrap: 'wrap', marginBottom: 12 }}>
            <span style={{ ...chip, ...tabular }}>
              통합 라우드니스 {measurement.integratedLoudnessLufs} LUFS
            </span>
            <span style={{ ...chip, ...tabular }}>
              트루 피크 {measurement.truePeakDbtp} dBTP
            </span>
            <span style={meta}>
              목표 {LOUDNESS_TARGET_DEFAULT_LUFS} LUFS · 상한 {TRUE_PEAK_CEILING_DBTP} dBTP
              (Req 30.9 — 트루 피크가 우선)
            </span>
          </div>
          <div style={{ ...row, alignItems: 'flex-end', height: 96, gap: 4 }}>
            {measurement.octaveBands.map((band) => (
              <div key={band.centreHz} style={{ flex: 1, textAlign: 'center' }}>
                <div
                  style={{
                    // Scaled between the loudest and quietest band, so ten values within a few
                    // dB of each other are still distinguishable.
                    height: `${String(
                      Math.max(
                        4,
                        ((band.energyDb - bandFloorDb) / Math.max(1, bandPeakDb - bandFloorDb)) * 72,
                      ),
                    )}px`,
                    background: 'var(--accent)',
                    borderRadius: 2,
                  }}
                  title={`${String(band.centreHz)}Hz ${String(band.energyDb)}dB`}
                />
                <div style={{ ...meta, fontSize: 10 }}>
                  {band.centreHz >= 1000 ? `${String(band.centreHz / 1000)}k` : band.centreHz}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Requirements 30.3, 30.4 — A/B. */}
        <div style={{ ...panel, ...row, flexWrap: 'wrap' }}>
          <strong style={{ flex: 1 }}>A/B 비교 (Req 30.4)</strong>
          <button
            type="button"
            style={listening === 'a' ? primaryButton : button}
            aria-pressed={listening === 'a'}
            onClick={() => {
              setListening('a');
            }}
          >
            A · 제안 그대로
          </button>
          <button
            type="button"
            style={listening === 'b' ? primaryButton : button}
            aria-pressed={listening === 'b'}
            onClick={() => {
              setListening('b');
            }}
          >
            B · 내 편집
          </button>
          <span style={meta}>
            {edited
              ? `편집됨 — ${difference.equivalent ? '' : difference.reason}`
              : '제안과 동일 (Req 30.3 — 편집 여부는 체인 동등성으로 판정)'}
          </span>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 16 }}>
          <div style={{ ...panel, opacity: listening === 'a' ? 1 : 0.6 }}>
            <h3 style={{ marginTop: 0, fontSize: 16 }}>A · 제안 (Req 30.1 — 전 파라미터 공개)</h3>
            <ChainEditor chain={suggestion.chain} readOnly />
          </div>

          <div style={{ ...panel, opacity: listening === 'b' ? 1 : 0.6 }}>
            <h3 style={{ marginTop: 0, fontSize: 16 }}>B · 내 편집</h3>
            <ChainEditor
              chain={working}
              onChange={(next) => {
                setWorking(next);
                setSaved(false);
              }}
            />

            <div style={{ ...row, marginTop: 12, flexWrap: 'wrap' }}>
              <label>
                <span style={label}>이펙트 추가 (Req 29.1 — 8종)</span>
                <select
                  style={input}
                  value=""
                  onChange={(event) => {
                    const kind = event.target.value as EffectKind;
                    if (kind === ('' as EffectKind)) return;
                    setWorking({ items: [...working.items, defaultItem(kind)] });
                    setSaved(false);
                    sound.play('effects.chain.itemAdded');
                  }}
                >
                  <option value="">선택…</option>
                  {EFFECT_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {kind}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                style={button}
                onClick={() => {
                  setWorking(suggestion.chain);
                  setSaved(false);
                }}
              >
                제안으로 되돌리기
              </button>
              {/*
                Requirement 29.28: previewing returns a stream and saves nothing. It is beside
                the save button on purpose — the pair is the clause. A preview that quietly minted
                a version would fill the 16-version budget of Requirement 29 with things the user
                only listened to.
              */}
              <button
                type="button"
                style={button}
                disabled={violations.length > 0}
                onClick={() =>
                  void api.previewChain(assetId, working).then((stream) => {
                    setPreview(stream);
                    // A loop: the user is listening *inside* this state, and Requirement 32.7
                    // stops it when they leave it.
                    sound.play('effects.preview.started');
                  })
                }
              >
                미리듣기 (저장 안 함)
              </button>
              <button
                type="button"
                style={primaryButton}
                disabled={violations.length > 0}
                onClick={() =>
                  void api.setEffectChain(assetId, working).then((stored) => {
                    setWorking(stored);
                    setSaved(true);
                    sound.stopCue('effects.preview.started');
                    return api
                      .saveVersion(assetId, `마스터 ${String(versionList.length)}`, stored)
                      .then((next) => {
                        setVersionList(next);
                        sound.play('effects.version.saved');
                      });
                  })
                }
              >
                새 버전으로 저장
              </button>
              {saved && <span style={meta}>저장됨 (Req 30.3 — 제안과 적용본 모두 보관)</span>}
            </div>

            {preview !== null && (
              <p style={{ ...meta, marginTop: 8 }} aria-live="polite">
                미리듣기 스트림: <code>{preview.streamUrl}</code> · {Math.round(preview.durationMs / 1000)}초
                — 버전은 늘지 않습니다 (Req 29.28).
              </p>
            )}
          </div>
        </div>

        {/* Requirement 29.34 — exactly one default, and promoting one demotes the rest. */}
        <div style={panel}>
          <h3 style={{ marginTop: 0, fontSize: 16 }}>버전 (Req 29.34)</h3>
          <div style={column}>
            {versionList.map((version) => (
              <div key={version.id} style={row}>
                <span style={{ flex: 1 }}>
                  {version.name}
                  {version.isOriginal && <span style={{ ...chip, marginLeft: 8 }}>원본</span>}
                </span>
                <span style={{ ...meta, ...tabular }}>{version.chain.items.length}개 이펙트</span>
                {version.isDefault ? (
                  <span style={chip}>기본 버전</span>
                ) : (
                  <button
                    type="button"
                    style={button}
                    aria-label={`${version.name} 기본 버전으로 지정`}
                    onClick={() =>
                      void api.setDefaultVersion(assetId, version.id).then((next) => {
                        setVersionList(next);
                        sound.play('effects.version.promoted');
                      })
                    }
                  >
                    기본으로
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>

        {violations.length > 0 && (
          <StatusMessage kind="error">
            <strong>체인을 적용할 수 없습니다</strong>
            <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
              {violations.map((entry, index) => (
                <li key={`${String(entry.index)}-${entry.violation}-${String(index)}`}>
                  {/* Requirement 29.9 returns the offending name; 29.10 the permitted range. */}
                  {entry.index + 1}번 항목: {VIOLATION_LABELS[entry.violation]}
                  {entry.name !== undefined && ` (${entry.name})`}
                  {entry.permittedRange !== undefined && ` 허용 ${entry.permittedRange}`}
                  {entry.actual !== undefined && `, 요청 ${entry.actual}`}
                </li>
              ))}
            </ul>
          </StatusMessage>
        )}
      </div>
    </EnterTransition>
  );
}
