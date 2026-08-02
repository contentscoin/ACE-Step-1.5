import { describe, expect, it, vi } from 'vitest';

import { toChain } from '../../../domain/effects/chain';
import type { GenerationVersion } from '../../../domain/generation-version';
import {
  createEffectsService,
  lengthViolationFor,
} from '../../../services/effects/effects-service';
import type {
  EffectProcessingPort,
  EffectProcessingResult,
  EffectProcessingSubject,
} from '../../../services/effects/ports';

/**
 * `Effects_Service` — validation before the queue, the length invariants, and previews.
 *
 * **Validates: Requirements 29.9, 29.10, 29.13, 29.14, 29.28, 29.29, 29.30, 29.32**
 *
 * The port is a stub, and deliberately so: no broker is reachable, and the behaviour under
 * test here is the *product layer's*. The audio half of Requirements 29.29 and 29.30 — the
 * actual samples — is Properties 14 and 24 in `dsp/test/test_effects.py`, where real
 * `pedalboard` processing happens. What this suite establishes is the half that cannot be
 * tested from Python: that a bad chain is refused **before** the port is called at all, which
 * is what makes Requirement 29.10's synchronous response possible.
 */

const ASSET = 'asset-1';
const SUBJECT: EffectProcessingSubject = {
  objectKey: 'assets/a.flac',
  sampleRate: 48_000,
  channels: 2,
  frameCount: 48_000,
};
const GAIN = [{ kind: 'gain', parameters: { gain_db: -3 } }];
const REVERB = [
  {
    kind: 'reverb',
    parameters: { room_size: 0.5, damping: 0.5, wet_level: 0.3, dry_level: 0.7, width: 1 },
  },
];

function initialVersions(): GenerationVersion[] {
  return [
    {
      id: 'v-original',
      assetId: ASSET,
      name: 'Original',
      effectChain: [],
      derivedFromVersionId: null,
      isDefault: true,
      isOriginal: true,
      durationMs: 1000,
      createdAtMs: 1000,
    },
  ];
}

function stubPort(overrides: Partial<EffectProcessingResult> = {}): {
  port: EffectProcessingPort;
  process: ReturnType<typeof vi.fn>;
} {
  const process = vi.fn(
    async (): Promise<EffectProcessingResult> => ({
      objectKey: 'assets/a-processed.flac',
      sampleRate: 48_000,
      channels: 2,
      frameCount: 48_000,
      durationMs: 1000,
      tailTruncated: false,
      ...overrides,
    }),
  );
  return { port: { process }, process };
}

function applyInput(chain: unknown) {
  return {
    assetId: ASSET,
    versions: initialVersions(),
    sourceVersionId: 'v-original',
    subject: SUBJECT,
    chain,
    newVersionId: 'v-2',
    name: 'Quieter',
    createdAtMs: 2000,
  };
}

describe('Requirements 29.9, 29.10 — a bad chain is refused before work is queued', () => {
  it('never calls the port for an out-of-range parameter', () => {
    // The whole reason validation lives in the product layer: a worker-only check would
    // answer minutes later, through a job failure, and 29.10 asks for a response now.
    const { port, process } = stubPort();
    return createEffectsService(port)
      .applyChain(applyInput([{ kind: 'gain', parameters: { gain_db: 99 } }]))
      .then((outcome) => {
        expect(outcome.ok).toBe(false);
        if (!outcome.ok) {
          expect(outcome.code).toBe('chain_invalid');
          expect(outcome.chainViolations?.[0]?.name).toBe('gain_db');
          expect(outcome.chainViolations?.[0]?.permittedRange).toBe('-40..40');
        }
        expect(process).not.toHaveBeenCalled();
      });
  });

  it('never calls the port for an unknown kind', async () => {
    const { port, process } = stubPort();
    const outcome = await createEffectsService(port).applyChain(
      applyInput([{ kind: 'bitcrusher', parameters: {} }]),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.chainViolations?.[0]?.name).toBe('bitcrusher');
    expect(process).not.toHaveBeenCalled();
  });

  it('reports every fault, not only the first', async () => {
    // 29.9/29.10 place no first-only limit on the *service*; only 29.33 does, and that
    // constrains the parser.
    const { port } = stubPort();
    const outcome = await createEffectsService(port).applyChain(
      applyInput([
        { kind: 'gain', parameters: { gain_db: 99 } },
        { kind: 'pitch_shift', parameters: { semitones: 99 } },
      ]),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.chainViolations).toHaveLength(2);
  });

  it('refuses an over-long chain (Requirement 29.13)', async () => {
    const { port, process } = stubPort();
    const outcome = await createEffectsService(port).applyChain(
      applyInput(Array.from({ length: 17 }, () => GAIN[0])),
    );
    expect(outcome.ok).toBe(false);
    expect(process).not.toHaveBeenCalled();
  });
});

describe('Requirement 29.14 — a successful apply adds one version', () => {
  it('creates a derived version and leaves the default alone', async () => {
    const { port } = stubPort();
    const outcome = await createEffectsService(port).applyChain(applyInput(GAIN));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.versions).toHaveLength(2);
    expect(outcome.created.derivedFromVersionId).toBe('v-original');
    expect(outcome.created.isDefault).toBe(false);
    expect(outcome.versions.filter((v) => v.isDefault).map((v) => v.id)).toEqual(['v-original']);
  });

  it('sends the validated chain to the port, canonically ordered', async () => {
    const { port, process } = stubPort();
    await createEffectsService(port).applyChain(
      applyInput([{ kind: 'delay', parameters: { mix: 0.3, feedback: 0.2, delay_seconds: 0.1 } }]),
    );
    const sent = process.mock.calls[0]?.[0] as { chain: { items: { parameters: object }[] } };
    expect(Object.keys(sent.chain.items[0]?.parameters ?? {})).toEqual([
      'delay_seconds',
      'feedback',
      'mix',
    ]);
  });

  it('surfaces a version refusal rather than swallowing it', async () => {
    const { port } = stubPort();
    const outcome = await createEffectsService(port).applyChain({
      ...applyInput(GAIN),
      sourceVersionId: 'v-missing',
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('version_not_found');
      expect(outcome.versionRefusal?.versionId).toBe('v-missing');
    }
  });
});

describe('Requirement 29.28 — a preview stores nothing', () => {
  it('returns the processing result without creating a version', async () => {
    const { port, process } = stubPort({ objectKey: null });
    const outcome = await createEffectsService(port).previewChain({
      subject: SUBJECT,
      chain: GAIN,
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.processing.objectKey).toBeNull();
    // The preview path has no version set in scope and no identifier to create one with,
    // so it *cannot* store a version. The flag reaching the worker is the observable half.
    expect(process.mock.calls[0]?.[0]).toMatchObject({ preview: true });
    expect(outcome.ok && 'versions' in outcome).toBe(false);
  });

  it('validates a preview chain just as strictly', async () => {
    const { port, process } = stubPort();
    const outcome = await createEffectsService(port).previewChain({
      subject: SUBJECT,
      chain: [{ kind: 'gain', parameters: { gain_db: 99 } }],
    });
    expect(outcome.ok).toBe(false);
    expect(process).not.toHaveBeenCalled();
  });

  it('marks a non-preview apply as not a preview', async () => {
    const { port, process } = stubPort();
    await createEffectsService(port).applyChain(applyInput(GAIN));
    expect(process.mock.calls[0]?.[0]).toMatchObject({ preview: false });
  });
});

describe('Requirements 29.30, 29.32 — the length invariants', () => {
  const noTail = toChain(GAIN);
  const withTail = toChain(REVERB);

  it('29.30 — accepts a length within ±10 ms and refuses one beyond it', () => {
    expect(lengthViolationFor(noTail, 1000, 1000)).toBeNull();
    expect(lengthViolationFor(noTail, 1000, 1010)).toBeNull();
    expect(lengthViolationFor(noTail, 1000, 990)).toBeNull();
    expect(lengthViolationFor(noTail, 1000, 1011)).toBe('length_not_preserved');
    expect(lengthViolationFor(noTail, 1000, 989)).toBe('length_not_preserved');
  });

  it('29.32 — accepts up to the original plus 10 s and refuses beyond', () => {
    expect(lengthViolationFor(withTail, 1000, 1000)).toBeNull();
    expect(lengthViolationFor(withTail, 1000, 11_000)).toBeNull();
    expect(lengthViolationFor(withTail, 1000, 11_001)).toBe('tail_allowance_exceeded');
  });

  it('29.32 — refuses a result shorter than the original', () => {
    // A reverb cannot shorten audio, so a shorter result means something went wrong
    // rather than that a tolerance was tight. Only the ±10 ms of rounding slack is given.
    expect(lengthViolationFor(withTail, 1000, 995)).toBeNull();
    expect(lengthViolationFor(withTail, 1000, 900)).toBe('tail_allowance_exceeded');
  });

  it('refuses a worker result that breaches 29.30', async () => {
    const { port } = stubPort({ durationMs: 2000, frameCount: 96_000 });
    const outcome = await createEffectsService(port).applyChain(applyInput(GAIN));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('length_not_preserved');
  });

  it('accepts a reverb result inside 29.32\u2019s allowance', async () => {
    const { port } = stubPort({ durationMs: 6000, frameCount: 288_000, tailTruncated: true });
    const outcome = await createEffectsService(port).applyChain(applyInput(REVERB));
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.processing.tailTruncated).toBe(true);
  });

  it('refuses a reverb result beyond 29.32\u2019s allowance', async () => {
    const { port } = stubPort({ durationMs: 20_000, frameCount: 960_000 });
    const outcome = await createEffectsService(port).applyChain(applyInput(REVERB));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('tail_allowance_exceeded');
  });
});

describe('Requirement 29.29 — the shape half of reproducibility', () => {
  it('refuses a result whose channel count changed', async () => {
    const { port } = stubPort({ channels: 1 });
    const outcome = await createEffectsService(port).applyChain(applyInput(GAIN));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.detail).toContain('shape changed');
  });

  it('refuses a result whose sample rate changed', async () => {
    const { port } = stubPort({ sampleRate: 44_100 });
    const outcome = await createEffectsService(port).applyChain(applyInput(GAIN));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.detail).toContain('shape changed');
  });
});
