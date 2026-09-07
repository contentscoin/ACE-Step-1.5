/**
 * A small PCM WAV, for tests that need real audio bytes rather than a placeholder.
 *
 * One second of a 440 Hz stereo tone at 22.05 kHz by default — below the canonical 48 kHz,
 * so a normalisation step that claims to resample has to actually do it. The right channel
 * is the left at three quarters, so a channel swap is visible too.
 */
export function wavBytes(sampleRate = 22_050, frames = 22_050): Uint8Array {
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
