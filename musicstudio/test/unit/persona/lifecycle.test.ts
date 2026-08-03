import { describe, expect, it } from 'vitest';

import {
  PERSONA_STATUSES,
  canTransition,
  isSelectable,
  isTerminal,
} from '../../../domain/persona/persona';
import {
  TRAINING_STAGES,
  isTrainingStage,
  progressFraction,
  stageForStatus,
} from '../../../domain/persona/progress';
import { personaRecord } from '../../support/sharing-harness';

/**
 * The persona lifecycle and its progress reporting.
 *
 * **Validates: Requirements 15.3, 15.4, 15.5, 15.7**
 *
 * `deleted` being terminal is the transition worth pinning: Requirement 15.7 says a deleted
 * persona is "선택 불가로 처리", and a state machine that let it move anywhere else would make
 * that a property of whoever remembered to check rather than of the persona.
 */

describe('the status machine (Requirements 15.4, 15.7)', () => {
  it('runs queued → training → ready', () => {
    expect(canTransition('queued', 'training')).toBe(true);
    expect(canTransition('training', 'ready')).toBe(true);
  });

  it('lets any live state fail or be deleted', () => {
    for (const from of ['queued', 'training'] as const) {
      expect(canTransition(from, 'failed')).toBe(true);
      expect(canTransition(from, 'deleted')).toBe(true);
    }
  });

  it('never leaves deleted', () => {
    for (const to of PERSONA_STATUSES) {
      expect(canTransition('deleted', to)).toBe(false);
    }
  });

  it('never revives a failed run — a new attempt is a new persona', () => {
    for (const to of ['queued', 'training', 'ready'] as const) {
      expect(canTransition('failed', to)).toBe(false);
    }
    expect(canTransition('failed', 'deleted')).toBe(true);
  });

  it('never goes back to training from ready', () => {
    expect(canTransition('ready', 'training')).toBe(false);
    expect(canTransition('ready', 'queued')).toBe(false);
  });

  it('reports the three terminal states', () => {
    expect(PERSONA_STATUSES.filter(isTerminal)).toEqual(['ready', 'failed', 'deleted']);
  });
});

describe('selectability (Requirement 15.5)', () => {
  it('needs both the ready state and an adapter', () => {
    expect(isSelectable(personaRecord({ status: 'ready', adapterRef: 'adapter-1' }))).toBe(true);
    expect(isSelectable(personaRecord({ status: 'ready', adapterRef: null }))).toBe(false);
    expect(isSelectable(personaRecord({ status: 'training', adapterRef: 'adapter-1' }))).toBe(false);
    expect(isSelectable(personaRecord({ status: 'deleted', adapterRef: null }))).toBe(false);
  });
});

describe('progress (Requirement 15.3)', () => {
  it('reports a fraction of completed steps', () => {
    expect(progressFraction(25, 100)).toBe(0.25);
    expect(progressFraction(0, 100)).toBe(0);
    expect(progressFraction(100, 100)).toBe(1);
  });

  it('reports null rather than 0 when the total is unknown', () => {
    // "0%" and "not started" are different things to whoever is watching.
    expect(progressFraction(null, 100)).toBeNull();
    expect(progressFraction(10, null)).toBeNull();
    expect(progressFraction(10, 0)).toBeNull();
  });

  it('clamps a step past the total rather than reporting over 100%', () => {
    expect(progressFraction(150, 100)).toBe(1);
    expect(progressFraction(-5, 100)).toBe(0);
  });

  it('maps every status to a stage', () => {
    for (const status of PERSONA_STATUSES) {
      expect(isTrainingStage(stageForStatus(status))).toBe(true);
    }
    expect(stageForStatus('queued')).toBe('queued');
    expect(stageForStatus('ready')).toBe('completed');
  });

  it('publishes the stage vocabulary a client renders', () => {
    expect(TRAINING_STAGES).toContain('preprocessing');
    expect(TRAINING_STAGES).toContain('exporting');
  });
});
