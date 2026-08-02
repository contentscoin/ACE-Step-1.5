/**
 * Decoding `/query_result` (Requirements 3.4, 5.3).
 *
 * The shape is unusual enough to be worth stating plainly, because it is the
 * reason this module exists at all. The envelope's `data` is an array with one
 * entry per requested task:
 *
 *   { task_id, status: 0 | 1 | 2, progress_text, result: "<JSON text>" }
 *
 * `result` is a JSON **string**, not an object, and it decodes to a list with one
 * item per output audio:
 *
 *   { file, status, prompt, lyrics, metas: { bpm, duration, genres, keyscale,
 *     timesignature }, progress?, stage?, error? }
 *
 * `prompt` / `lyrics` / `metas` are the values the engine *finally used*, which is
 * exactly what Requirement 3.4 asks to be stored: in Simple_Mode the user supplied
 * none of them, and in Custom_Mode the engine filled whatever Requirement 4.7 left
 * empty. So the decoded metadata is the outcome, not an echo of the request.
 *
 * The status integer is passed through untranslated. Requirement 5.3's 0/1/2
 * mapping already exists once, in `services/generation/engine-status.ts`, and a
 * second reading of it here would be a second thing to keep true.
 */

import type { SongTrackMetadata } from '../../domain/song/track-metadata';
import { EMPTY_SONG_TRACK_METADATA } from '../../domain/song/track-metadata';

import { asFiniteNumber, asRecord, asReportedText } from './envelope';
import { aceMalformedResponse } from './errors';

/** One produced audio, with the metadata the engine settled on. */
export interface AceResultEntry {
  /** Engine-side path, passed to `GET /v1/audio?path=…`. */
  readonly filePath: string | null;
  readonly metadata: SongTrackMetadata;
}

export interface AceTaskResult {
  readonly taskId: string;
  /** Raw engine status: 0 running, 1 succeeded, 2 failed. Translated elsewhere. */
  readonly statusCode: number;
  readonly progressText: string | null;
  /** 0–100, derived from the engine's 0.0–1.0 fraction. */
  readonly progressPercent: number | null;
  readonly failureReason: string | null;
  readonly entries: readonly AceResultEntry[];
}

/** Finds the entry for one task in a `/query_result` batch answer. */
export function decodeTaskResult(
  path: string,
  data: unknown,
  taskId: string,
): AceTaskResult | null {
  if (!Array.isArray(data)) {
    throw aceMalformedResponse(path, 'ACE-Step returned no result list.');
  }

  for (const element of data) {
    const record = asRecord(element);
    if (record === null || record.task_id !== taskId) continue;
    return decodeOne(path, record, taskId);
  }
  return null;
}

function decodeOne(
  path: string,
  record: Readonly<Record<string, unknown>>,
  taskId: string,
): AceTaskResult {
  const statusCode = asFiniteNumber(record.status);
  if (statusCode === null) {
    throw aceMalformedResponse(path, 'ACE-Step returned a task without a status.');
  }

  const items = decodeResultItems(record.result);
  const first = items.length > 0 ? items[0] : undefined;

  return {
    taskId,
    statusCode,
    progressText: asReportedText(record.progress_text),
    progressPercent: percentOf(first?.progress),
    failureReason: asReportedText(first?.error),
    // A task that has not finished reports one placeholder item with no file, so
    // only entries that actually name a file become results.
    entries: items.filter((item) => item.file !== null).map(toEntry),
  };
}

interface AceResultItem {
  readonly file: string | null;
  readonly prompt: unknown;
  readonly lyrics: unknown;
  readonly metas: Readonly<Record<string, unknown>>;
  readonly progress: unknown;
  readonly error: unknown;
}

/** `result` is JSON text; anything unparseable is treated as "no items yet". */
function decodeResultItems(raw: unknown): readonly AceResultItem[] {
  const parsed = parseJsonText(raw);
  if (!Array.isArray(parsed)) return [];

  const items: AceResultItem[] = [];
  for (const element of parsed) {
    const record = asRecord(element);
    if (record === null) continue;
    const file = asReportedText(record.file);
    items.push({
      file,
      prompt: record.prompt,
      lyrics: record.lyrics,
      metas: asRecord(record.metas) ?? {},
      progress: record.progress,
      error: record.error,
    });
  }
  return items;
}

function parseJsonText(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Requirement 3.4: the six values the engine finally used, plus its genre list. */
function toEntry(item: AceResultItem): AceResultEntry {
  const { metas } = item;
  return {
    filePath: item.file,
    metadata: {
      ...EMPTY_SONG_TRACK_METADATA,
      caption: asReportedText(item.prompt),
      // Lyrics keep their own whitespace; only an absent or `"N/A"` value is null.
      lyrics: asLyrics(item.lyrics),
      bpm: asFiniteNumber(metas.bpm),
      keyScale: asReportedText(metas.keyscale),
      timeSignature: asFiniteNumber(metas.timesignature),
      durationSeconds: asFiniteNumber(metas.duration),
      genres: asReportedText(metas.genres),
    },
  };
}

/**
 * Lyrics are returned verbatim rather than trimmed.
 *
 * Requirement 4.1 forbids altering the lyric text on the way in, and the same
 * reasoning applies coming back out: line structure is meaning, so leading and
 * trailing whitespace is preserved and only emptiness is normalised to `null`.
 */
function asLyrics(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.toUpperCase() === 'N/A') return null;
  return value;
}

function percentOf(progress: unknown): number | null {
  const fraction = asFiniteNumber(progress);
  // The engine reports 0.0–1.0 (`JobStore.update_progress` clamps to that range).
  return fraction === null ? null : Math.round(fraction * 100);
}
