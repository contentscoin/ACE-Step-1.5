/**
 * The demo backend's audio, in one place (track A of `docs/ROADMAP.md`).
 *
 * ### Why this file exists at all
 *
 * The demo backend used to claim audio it did not have. `streamUrl` returned `demo:stream/<id>`
 * with a comment saying the player synthesised a tone from it; the player never read it, never
 * built an `AudioContext`, and "재생" started a 100 ms timer over silence. The download panel
 * reported a prepared file of `duration × 48000 × channels × 2` bytes — arithmetic, not a file.
 * Both read as working features, which is worse than an absent one: a missing button is a gap, a
 * button that reports success for something that did not happen is a false statement.
 *
 * So the demo now renders audio it can actually hand over, and one renderer serves both uses. The
 * file you download is the audio you heard, sample for sample, because both call `renderDemoTone`.
 * Two renderers would drift, and the drift would land exactly where nobody looks — a download that
 * sounds different from the preview.
 *
 * ### What it is, and what it is not
 *
 * A seeded harmonic tone. It is **not** music, and no part of this file pretends otherwise; the
 * screens say so beside every control that plays or delivers it. It exists so that the transport
 * and the download path are real code paths with real bytes at the end, which is what makes them
 * worth replacing later with an object store rather than worth rewriting.
 *
 * The seed is the asset id, hashed the same way `waveformOf` hashes it, so the drawing and the
 * sound come from one number. A drawing that peaked where the audio was quiet would be a third
 * claim about audio nobody generated.
 */

/**
 * Mono, and 22.05 kHz rather than 48 kHz.
 *
 * The demo renders in the main thread on a click, so the cost is a stall the user feels. At
 * 22.05 kHz a 30-second render is ~660k samples — a few milliseconds — and the material is a
 * band-limited tone whose partials all sit below 5 kHz, so nothing in it is lost to the lower
 * rate. A real deployment streams engine output at the asset's own rate; this number belongs to
 * the demo, not to the product.
 */
export const DEMO_SAMPLE_RATE = 22_050;

/**
 * ### The tone runs the asset's full length, and is not capped
 *
 * A cap was the obvious economy — the seeded library holds assets up to 3:04, and nobody needs
 * three minutes of a repeating tone. It was the wrong economy. Capping means the transport reads
 * 3:04 while the audio stops at 0:30, the waveform draws a length the sound does not have, and the
 * downloaded file is shorter than the asset it is named after. Each of those is the same class of
 * defect this whole change is removing: a screen stating something the artefact does not support.
 *
 * The full length costs ~8 MB at this rate for the longest seeded asset, rendered in well under a
 * frame's budget on a click. That is affordable, and it buys agreement between the drawing, the
 * clock, the sound and the file.
 */

export interface DemoTone {
  readonly sampleRate: number;
  readonly channels: 1;
  readonly durationMs: number;
  readonly samples: Float32Array;
}

/** The same hash `demo-api.ts` uses for the waveform drawing, so both read one seed. */
function seedOf(assetId: string): number {
  let seed = 0;
  for (const character of assetId) seed = (seed * 31 + character.charCodeAt(0)) % 100_000;
  return seed;
}

/**
 * A seeded tone for an asset, capped at `DEMO_MAX_DURATION_MS`.
 *
 * Deterministic in the asset id: the same asset always renders the same audio, so a download taken
 * twice is the same file and a reload does not change what the user is listening to.
 */
export function renderDemoTone(assetId: string, durationMs: number): DemoTone {
  const lengthMs = Math.max(0, durationMs);
  const frames = Math.round((lengthMs / 1000) * DEMO_SAMPLE_RATE);
  const seed = seedOf(assetId);

  // A root in a comfortable listening range, offset by the seed so two assets are distinguishable
  // by ear. Kept inside one octave: the point is "these are different", not a melody.
  const root = 180 + (seed % 120);
  const samples = new Float32Array(frames);

  for (let index = 0; index < frames; index += 1) {
    const t = index / DEMO_SAMPLE_RATE;
    // Three partials rather than one, because a single sine reads as a fault tone — a listener
    // hears a bare sine as "something is broken", not as "this is a placeholder".
    const voice =
      Math.sin(2 * Math.PI * root * t) +
      0.5 * Math.sin(2 * Math.PI * root * 2 * t) +
      0.25 * Math.sin(2 * Math.PI * root * 3 * t + seed / 100_000);
    // A slow swell so the waveform drawing has something to draw and the ear has something to
    // track while seeking.
    const envelope = 0.35 + 0.4 * Math.abs(Math.sin(2 * Math.PI * t * 0.25));
    // A short fade at each end: a buffer that starts and stops at full amplitude clicks, and a
    // click is indistinguishable from a decoding fault.
    const fadeFrames = Math.min(frames / 2, DEMO_SAMPLE_RATE * 0.02);
    const fade =
      fadeFrames <= 0 ? 1 : Math.min(1, index / fadeFrames, (frames - index) / fadeFrames);
    samples[index] = 0.22 * envelope * fade * (voice / 1.75);
  }

  return { sampleRate: DEMO_SAMPLE_RATE, channels: 1, durationMs: lengthMs, samples };
}

/**
 * 16-bit PCM WAV.
 *
 * Written by hand rather than pulled in, because the alternative is a dependency for 40 lines and
 * Requirement 31.17 makes every dependency a licence obligation to carry. WAV is also the one
 * container a browser will play and a user's tools will open without an encoder — the demo has no
 * MP3 encoder and does not pretend to; `AssetPage` says which format was asked for and which one
 * arrived.
 */
export function encodeWav(tone: DemoTone): ArrayBuffer {
  const bytesPerSample = 2;
  const dataBytes = tone.samples.length * bytesPerSample * tone.channels;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  const ascii = (offset: number, text: string): void => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };

  const byteRate = tone.sampleRate * tone.channels * bytesPerSample;

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM header length
  view.setUint16(20, 1, true); // PCM, uncompressed
  view.setUint16(22, tone.channels, true);
  view.setUint32(24, tone.sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, tone.channels * bytesPerSample, true); // block align
  view.setUint16(34, 8 * bytesPerSample, true);
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);

  for (let index = 0; index < tone.samples.length; index += 1) {
    // Clamp before scaling: a sample above 1 would wrap to the opposite rail rather than clip, and
    // a wrap is an audible crack rather than a squashed peak.
    const clamped = Math.max(-1, Math.min(1, tone.samples[index] ?? 0));
    view.setInt16(44 + index * bytesPerSample, Math.round(clamped * 0x7f_ff), true);
  }

  return buffer;
}
