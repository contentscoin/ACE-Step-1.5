/**
 * `Project_Parser` (Requirements 28.31, 28.34; design §7.1, §7.2).
 *
 * Turns a JSON project document into a `Timeline_Project`, or returns the faults in §7.2's
 * `ParseError` shape — the shape shared by all five parsers of §7.1, which is why it lives in
 * `domain/parse-error.ts` and not here.
 *
 * ### Every fault is returned, not only the first
 *
 * `Chain_Parser` returns exactly one, because Requirement 29.33 says 첫 위반 항목 — singular.
 * Requirement 28 says no such thing about projects, and a project is up to 500 clips of ten
 * fields plus 32 tracks of four: one fault per parse would turn fixing a mis-exported project
 * into hundreds of round trips. So the whole list comes back and callers wanting only the
 * first take `errors[0]`. This follows `manifest-parser.ts`, for the same reason.
 *
 * ### Requirement 28.34 needs a catalogue, so it is a parameter
 *
 * > IF JSON 프로젝트 문서가 존재하지 않는 자산 식별자를 참조하면, THEN THE Project_Parser SHALL
 * > 해당 **참조 위치와 누락된 자산 식별자**를 포함한 오류를 반환한다
 *
 * The parser cannot know which assets exist, so `knownAssets` is passed in: a map from asset
 * id to that asset's duration in milliseconds. It is **optional**, and that is a deliberate
 * reading rather than a convenience:
 *
 * - Properties 6 and 7 (Requirements 28.32, 28.33) are quantified over documents, not over
 *   documents-plus-a-catalogue, and a round trip that required a database to run would be a
 *   round trip nobody could test.
 * - Requirement 28.36 describes a project that legitimately references an asset which has
 *   since been marked deleted, and it requires that project to be *readable* with the clips
 *   flagged — not rejected. So existence checking cannot be unconditional.
 *
 * When the catalogue *is* supplied the parser does one thing more than 28.34 asks: it checks
 * that each clip's stored `sourceDurationMs` matches the catalogue's duration for that asset.
 * That copy is what makes Requirements 28.10, 28.11 and 28.13 pure functions of the project
 * (see `project.ts`), and a document that disagrees with the catalogue would make every one
 * of those three rules quietly wrong. Reported as `clip_source_duration_mismatch`, distinct
 * from 28.34's `clip_asset_missing`, so a client can tell "this asset is gone" from "this
 * document is stale".
 *
 * ### Two input forms
 *
 * `parseProjectDocument` takes the document **text**, which is what an API body or a file
 * read yields, including the case where the text is not JSON at all. `parseProjectValue`
 * takes an already-decoded value — a `jsonb` read, or the object a client sent — for the
 * reason `chain-parser.ts` gives: routing those through a re-serialise just to reuse one
 * function would let a parse fail for a reason the input never had.
 */

import {
  parseFailure,
  parseSuccess,
  type ParseError,
  type ParseResult,
} from '../parse-error';

import { TRACK_COUNT } from './bounds';
import {
  projectViolations,
  type TimelineClip,
  type TimelineProject,
  type TimelineViolation,
  type TrackSettings,
} from './project';

/** Asset id to duration in milliseconds. See the header on why it is optional. */
export type AssetDurationCatalogue = ReadonlyMap<string, number>;

export interface ProjectParseOptions {
  readonly knownAssets?: AssetDurationCatalogue;
}

/** Requirement 28.31, from the document text. */
export function parseProjectDocument(
  document: string,
  options: ProjectParseOptions = {},
): ParseResult<TimelineProject> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(document);
  } catch {
    // Not `project_not_object`: the input never became a JSON value, and telling the caller an
    // object was expected would send them looking at the shape of `{oops` rather than at its
    // syntax. Same distinction `manifest-parser.ts` draws.
    return parseFailure({
      violation: 'project_json_malformed',
      expected: 'a JSON object with name, clips and tracks',
      actual: truncate(document),
    });
  }
  return parseProjectValue(decoded, options);
}

/** Requirement 28.31, from an already-decoded value. */
export function parseProjectValue(
  value: unknown,
  options: ProjectParseOptions = {},
): ParseResult<TimelineProject> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return parseFailure({
      violation: 'project_not_object',
      expected: 'a JSON object',
      actual: describeType(value),
    });
  }

  const record = value as Record<string, unknown>;
  const shapeFaults: ParseError[] = [];

  // The structural pass is separate from the rule pass, and has to come first: the rules of
  // `projectViolations` are stated over a `TimelineProject`, so there must *be* one before they
  // can run. A document whose `clips` is a string cannot be coerced into a project at all, and
  // guessing (an empty clip list, say) would report a project the caller never sent.
  const clipsValue = record['clips'];
  if (!Array.isArray(clipsValue)) {
    shapeFaults.push({
      field: 'clips',
      violation: 'project_clips_not_array',
      expected: 'an array of clip objects',
      actual: describeType(clipsValue),
    });
  }

  const tracksValue = record['tracks'];
  if (!Array.isArray(tracksValue)) {
    shapeFaults.push({
      field: 'tracks',
      violation: 'project_tracks_not_array',
      expected: `an array of exactly ${String(TRACK_COUNT)} track objects`,
      actual: describeType(tracksValue),
    });
  }

  if (Array.isArray(clipsValue)) {
    for (const [index, clip] of clipsValue.entries()) {
      if (typeof clip !== 'object' || clip === null || Array.isArray(clip)) {
        shapeFaults.push({
          index,
          violation: 'clip_not_object',
          expected: 'a JSON object',
          actual: describeType(clip),
        });
      }
    }
  }

  if (Array.isArray(tracksValue)) {
    for (const [index, track] of tracksValue.entries()) {
      if (typeof track !== 'object' || track === null || Array.isArray(track)) {
        shapeFaults.push({
          index,
          violation: 'track_not_object',
          expected: 'a JSON object',
          actual: describeType(track),
        });
      }
    }
  }

  if (shapeFaults.length > 0) return parseFailure(...shapeFaults);

  const project: TimelineProject = {
    id: asString(record['id']),
    ownerId: asString(record['ownerId']),
    name: asString(record['name']),
    // Requirement 28.1 requires a description field; an absent one is read as the empty
    // string rather than rejected, because `createTimelineProject` also defaults it and a
    // document that omitted it would otherwise be unreadable by the printer's own successor.
    description: record['description'] === undefined ? '' : asString(record['description']),
    tempoBpm: asNullableNumber(record['tempoBpm']),
    timeSignature: asNullableNumber(record['timeSignature']),
    clips: (clipsValue as readonly Record<string, unknown>[]).map(toClip),
    tracks: (tracksValue as readonly Record<string, unknown>[]).map(toTrack),
  };

  const violations = projectViolations(project);
  const catalogueFaults =
    options.knownAssets === undefined ? [] : assetFaults(project, options.knownAssets);

  if (violations.length > 0 || catalogueFaults.length > 0) {
    return parseFailure(...violations.map(toParseError), ...catalogueFaults);
  }

  return parseSuccess(project);
}

/**
 * Requirement 28.34's fault, plus the staleness check the denormalised duration needs.
 *
 * `index` is the clip's position in the document, which is 28.34's 참조 위치, and `actual` is
 * the missing asset identifier — both, as data, because a client that wants to say "clip 3
 * references a deleted sample" needs each separately.
 */
function assetFaults(
  project: TimelineProject,
  knownAssets: AssetDurationCatalogue,
): ParseError[] {
  const faults: ParseError[] = [];

  for (const [index, clip] of project.clips.entries()) {
    const duration = knownAssets.get(clip.assetId);
    if (duration === undefined) {
      faults.push({
        index,
        field: 'assetId',
        violation: 'clip_asset_missing',
        expected: 'an existing Audio_Asset identifier',
        actual: clip.assetId,
      });
      continue;
    }
    if (duration !== clip.sourceDurationMs) {
      faults.push({
        index,
        field: 'sourceDurationMs',
        violation: 'clip_source_duration_mismatch',
        expected: String(duration),
        actual: String(clip.sourceDurationMs),
      });
    }
  }

  return faults;
}

/**
 * §7.2's `ParseError` from a `TimelineViolation`.
 *
 * `line` is never set: a JSON document has no meaningful line for a structural fault, and
 * filling it with `1` would be a lie a client might display next to the wrong text. Same
 * decision `manifest-parser.ts` records.
 */
function toParseError(violation: TimelineViolation): ParseError {
  return {
    ...(violation.index === undefined ? {} : { index: violation.index }),
    ...(violation.field === undefined ? {} : { field: violation.field }),
    violation: violation.violation,
    ...(violation.expected === undefined ? {} : { expected: violation.expected }),
    ...(violation.actual === undefined ? {} : { actual: violation.actual }),
  };
}

/**
 * A clip from a decoded object, with no coercion.
 *
 * Missing and wrongly-typed fields arrive as `NaN`, `''` or `undefined` and are caught by
 * `clipViolations`, which already states every one of Requirement 28's rules. Coercing here —
 * `Number(value) || 0`, say — would turn `"abc"` into a perfectly valid start time of 0 and
 * accept a document the requirement rejects.
 */
function toClip(record: Record<string, unknown>): TimelineClip {
  return {
    id: asString(record['id']),
    assetId: asString(record['assetId']),
    sourceDurationMs: asNumber(record['sourceDurationMs']),
    startTimeMs: asNumber(record['startTimeMs']),
    track: asNumber(record['track']),
    trimStartMs: asNumber(record['trimStartMs']),
    trimEndMs: asNumber(record['trimEndMs']),
    gainDb: asNumber(record['gainDb']),
    fadeInMs: asNumber(record['fadeInMs']),
    fadeOutMs: asNumber(record['fadeOutMs']),
    muted: asBoolean(record['muted']),
  };
}

function toTrack(record: Record<string, unknown>): TrackSettings {
  return {
    volumeDb: asNumber(record['volumeDb']),
    pan: asNumber(record['pan']),
    muted: asBoolean(record['muted']),
    solo: asBoolean(record['solo']),
  };
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown): number {
  // `NaN` for anything that is not a number, so the range checks reject it. `NaN` fails every
  // comparison, which is exactly the behaviour wanted for a field that arrived as `null`.
  return typeof value === 'number' ? value : Number.NaN;
}

function asNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return asNumber(value);
}

function asBoolean(value: unknown): boolean {
  // Deliberately not `Boolean(value)`: a `muted` of `"false"` would become `true`, and a
  // missing one would become `false` silently. Non-booleans are surfaced by `clipViolations`.
  return value as boolean;
}

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function truncate(text: string, limit = 80): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}
