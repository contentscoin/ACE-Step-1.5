import { describe, expect, it } from 'vitest';

import { createDspHttpClient, DspTaskFailed } from '../../services/generation/adapters/dsp-http-client';
import { wavBytes } from '../support/wav-fixture';

/**
 * The TypeScript client against the real Python sidecar (S2 ↔ S3).
 *
 * Gated on `MUSICSTUDIO_DSP_URL` the way the database tests are gated on their URL: without a
 * running sidecar this file skips, and with one it proves the two halves of the seam agree on
 * the wire — the client sends what the sidecar reads, decodes what the sidecar writes, and
 * turns its error envelope into a typed failure.
 *
 * Start one with `cd dsp && PYTHONPATH=src python -m musicstudio_dsp.sidecar` (default
 * `127.0.0.1:8002`). The compose file in S5 is what makes this run in CI.
 */

const sidecarUrl = process.env['MUSICSTUDIO_DSP_URL'];
const describeSidecar = sidecarUrl === undefined ? describe.skip : describe;

describeSidecar('DSP HTTP client against the running sidecar', () => {
  // Built inside each test, not at the top of the block: vitest runs a skipped `describe`'s
  // callback to collect its tests, and with no URL a client built here would throw during
  // collection and fail the whole file — in every shard, on every machine without a sidecar.
  const client = () => createDspHttpClient({ baseUrl: sidecarUrl as string });

  it('normalises engine output to 48 kHz and reports the watermark that marked it', async () => {
    const report = await client().normaliseForStorage(wavBytes());

    expect(report.sampleRate).toBe(48_000);
    expect(report.originalSampleRate).toBe(22_050);
    expect(report.resampled).toBe(true);
    expect(report.channels).toBe(2);
    expect(report.durationMs).toBeCloseTo(1_000, -1);
    expect(Number.isInteger(report.watermarkVersion) && report.watermarkVersion >= 1).toBe(true);
    // The container the pipeline declares — FLAC — and the bytes agree with the label.
    expect(report.audioFormat).toBe('flac');
    expect(Buffer.from(report.bytes.subarray(0, 4)).toString('ascii')).toBe('fLaC');
  });

  it("turns the sidecar's error envelope into a typed failure that names the task and code", async () => {
    const failure = client().normaliseForStorage(new Uint8Array([1, 2, 3, 4]));
    await expect(failure).rejects.toBeInstanceOf(DspTaskFailed);
    await expect(failure).rejects.toMatchObject({
      task: 'musicstudio_dsp.normalise_for_storage',
      httpStatus: 500,
      code: 'task_failed',
    });
  });
});
