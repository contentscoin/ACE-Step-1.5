"""Synthesised UI cues, for the sound-pack tests (Requirement 24).

Every buffer here is generated from a closed-form or seeded-random expression, so its
properties are *known* rather than assumed — the same discipline
``test/support/pcm-synthesis.ts`` follows on the TypeScript side, and for the same
reason: a recording would carry noise and codec artefacts of unknown size, and every
tolerance would have to be widened until the tests no longer distinguished a correct
measurement from an approximately correct one.

The interesting function is :func:`distinct_cue`. Requirement 24.9's ceiling is a claim
about *timbral* similarity, so a pack of 78 pure tones will not do: decaying sines at
different pitches share a spectral envelope, so their 13-dimension MFCCs are nearly
collinear and hundreds of pairs land above 0.95. Measured, before the shaped-noise
approach below: 78 decaying sines spaced 40 Hz apart produce **307** exceeding pairs.

:func:`distinct_cue` instead gives each cue an independent spectral envelope — a gain per
mel band drawn from a seeded generator over a 40 dB range — which is exactly the quantity
an MFCC measures. The 13-vectors are then effectively independent random directions,
whose pairwise cosine similarity concentrates near 0 with a spread of about
``1/sqrt(13) ≈ 0.28``; 0.95 is over three spreads away, so the margin is structural
rather than lucky. Measured: max pairwise similarity ≈ 0.87 across all 3003 pairs.
"""

from __future__ import annotations

import numpy as np

from musicstudio_dsp.audio_buffer import AudioBuffer
from musicstudio_dsp.mfcc import MEL_BANDS, hz_to_mel, mel_to_hz

SAMPLE_RATE = 48_000

#: Dynamic range of the per-band gains, in dB below unity. See the module docstring.
BAND_GAIN_RANGE_DB = -40.0

#: Envelope exponent. Chosen so the last 50 ms of a 0.05–1.5 s cue is already far below
#: 5 % of the peak, which is Requirement 24.8's rule — the same construction
#: ``decayingOneShot`` uses on the TypeScript side.
DECAY_EXPONENT = 8.0


def decaying_tone(
    frequency_hz: float = 440.0,
    duration_ms: float = 200.0,
    amplitude: float = 0.6,
    sample_rate: int = SAMPLE_RATE,
) -> AudioBuffer:
    """A sine under a ``(1 - t/T)^k`` envelope. A plausible one-shot, and 24.8-compliant."""
    frames = max(1, int(round(sample_rate * duration_ms / 1000.0)))
    t = np.arange(frames, dtype=np.float64) / float(sample_rate)
    envelope = (1.0 - np.arange(frames, dtype=np.float64) / frames) ** DECAY_EXPONENT
    wave = amplitude * envelope * np.sin(2.0 * np.pi * frequency_hz * t)
    return AudioBuffer.from_channels(sample_rate, [wave.astype(np.float32)])


def seamless_loop(
    frequency_hz: float = 200.0,
    duration_ms: float = 1_000.0,
    amplitude: float = 0.4,
    sample_rate: int = SAMPLE_RATE,
) -> AudioBuffer:
    """A tone snapped to a whole number of cycles, so its seam is continuous (24.6)."""
    frames_per_cycle = sample_rate / frequency_hz
    target = sample_rate * duration_ms / 1000.0
    cycles = max(1, int(target // frames_per_cycle))
    frames = int(round(cycles * frames_per_cycle))
    t = np.arange(frames, dtype=np.float64) / float(sample_rate)
    wave = amplitude * np.sin(2.0 * np.pi * frequency_hz * t)
    return AudioBuffer.from_channels(sample_rate, [wave.astype(np.float32)])


def _mel_band_bin_edges(frames: int, sample_rate: int, bands: int) -> np.ndarray:
    """Bin indices of the mel band edges, for shaping a spectrum band by band."""
    mels = np.linspace(0.0, float(hz_to_mel(sample_rate / 2.0)), bands + 1)
    return np.asarray(mel_to_hz(mels), dtype=np.float64) * frames / float(sample_rate)


def distinct_cue(
    seed: int,
    duration_ms: float = 120.0,
    amplitude: float = 0.7,
    sample_rate: int = SAMPLE_RATE,
    bands: int = MEL_BANDS,
) -> AudioBuffer:
    """Noise with a seed-specific spectral envelope, decayed. See the module docstring.

    Deterministic in ``seed``: ``numpy.random.default_rng(seed)`` is reproducible across
    processes and NumPy versions for the generators used here, so a failure is
    reproducible from the seed printed with it.
    """
    rng = np.random.default_rng(seed)
    frames = max(2, int(round(sample_rate * duration_ms / 1000.0)))
    spectrum_length = frames // 2 + 1

    gains = 10.0 ** (rng.uniform(BAND_GAIN_RANGE_DB, 0.0, bands) / 20.0)
    edges = _mel_band_bin_edges(frames, sample_rate, bands)
    envelope = np.zeros(spectrum_length, dtype=np.float64)
    for band in range(bands):
        low = int(edges[band])
        high = max(low + 1, int(edges[band + 1]))
        envelope[low : min(high, spectrum_length)] = gains[band]

    phase = rng.uniform(0.0, 2.0 * np.pi, spectrum_length)
    signal = np.fft.irfft(envelope * np.exp(1j * phase), frames)
    peak = float(np.max(np.abs(signal)))
    if peak > 0.0:
        signal = signal / peak * amplitude
    decay = (1.0 - np.arange(frames, dtype=np.float64) / frames) ** DECAY_EXPONENT
    return AudioBuffer.from_channels(sample_rate, [(signal * decay).astype(np.float32)])


def distinct_pack(
    count: int = 78, base_seed: int = 24_000, duration_ms: float = 120.0
) -> list[AudioBuffer]:
    """``count`` cues, pairwise dissimilar by construction."""
    return [distinct_cue(base_seed + index, duration_ms=duration_ms) for index in range(count)]


def silence(duration_ms: float = 200.0, sample_rate: int = SAMPLE_RATE) -> AudioBuffer:
    frames = max(1, int(round(sample_rate * duration_ms / 1000.0)))
    return AudioBuffer.from_channels(sample_rate, [np.zeros(frames, dtype=np.float32)])


def scaled(audio: AudioBuffer, gain: float) -> AudioBuffer:
    return AudioBuffer.from_channels(
        audio.sample_rate, [channel.astype(np.float64) * gain for channel in audio.channels]
    )


def duplicated_to_stereo(audio: AudioBuffer) -> AudioBuffer:
    channel = audio.channels[0]
    return AudioBuffer.from_channels(audio.sample_rate, [channel, np.array(channel)])
