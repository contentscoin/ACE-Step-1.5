import { describe, expect, it } from 'vitest';

import { createDspHttpClient, DspTaskFailed } from '../../services/generation/adapters/dsp-http-client';

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

/** A one-second 440 Hz stereo WAV at 22.05 kHz — below 48 kHz, so the resample has to happen. */
function wavBytes(sampleRate = 22_050, frames = 22_050): Uint8Array {
  const channels = 2;
  const bytesPerSample = 2;
  const dataBytes = frames * channels * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < frames; i += 1) {
    const sample = Math.round(0.5 * Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0x7fff);
    view.setInt16(44 + i * 4, sample, true);
    view.setInt16(46 + i * 4, Math.round(sample * 0.75), true);
  }
  return new Uint8Array(buffer);
}

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
