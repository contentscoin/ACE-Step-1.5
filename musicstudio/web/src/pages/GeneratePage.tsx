/**
 * 생성 화면 — Simple_Mode and Custom_Mode (Requirements 3.1, 3.5-3.7, 4.1, 4.6, 4.8-4.10, 5.1,
 * 5.4, 5.5, 6.1, 6.4).
 *
 * ### An empty field is not the same as a blank one
 *
 * Requirements 3.3, 3.6 and 4.7 all say the same thing from different angles: a field the user
 * left alone must reach the engine **absent**, so the engine fills it in. A form that sent
 * `bpm: 0` or `description: ''` for an untouched input would be making a request the user did not
 * make — and 3.5 would then reject the empty description as a violation, which is right for a
 * cleared field and wrong for one never touched.
 *
 * So `optionalNumber`/`optionalText` below return `undefined` for an untouched control, and the
 * request is assembled with spreads rather than with defaults. That is the whole reason this form
 * does not simply bind state to an object.
 *
 * ### The screen does not validate
 *
 * `submitSong` runs `validateSongRequest` — the same function the gateway runs — and returns every
 * violation with its allowance. A form that pre-validated would be a second rule set, and the two
 * would disagree on the day someone changed a bound.
 */

import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import {
  SONG_BATCH_SIZE_MAX,
  SONG_BATCH_SIZE_MIN,
  SONG_BPM_MAX,
  SONG_BPM_MIN,
  SONG_DURATION_SECONDS_MAX,
  SONG_DURATION_SECONDS_MIN,
} from '@domain/song/engine-bounds';
import { KEY_SCALE_ACCIDENTALS, KEY_SCALE_MODES, KEY_SCALE_NOTES } from '@domain/song/key-scale';
import { VOCAL_LANGUAGE_CODES } from '@domain/song/vocal-language';
import type { SongGenerationRequest } from '@domain/song/request';
import type { SongFieldViolation } from '@domain/song/violation';

import { EnterTransition } from '../components/amicro/EnterTransition';
import { HoverLift } from '../components/amicro/HoverLift';
import { WaveformLoader } from '../components/amicro/WaveformLoader';
import { Violations } from '../components/Violations';
import { progressLabel, PROGRESS_TEXT_REFRESH_MS } from '../components/generation/progress';
import { useStudioApi } from '../lib/api/context';
import type { StudioJob } from '../lib/api/types';
import { navigate } from '../app/router';
import { button, column, input, label, meta, panel, primaryButton, row, tabular } from '../styles/ui';

type Mode = 'simple' | 'custom';

/** `undefined` for an untouched control — see the module header. */
function optionalNumber(value: string): number | undefined {
  return value.trim() === '' ? undefined : Number(value);
}

function optionalText(value: string): string | undefined {
  return value === '' ? undefined : value;
}

/**
 * A field that is *absent* when the control was not touched.
 *
 * `{ bpm: undefined }` and `{}` are different objects under `exactOptionalPropertyTypes`, and the
 * difference is exactly what Requirements 3.3 and 4.7 turn on — so the spread has to produce the
 * second, not the first.
 */
function field<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

/** The key/scale options, built from the domain's own note, accidental and mode lists. */
const KEY_SCALE_OPTIONS: readonly string[] = KEY_SCALE_NOTES.flatMap((note) =>
  KEY_SCALE_ACCIDENTALS.filter((accidental) => accidental === '' || accidental === '#' || accidental === 'b').flatMap(
    (accidental) => KEY_SCALE_MODES.map((mode) => `${note}${accidental} ${mode}`),
  ),
);

export function GeneratePage(): ReactNode {
  const api = useStudioApi();

  const [mode, setMode] = useState<Mode>('simple');
  const [description, setDescription] = useState('늦은 밤 도심을 달리는 로파이 트랙');
  const [caption, setCaption] = useState('');
  const [lyrics, setLyrics] = useState('');
  const [instrumental, setInstrumental] = useState(false);
  const [bpm, setBpm] = useState('');
  const [keyScale, setKeyScale] = useState('');
  const [timeSignature, setTimeSignature] = useState('');
  const [durationSeconds, setDurationSeconds] = useState('');
  const [vocalLanguage, setVocalLanguage] = useState('');
  const [batchSize, setBatchSize] = useState('1');
  const [seed, setSeed] = useState('');

  const [violations, setViolations] = useState<readonly SongFieldViolation[]>([]);
  const [job, setJob] = useState<StudioJob | null>(null);

  const buildRequest = useCallback((): SongGenerationRequest => {
    const shared = {
      ...field('durationSeconds', optionalNumber(durationSeconds)),
      ...field('vocalLanguage', optionalText(vocalLanguage)),
      ...field('batchSize', optionalNumber(batchSize)),
      ...field('seed', optionalNumber(seed)),
    };

    if (mode === 'simple') {
      // Requirement 3.6: an *absent* description is the random-generation request.
      return { mode: 'simple', ...field('description', optionalText(description)), ...shared };
    }

    return {
      mode: 'custom',
      ...field('caption', optionalText(caption)),
      // Requirement 4.1: exactly what the user wrote, never truncated.
      ...field('lyrics', optionalText(lyrics)),
      instrumental,
      ...field('bpm', optionalNumber(bpm)),
      ...field('keyScale', optionalText(keyScale)),
      ...field('timeSignature', optionalNumber(timeSignature)),
      ...shared,
    };
  }, [mode, description, caption, lyrics, instrumental, bpm, keyScale, timeSignature, durationSeconds, vocalLanguage, batchSize, seed]);

  async function submit(): Promise<void> {
    const outcome = await api.submitSong(buildRequest());
    setViolations(outcome.violations ?? []);
    setJob(outcome.job ?? null);
  }

  // Requirement 5.4: the status is polled while the job is live. The interval is the progress
  // display's, so the number on screen and the number the client holds cannot be a beat apart.
  useEffect(() => {
    if (job === null || job.state === 'succeeded' || job.state === 'failed' || job.state === 'cancelled') {
      return;
    }
    const timer = setInterval(() => {
      void api.jobStatus(job.jobId).then((next) => {
        if (next !== null) setJob(next);
      });
    }, PROGRESS_TEXT_REFRESH_MS);
    return () => {
      clearInterval(timer);
    };
  }, [api, job]);

  const live = job !== null && (job.state === 'queued' || job.state === 'running');
  const produced = job?.state === 'succeeded' ? job.assetIds[0] : undefined;

  return (
    <EnterTransition>
      <div style={column}>
        <div style={row}>
          {(['simple', 'custom'] as const).map((candidate) => (
            <button
              key={candidate}
              type="button"
              onClick={() => {
                setMode(candidate);
              }}
              style={mode === candidate ? primaryButton : button}
              aria-pressed={mode === candidate}
            >
              {candidate === 'simple' ? 'Simple 모드' : 'Custom 모드'}
            </button>
          ))}
        </div>

        <div style={panel}>
          {mode === 'simple' ? (
            <label style={{ display: 'block' }}>
              <span style={label}>설명 (비우면 엔진이 임의로 생성 — Req 3.6)</span>
              <textarea
                value={description}
                onChange={(event) => {
                  setDescription(event.target.value);
                }}
                rows={3}
                style={{ ...input, resize: 'vertical' }}
              />
            </label>
          ) : (
            <div style={column}>
              <label style={{ display: 'block' }}>
                <span style={label}>캡션</span>
                <input
                  value={caption}
                  onChange={(event) => {
                    setCaption(event.target.value);
                  }}
                  style={input}
                />
              </label>
              <label style={{ display: 'block' }}>
                <span style={label}>가사 (Req 4.1 — 잘리지 않고 그대로 전달)</span>
                <textarea
                  value={lyrics}
                  onChange={(event) => {
                    setLyrics(event.target.value);
                  }}
                  rows={5}
                  style={{ ...input, resize: 'vertical' }}
                />
              </label>
              <label style={row}>
                <input
                  type="checkbox"
                  checked={instrumental}
                  onChange={(event) => {
                    setInstrumental(event.target.checked);
                  }}
                />
                <span>인스트루멘털 (Req 4.9)</span>
              </label>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
                <label>
                  <span style={label}>BPM ({SONG_BPM_MIN}–{SONG_BPM_MAX})</span>
                  <input
                    value={bpm}
                    onChange={(event) => {
                      setBpm(event.target.value);
                    }}
                    placeholder="비우면 엔진이 결정"
                    style={input}
                  />
                </label>
                <label>
                  <span style={label}>키/스케일</span>
                  <select
                    value={keyScale}
                    onChange={(event) => {
                      setKeyScale(event.target.value);
                    }}
                    style={input}
                  >
                    <option value="">엔진이 결정</option>
                    {KEY_SCALE_OPTIONS.map((candidate) => (
                      <option key={candidate} value={candidate}>
                        {candidate}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span style={label}>박자</span>
                  <select
                    value={timeSignature}
                    onChange={(event) => {
                      setTimeSignature(event.target.value);
                    }}
                    style={input}
                  >
                    <option value="">엔진이 결정</option>
                    {[2, 3, 4, 6].map((candidate) => (
                      <option key={candidate} value={String(candidate)}>
                        {candidate}/4
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginTop: 12 }}>
            <label>
              <span style={label}>길이(초) {SONG_DURATION_SECONDS_MIN}–{SONG_DURATION_SECONDS_MAX}</span>
              <input
                value={durationSeconds}
                onChange={(event) => {
                  setDurationSeconds(event.target.value);
                }}
                placeholder="엔진이 결정"
                style={input}
              />
            </label>
            <label>
              <span style={label}>보컬 언어</span>
              <select
                value={vocalLanguage}
                onChange={(event) => {
                  setVocalLanguage(event.target.value);
                }}
                style={input}
              >
                <option value="">지정 안 함</option>
                {VOCAL_LANGUAGE_CODES.slice(0, 20).map((candidate) => (
                  <option key={candidate} value={candidate}>
                    {candidate}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span style={label}>배치 {SONG_BATCH_SIZE_MIN}–{SONG_BATCH_SIZE_MAX} (Req 4.8)</span>
              <input
                value={batchSize}
                onChange={(event) => {
                  setBatchSize(event.target.value);
                }}
                style={input}
              />
            </label>
            <label>
              <span style={label}>시드 (Req 4.10)</span>
              <input
                value={seed}
                onChange={(event) => {
                  setSeed(event.target.value);
                }}
                placeholder="임의"
                style={input}
              />
            </label>
          </div>

          <div style={{ ...row, marginTop: 16 }}>
            <HoverLift>
              <button type="button" onClick={() => void submit()} style={primaryButton}>
                생성 요청
              </button>
            </HoverLift>
            <span style={meta}>비워 둔 항목은 엔진이 채웁니다 (Req 3.3, 4.7)</span>
          </div>
        </div>

        <Violations violations={violations} />

        {job !== null && (
          <div style={panel} data-testid="job-panel">
            {live && (
              <div style={row}>
                <WaveformLoader />
                <span style={tabular} aria-live="polite">
                  {
                    progressLabel({
                      phase: job.state === 'queued' ? 'queued' : 'running',
                      percent: job.percent,
                      queuePosition: job.queuePosition,
                    }).text
                  }
                </span>
                <button type="button" onClick={() => void api.cancelJob(job.jobId).then(setJob)} style={button}>
                  취소
                </button>
              </div>
            )}

            {job.state === 'succeeded' && produced !== undefined && (
              <div style={row}>
                <span>생성 완료</span>
                <HoverLift>
                  <button
                    type="button"
                    style={primaryButton}
                    onClick={() => {
                      navigate('asset', produced);
                    }}
                  >
                    결과 확인
                  </button>
                </HoverLift>
              </div>
            )}

            {job.state === 'failed' && (
              <div style={row}>
                {/* Requirement 6.1's reason, and 6.4's retry beside it. */}
                <span>실패: {job.failureReason ?? '알 수 없는 사유'}</span>
                <button
                  type="button"
                  style={button}
                  onClick={() => void api.retryJob(job.jobId).then((outcome) => {
                    setJob(outcome.job ?? null);
                  })}
                >
                  재시도
                </button>
              </div>
            )}

            {job.state === 'cancelled' && <span>취소되었습니다.</span>}
            {job.retryOfJobId !== null && <p style={meta}>재시도: {job.retryOfJobId}</p>}
          </div>
        )}
      </div>
    </EnterTransition>
  );
}
