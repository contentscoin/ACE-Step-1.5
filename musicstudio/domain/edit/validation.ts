/**
 * Edit_Task validation (Requirements 7.2, 7.4, 7.5, 7.6, 7.7, 7.9, 7.10, 7.11).
 *
 * Pure and total, like `domain/song/validation.ts`: a request plus the two facts it
 * has to be judged against — the source audio descriptor and the model catalogue —
 * go in, and either the resolved `EditParameters` (with any Requirement 7.5
 * adjustment) or the complete list of violations comes out. Nothing throws and
 * nothing reaches for the network.
 *
 * Order is load-bearing in one place: the source audio is checked *first*, because
 * Requirement 7.5's clamp needs a trustworthy source length. Clamping a repaint
 * interval against a length that failed Requirement 7.10 would report an adjustment
 * derived from a value the request is about to be refused for.
 */

import { validateSongRequest } from '../song/validation';
import type { SongParameters } from '../song/request';
import type { SongFieldViolation } from '../song/violation';

import { coverStrengthViolation } from './cover-strength';
import { requiresTrackName, type EditKind } from './edit-kind';
import {
  modelsSupportingEditKind,
  supportsEditKind,
  type EditModelCatalogue,
} from './model-support';
import { resolveRepaintRange, type RepaintAdjustment } from './repaint-range';
import type { EditParameters, EditRequest, EditStyle } from './request';
import { validateSourceAudio, type SourceAudio, type SourceAudioDescriptor } from './source-audio';
import { isTrackName, TRACK_NAMES } from './track-name';
import {
  editEnumViolation,
  editUnsupportedByModelViolation,
  type EditFieldViolation,
} from './violation';

export type EditValidation =
  | {
      readonly kind: 'valid';
      readonly parameters: EditParameters;
      /** Requirement 7.5. Empty when nothing was adjusted. */
      readonly adjustments: readonly RepaintAdjustment[];
    }
  | {
      readonly kind: 'invalid';
      readonly violations: readonly EditFieldViolation[];
      /**
       * Requirement 4.6's violations for the `style` block, kept in their own shape.
       *
       * Folding them into `EditFieldViolation` would lose the length allowance and
       * the accepted-value lists Requirements 3.5 and 3.8 attach to them, so the
       * musical side reports itself exactly as Requirement 4 specifies and the two
       * lists are returned side by side.
       */
      readonly styleViolations: readonly SongFieldViolation[];
    };

export interface EditValidationInput {
  readonly request: EditRequest;
  /** As reported by the Library_Service for `request.sourceAssetId`. */
  readonly sourceAudio: SourceAudioDescriptor;
  readonly catalogue: EditModelCatalogue;
}

export function validateEditRequest(input: EditValidationInput): EditValidation {
  const { request, catalogue } = input;

  // Requirements 7.10 / 7.11 first: everything below depends on the source length.
  const sourceCheck = validateSourceAudio(input.sourceAudio);
  if (sourceCheck.kind === 'invalid') {
    return { kind: 'invalid', violations: sourceCheck.violations, styleViolations: [] };
  }

  const model = request.model ?? catalogue.defaultModel;
  const violations: EditFieldViolation[] = [...modelViolations(catalogue, model, request.kind)];
  const adjustments: RepaintAdjustment[] = [];

  const style = styleParameters(request.style);
  const kindSpecific = resolveKind(request, sourceCheck.source, adjustments);
  violations.push(...kindSpecific.violations);

  if (violations.length > 0 || style.kind === 'invalid') {
    return {
      kind: 'invalid',
      violations,
      styleViolations: style.kind === 'invalid' ? style.violations : [],
    };
  }

  return {
    kind: 'valid',
    parameters: {
      kind: request.kind,
      source: sourceCheck.source,
      model,
      style: style.parameters,
      ...kindSpecific.fields,
    },
    adjustments,
  };
}

/** Requirement 7.9: the selected model must positively support the requested kind. */
function modelViolations(
  catalogue: EditModelCatalogue,
  model: string,
  kind: EditKind,
): readonly EditFieldViolation[] {
  if (supportsEditKind(catalogue, model, kind)) return [];
  return [
    editUnsupportedByModelViolation('kind', kind, modelsSupportingEditKind(catalogue, kind)),
  ];
}

type StyleResolution =
  | { readonly kind: 'valid'; readonly parameters: SongParameters }
  | { readonly kind: 'invalid'; readonly violations: readonly SongFieldViolation[] };

/**
 * The musical side, through Requirement 4's validator.
 *
 * An absent style is a valid edit — Requirement 7.8's extend and 7.6's extract say
 * nothing about a caption — so it resolves to the empty Custom_Mode request, which
 * leaves every metadata field for the engine to decide (Requirement 4.7).
 */
function styleParameters(style: EditStyle | undefined): StyleResolution {
  const validation = validateSongRequest({ mode: 'custom', ...(style ?? {}) });
  if (validation.kind === 'invalid') return { kind: 'invalid', violations: validation.violations };
  return { kind: 'valid', parameters: validation.parameters };
}

interface KindResolution {
  readonly violations: readonly EditFieldViolation[];
  readonly fields: Partial<
    Pick<
      EditParameters,
      'coverStrength' | 'repaintStartSeconds' | 'repaintEndSeconds' | 'trackName' | 'trackClasses'
    >
  >;
}

/** The per-kind fields: Requirements 7.2, 7.3–7.5, 7.6, 7.7, 7.8. */
function resolveKind(
  request: EditRequest,
  source: SourceAudio,
  adjustments: RepaintAdjustment[],
): KindResolution {
  switch (request.kind) {
    case 'cover': {
      if (request.coverStrength === undefined) return { violations: [], fields: {} };
      const violation = coverStrengthViolation(request.coverStrength);
      return violation === undefined
        ? { violations: [], fields: { coverStrength: request.coverStrength } }
        : { violations: [violation], fields: {} };
    }

    case 'repaint': {
      const resolved = resolveRepaintRange({
        startSeconds: request.repaintStartSeconds,
        endSeconds: request.repaintEndSeconds,
        sourceDurationSeconds: source.durationSeconds,
      });
      if (resolved.kind === 'invalid') return { violations: resolved.violations, fields: {} };
      if (resolved.adjustment !== undefined) adjustments.push(resolved.adjustment);
      return {
        violations: [],
        fields: {
          repaintStartSeconds: resolved.range.startSeconds,
          repaintEndSeconds: resolved.range.endSeconds,
        },
      };
    }

    case 'extract':
    case 'lego':
      return trackNameResolution(request.kind, request.trackName);

    case 'complete': {
      const classes = request.trackClasses;
      if (classes === undefined) return { violations: [], fields: {} };
      const unknown = classes.filter((name) => !isTrackName(name));
      return unknown.length > 0
        ? { violations: [editEnumViolation('trackClasses', unknown, TRACK_NAMES)], fields: {} }
        : { violations: [], fields: { trackClasses: classes } };
    }
  }
}

/** Requirements 7.6 and 7.7: one of the twelve names, and not absent. */
function trackNameResolution(kind: EditKind, trackName: unknown): KindResolution {
  if (!requiresTrackName(kind)) return { violations: [], fields: {} };
  if (!isTrackName(trackName)) {
    return { violations: [editEnumViolation('trackName', trackName, TRACK_NAMES)], fields: {} };
  }
  return { violations: [], fields: { trackName } };
}
