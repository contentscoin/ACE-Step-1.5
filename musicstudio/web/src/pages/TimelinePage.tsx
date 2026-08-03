/**
 * 타임라인 편집 — 배치, 이동, 트림, 분할, 게인/페이드, 되돌리기 (Requirements 28.14, 28.16, 28.17,
 * 28.21, 28.23, 28.35, 28.36, 28.38).
 *
 * ### Every edit is planned before it is applied
 *
 * `plan*` returns either a command or a rejection carrying the violated bounds and the overlapping
 * clips — Requirement 28.8's payload. The screen therefore never decides whether an edit is legal;
 * it renders what the planner said. A UI that clamped a drag to the legal range would look kinder
 * and would silently move a clip somewhere the user did not ask for, which is worse than a refusal
 * that says why.
 *
 * ### Undo is the command, not a snapshot
 *
 * Requirements 28.35 and 28.36 make undo/redo exact, and `domain/timeline/history.ts` implements it
 * by *inverting the command* rather than restoring a copy of the project. This screen holds no
 * project history of its own for the same reason: two histories would be two answers to "what did
 * that button do".
 */

import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import {
  CLIP_GAIN_DB_MAX,
  CLIP_GAIN_DB_MIN,
  fadeCeilingMs,
} from '@domain/timeline/bounds';
import {
  planClipFades,
  planClipGain,
  planMoveClip,
  planSplitClip,
  planTrimClip,
  type EditPlan,
} from '@domain/timeline/commands';
import {
  clipPlayLengthMs,
  type TimelineProject,
  type TimelineViolation,
} from '@domain/timeline/project';

import { EnterTransition } from '../components/amicro/EnterTransition';
import { useStudioApi } from '../lib/api/context';
import { button, chip, column, label, meta, panel, primaryButton, refusal, row, tabular } from '../styles/ui';

/** Pixels per second of timeline. Fixed rather than fitted, so a clip's width means a duration. */
const PX_PER_SECOND = 22;

const TRACKS_SHOWN = 3;

/**
 * Korean for the violation codes this screen can provoke. Codes with no entry fall back to the
 * code itself rather than to a generic message: an unlabelled code is a gap in this table, and
 * showing it is how the gap gets noticed.
 */
const VIOLATION_LABELS: Readonly<Record<string, string>> = {
  clip_gain_range: `게인은 ${String(CLIP_GAIN_DB_MIN)}–${String(CLIP_GAIN_DB_MAX)} dB 범위여야 합니다.`,
  clip_fade_range: '페이드 합계가 재생 길이의 절반을 넘습니다 (Req 28.17).',
  clip_trim_invalid: '트림 값이 올바르지 않습니다.',
  clip_trim_exceeds_source: '트림이 원본 길이를 넘습니다 (Req 28.11).',
  clip_play_length_too_short: '남는 재생 길이가 최소값보다 짧습니다.',
  clip_start_time_invalid: '시작 위치가 올바르지 않습니다.',
  clip_overlap: '같은 트랙의 다른 클립과 겹칩니다 (Req 28.8).',
  clip_count_exceeded: '프로젝트 클립 수 상한에 도달했습니다 (Req 28.5).',
  clip_id_required: '클립을 찾을 수 없습니다.',
};

function describeViolation(violation: TimelineViolation): string {
  const label = VIOLATION_LABELS[violation.violation] ?? violation.violation;
  // `expected`/`actual` are the planner's own words for the bound that was missed; showing them
  // is what turns "거부됨" into something the user can act on.
  const bound =
    violation.expected === undefined
      ? ''
      : ` (허용 ${violation.expected}${violation.actual === undefined ? '' : `, 요청 ${violation.actual}`})`;
  return `${label}${bound}`;
}

export function TimelinePage(): ReactNode {
  const api = useStudioApi();

  const [project, setProject] = useState<TimelineProject | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [rejection, setRejection] = useState<string[]>([]);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [splitCounter, setSplitCounter] = useState(0);

  const load = useCallback(async () => {
    const next = await api.project();
    setProject(next);
    setSelectedId((current) => current ?? next.clips[0]?.id ?? null);
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Apply a plan, or show why it was refused. One place, so no caller can skip the rejection. */
  async function apply(plan: EditPlan): Promise<void> {
    if (!plan.ok) {
      setRejection([
        ...plan.violations.map(describeViolation),
        // Requirement 28.8: the *other* clip and the overlap, not just "겹칩니다".
        ...plan.overlaps.map(
          (overlap) =>
            `${overlap.clipId} 이(가) 트랙 ${String(overlap.track + 1)}의 ${overlap.otherClipId} 와(과) ${String(overlap.overlapMs)}ms 겹칩니다.`,
        ),
      ]);
      return;
    }
    setRejection([]);
    const applied = await api.applyEdit(plan.command);
    setProject(applied.project);
    setCanUndo(applied.canUndo);
    setCanRedo(applied.canRedo);
  }

  if (project === null) return <div style={panel}>불러오는 중…</div>;

  const selected = project.clips.find((clip) => clip.id === selectedId) ?? null;
  const projectEndMs = Math.max(
    1,
    ...project.clips.map((clip) => clip.startTimeMs + clipPlayLengthMs(clip)),
  );

  return (
    <EnterTransition>
      <div style={column}>
        <div style={{ ...panel, ...row }}>
          <strong style={{ flex: 1 }}>{project.name}</strong>
          <span style={meta}>
            {project.tempoBpm ?? '—'} BPM · {project.timeSignature ?? '—'}/4 · 클립 {project.clips.length}개
          </span>
          <button
            type="button"
            style={button}
            disabled={!canUndo}
            onClick={() =>
              void api.undo().then((step) => {
                setProject(step.project);
                setCanUndo(step.canUndo);
                setCanRedo(step.canRedo);
              })
            }
          >
            되돌리기
          </button>
          <button
            type="button"
            style={button}
            disabled={!canRedo}
            onClick={() =>
              void api.redo().then((step) => {
                setProject(step.project);
                setCanUndo(step.canUndo);
                setCanRedo(step.canRedo);
              })
            }
          >
            다시 실행
          </button>
        </div>

        <div style={{ ...panel, overflowX: 'auto' }}>
          {Array.from({ length: TRACKS_SHOWN }, (_unused, track) => (
            <div key={track} style={{ ...row, alignItems: 'stretch', marginBottom: 8 }}>
              <div style={{ ...meta, width: 72, flexShrink: 0 }}>트랙 {track + 1}</div>
              <div
                style={{
                  position: 'relative',
                  height: 48,
                  flex: 1,
                  minWidth: (projectEndMs / 1000) * PX_PER_SECOND + 40,
                  background: 'var(--field)',
                  borderRadius: 8,
                }}
              >
                {project.clips
                  .filter((clip) => clip.track === track)
                  .map((clip) => (
                    <button
                      key={clip.id}
                      type="button"
                      onClick={() => {
                        setSelectedId(clip.id);
                      }}
                      style={{
                        position: 'absolute',
                        left: (clip.startTimeMs / 1000) * PX_PER_SECOND,
                        width: Math.max(8, (clipPlayLengthMs(clip) / 1000) * PX_PER_SECOND),
                        top: 4,
                        bottom: 4,
                        borderRadius: 6,
                        borderWidth: clip.id === selectedId ? 2 : 1,
                        borderStyle: 'solid',
                        borderColor: clip.id === selectedId ? 'var(--accent)' : 'var(--line)',
                        background: 'var(--surface)',
                        color: 'inherit',
                        fontFamily: 'inherit',
                        fontSize: 12,
                        overflow: 'hidden',
                        cursor: 'pointer',
                      }}
                      aria-label={`${clip.id} 선택`}
                    >
                      {clip.assetId.replace('asset-', '')}
                    </button>
                  ))}
              </div>
            </div>
          ))}
        </div>

        {selected !== null && (
          <div style={panel}>
            <div style={{ ...row, marginBottom: 12 }}>
              <strong style={{ flex: 1 }}>{selected.id}</strong>
              <span style={chip}>트랙 {selected.track + 1}</span>
              <span style={{ ...chip, ...tabular }}>{clipPlayLengthMs(selected)}ms</span>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 16 }}>
              <label>
                <span style={label}>
                  게인 {CLIP_GAIN_DB_MIN}–{CLIP_GAIN_DB_MAX} dB (Req 28.16)
                </span>
                <input
                  type="range"
                  min={CLIP_GAIN_DB_MIN}
                  max={CLIP_GAIN_DB_MAX}
                  step={0.5}
                  value={selected.gainDb}
                  onChange={(event) =>
                    void apply(planClipGain(project, selected.id, Number(event.target.value)))
                  }
                  style={{ width: '100%' }}
                />
                <span style={{ ...meta, ...tabular }}>{selected.gainDb} dB</span>
              </label>

              <label>
                <span style={label}>
                  페이드 인 (Req 28.17 — 재생 길이의 절반까지, 현재 상한 {fadeCeilingMs(clipPlayLengthMs(selected))}ms)
                </span>
                <input
                  type="range"
                  min={0}
                  max={fadeCeilingMs(clipPlayLengthMs(selected))}
                  step={50}
                  value={selected.fadeInMs}
                  onChange={(event) =>
                    void apply(
                      planClipFades(project, selected.id, {
                        fadeInMs: Number(event.target.value),
                        fadeOutMs: selected.fadeOutMs,
                      }),
                    )
                  }
                  style={{ width: '100%' }}
                />
                <span style={{ ...meta, ...tabular }}>{selected.fadeInMs}ms</span>
              </label>

              {/*
                Both trims are amounts *removed*, from the head and the tail — `clipPlayLengthMs`
                is `sourceDurationMs - trimStartMs - trimEndMs`. The slider therefore runs to the
                whole source and lets the planner refuse the far end (Req 28.11 answers with the
                largest sum it would have taken), rather than the screen capping it at a bound it
                would have to derive a second time.
              */}
              <label>
                <span style={label}>뒤 트림 (Req 28.10–28.13 — 원본은 그대로)</span>
                <input
                  type="range"
                  min={0}
                  max={selected.sourceDurationMs}
                  step={500}
                  value={selected.trimEndMs}
                  onChange={(event) =>
                    void apply(
                      planTrimClip(project, {
                        clipId: selected.id,
                        trimStartMs: selected.trimStartMs,
                        trimEndMs: Number(event.target.value),
                      }),
                    )
                  }
                  style={{ width: '100%' }}
                />
                <span style={{ ...meta, ...tabular }}>
                  −{selected.trimEndMs}ms · 원본 {selected.sourceDurationMs}ms
                </span>
              </label>

              <label>
                <span style={label}>시작 위치 (Req 28.21 — 스냅 켬)</span>
                <input
                  type="range"
                  min={0}
                  max={60_000}
                  step={250}
                  value={selected.startTimeMs}
                  onChange={(event) =>
                    void apply(
                      planMoveClip(project, {
                        clipId: selected.id,
                        startTimeMs: Number(event.target.value),
                        snapEnabled: true,
                      }),
                    )
                  }
                  style={{ width: '100%' }}
                />
                <span style={{ ...meta, ...tabular }}>{selected.startTimeMs}ms</span>
              </label>
            </div>

            <div style={{ ...row, marginTop: 16 }}>
              <button
                type="button"
                style={primaryButton}
                onClick={() => {
                  const at = selected.startTimeMs + Math.floor(clipPlayLengthMs(selected) / 2);
                  setSplitCounter((current) => current + 1);
                  void apply(
                    planSplitClip(project, {
                      clipId: selected.id,
                      atMs: at,
                      leftClipId: `${selected.id}-L${String(splitCounter + 1)}`,
                      rightClipId: `${selected.id}-R${String(splitCounter + 1)}`,
                    }),
                  );
                }}
              >
                가운데에서 분할 (Req 28.14)
              </button>
            </div>
          </div>
        )}

        {rejection.length > 0 && (
          <div style={refusal} role="alert">
            <strong>편집이 거부되었습니다</strong>
            <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
              {rejection.map((entry) => (
                <li key={entry}>{entry}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </EnterTransition>
  );
}
