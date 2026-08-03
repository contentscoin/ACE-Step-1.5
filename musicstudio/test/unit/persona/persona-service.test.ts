import { describe, expect, it } from 'vitest';

import { PERSONA_REFERENCE_MIN } from '../../../domain/persona/training-request';
import { createPersonaService } from '../../../services/persona/persona-service';
import {
  SongGateway,
  type PersonaAdapterResolver,
} from '../../../services/generation/song-gateway';
import {
  OWNER_ID,
  STRANGER_ID,
  fakeTrainingPort,
  inMemoryPersonaStore,
  personaAssetLookup,
  personaRecord,
} from '../../support/sharing-harness';
import { createMutableClock } from '../../support/mutable-clock';

/**
 * Persona_Service.
 *
 * **Validates: Requirements 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.7, 15.8**
 *
 * The queue tests are the ones worth reading. The ACE training API takes **one run at a
 * time**, so the second request cannot start and the honest report for it is "queued", not
 * the running persona's step count. A service that reported the engine's global status for
 * every persona would pass a single-user test and show one user another user's progress the
 * moment two of them train.
 */

const NOW = 1_700_000_000_000;
const REFERENCES = Array.from({ length: PERSONA_REFERENCE_MIN }, (_, index) => `ref-${String(index)}`);

function harness(seed: readonly ReturnType<typeof personaRecord>[] = []) {
  const personas = inMemoryPersonaStore(seed);
  const training = fakeTrainingPort();
  const clock = createMutableClock(new Date(NOW));
  const audited: { eventType: string; targetId: string }[] = [];
  let counter = 0;

  const service = createPersonaService({
    personas,
    training,
    assets: personaAssetLookup(REFERENCES),
    clock,
    generateId: () => `persona-${String((counter += 1))}`,
    audit: {
      record: async (event) => {
        audited.push({ eventType: event.eventType, targetId: event.targetId });
      },
    },
  });

  return { service, personas, training, clock, audited };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    ownerId: OWNER_ID,
    name: 'My Voice',
    referenceAssetIds: REFERENCES,
    consent: { rightsConfirmed: true, confirmedAtMs: NOW },
    ...overrides,
  };
}

describe('starting training (Requirements 15.1, 15.8)', () => {
  it('accepts eight references and returns a training identifier', async () => {
    const { service, training } = harness();

    const acceptance = await service.requestTraining(request());

    expect(acceptance.trainingJobId).toBe('persona-1');
    expect(acceptance.persona.status).toBe('training');
    expect(training.started).toEqual(['persona-1']);
  });

  it('records the rights consent (15.8)', async () => {
    const { service, audited, personas } = harness();

    const acceptance = await service.requestTraining(request());

    expect(audited).toEqual([{ eventType: 'consent_recorded', targetId: 'persona-1' }]);
    expect(personas.rows.get(acceptance.persona.id)?.rightsConfirmedAtMs).toBe(NOW);
  });

  it('refuses a request with no consent record', async () => {
    const { service, personas } = harness();

    const failure = await service
      .requestTraining(request({ consent: undefined }))
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ statusCode: 400, code: 'persona_request_invalid' });
    // Nothing was stored: a refused request leaves no persona behind.
    expect(personas.rows.size).toBe(0);
  });

  it('refuses a reference song the requester does not own', async () => {
    const { service } = harness();

    await expect(
      service.requestTraining(request({ referenceAssetIds: [...REFERENCES.slice(1), 'someone-else'] })),
    ).rejects.toMatchObject({ statusCode: 400, code: 'persona_reference_invalid' });
  });
});

describe('the eight-reference floor (Requirement 15.2)', () => {
  it('refuses seven and returns the minimum', async () => {
    const { service } = harness();

    const failure = await service
      .requestTraining(request({ referenceAssetIds: REFERENCES.slice(0, 7) }))
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ statusCode: 400, code: 'persona_request_invalid' });
    expect((failure as { details: Record<string, unknown> }).details).toMatchObject({
      minimumReferenceCount: 8,
    });
  });

  it('counts distinct songs, so eight copies of one is one', async () => {
    const { service } = harness();

    await expect(
      service.requestTraining(request({ referenceAssetIds: Array.from({ length: 8 }, () => 'ref-0') })),
    ).rejects.toMatchObject({ code: 'persona_request_invalid' });
  });
});

describe('the single-tenant queue (Requirements 15.1, 15.3)', () => {
  it('accepts a second request while the engine is busy, and queues it', async () => {
    const { service, training } = harness();

    const first = await service.requestTraining(request());
    const second = await service.requestTraining(request({ name: 'Second' }));

    expect(first.persona.status).toBe('training');
    expect(second.persona.status).toBe('queued');
    expect(second.queuePosition).toBe(1);
    expect(training.started).toEqual(['persona-1']);
  });

  it('reports the queued persona s own stage, not the running one s progress', async () => {
    const { service, training } = harness();
    await service.requestTraining(request());
    const second = await service.requestTraining(request({ name: 'Second' }));

    training.report = { ...training.report, currentStep: 42, totalSteps: 100 };

    const running = await service.progress('persona-1', OWNER_ID);
    const queued = await service.progress(second.persona.id, OWNER_ID);

    expect(running).toMatchObject({ stage: 'training', fraction: 0.42, currentStep: 42 });
    expect(queued).toMatchObject({ stage: 'queued', fraction: null, queuePosition: 1 });
  });

  it('starts the queued persona when the running one finishes', async () => {
    const { service, training } = harness();
    await service.requestTraining(request());
    const second = await service.requestTraining(request({ name: 'Second' }));

    training.finish();
    await service.completeTraining('persona-1');

    expect(training.started).toEqual(['persona-1', second.persona.id]);
    expect((await service.progress(second.persona.id, OWNER_ID)).stage).toBe('training');
  });

  it('does not attribute the engine s run to a persona that is not it', async () => {
    const { service, training } = harness();
    await service.requestTraining(request());
    const second = await service.requestTraining(request({ name: 'Second' }));

    // Get the second persona genuinely into `training` — the engine frees up, the queue
    // starts it — and only then have the engine report a *different* run. That is the real
    // window: a status poll landing between the engine switching runs and the store
    // catching up. Asserting this against a persona still queued would prove nothing,
    // because a queued persona never reads the engine's numbers anyway.
    training.finish();
    await service.completeTraining('persona-1');
    expect((await service.progress(second.persona.id, OWNER_ID)).stage).toBe('training');

    training.report = {
      ...training.report,
      isTraining: true,
      trainingJobId: 'run-somebody-else',
      stage: 'training',
      currentStep: 90,
      totalSteps: 100,
    };

    const progress = await service.progress(second.persona.id, OWNER_ID);
    expect(progress.currentStep).toBeNull();
    expect(progress.fraction).toBeNull();
    expect(progress.stage).toBe('training');
  });
});

describe('completion and selection (Requirements 15.4, 15.5, 15.6)', () => {
  it('registers the adapter and makes the persona selectable', async () => {
    const { service } = harness();
    await service.requestTraining(request());

    const ready = await service.completeTraining('persona-1');

    expect(ready.status).toBe('ready');
    expect(ready.adapterRef).toBe('adapter-persona-1');
    expect(await service.resolveAdapter('persona-1', OWNER_ID)).toBe('adapter-persona-1');
  });

  it('refuses a persona the requester does not own with 403 (15.6)', async () => {
    const { service } = harness();
    await service.requestTraining(request());
    await service.completeTraining('persona-1');

    await expect(service.resolveAdapter('persona-1', STRANGER_ID)).rejects.toMatchObject({
      statusCode: 403,
      code: 'persona_forbidden',
    });
  });

  it('refuses a persona that has not finished training', async () => {
    const { service } = harness();
    await service.requestTraining(request());

    await expect(service.resolveAdapter('persona-1', OWNER_ID)).rejects.toMatchObject({
      statusCode: 409,
      code: 'persona_not_ready',
    });
  });

  it('refuses a persona that failed', async () => {
    const { service } = harness();
    await service.requestTraining(request());
    await service.failTraining('persona-1');

    await expect(service.resolveAdapter('persona-1', OWNER_ID)).rejects.toMatchObject({
      code: 'persona_not_ready',
    });
  });
});

describe('deletion (Requirement 15.7)', () => {
  it('removes the adapter and makes the persona unselectable', async () => {
    const { service, training } = harness();
    await service.requestTraining(request());
    await service.completeTraining('persona-1');

    const deleted = await service.remove('persona-1', OWNER_ID);

    expect(deleted.status).toBe('deleted');
    expect(deleted.adapterRef).toBeNull();
    expect(training.deletedAdapters).toEqual(['adapter-persona-1']);
    await expect(service.resolveAdapter('persona-1', OWNER_ID)).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(await service.list(OWNER_ID)).toEqual([]);
  });

  it('refuses to delete another account s persona', async () => {
    const { service } = harness();
    await service.requestTraining(request());

    await expect(service.remove('persona-1', STRANGER_ID)).rejects.toMatchObject({
      statusCode: 403,
    });
  });
});

describe('the Generation_Gateway applies the adapter (Requirements 15.5, 15.6)', () => {
  const SONG_REQUEST = {
    mode: 'simple' as const,
    description: 'a quiet lo-fi loop',
    durationSeconds: 60,
    batchSize: 1,
  };

  function gateway(personas: PersonaAdapterResolver) {
    const submitted: unknown[] = [];
    const orchestrator = {
      submit: async (input: unknown) => {
        submitted.push(input);
        return { kind: 'accepted' as const, acceptance: {} as never };
      },
    } as unknown as ConstructorParameters<typeof SongGateway>[0]['orchestrator'];

    return { submitted, gateway: new SongGateway({ orchestrator, personas }) };
  }

  it('threads the resolved adapter ref into the submission', async () => {
    const { service } = harness();
    await service.requestTraining(request());
    await service.completeTraining('persona-1');

    const { submitted, gateway: songs } = gateway(service);
    await songs.submit({ accountId: OWNER_ID, request: SONG_REQUEST, personaId: 'persona-1' });

    expect(submitted[0]).toMatchObject({ personaAdapterRef: 'adapter-persona-1' });
  });

  it('carries no persona field when none was named', async () => {
    const { service } = harness();
    const { submitted, gateway: songs } = gateway(service);

    await songs.submit({ accountId: OWNER_ID, request: SONG_REQUEST });

    expect(submitted[0]).not.toHaveProperty('personaAdapterRef');
  });

  it('refuses before the orchestrator is touched when the persona is not the caller s', async () => {
    // 15.6's 403 must arrive before routing, moderation and the credit debit — a refusal
    // after a charge would need a refund path that no criterion describes.
    const { service } = harness();
    await service.requestTraining(request());
    await service.completeTraining('persona-1');

    const { submitted, gateway: songs } = gateway(service);

    await expect(
      songs.submit({ accountId: STRANGER_ID, request: SONG_REQUEST, personaId: 'persona-1' }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(submitted).toEqual([]);
  });
});
