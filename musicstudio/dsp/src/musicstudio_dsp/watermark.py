"""Inaudible AI-generation watermark (Requirement 16.6, design §9.5).

> WHEN Audio_Asset 오디오가 저장되면, THE MusicStudio SHALL 해당 오디오에 AI
> 생성 여부를 식별할 수 있는 워터마크 정보를 포함한다

Two words in that clause decide the whole design: **AI 생성 여부** — whether the
audio was AI-generated. The mark has to answer a yes/no question about the
audio itself, not carry a database row.

### Why the mark carries presence and not a payload

The obvious design is a payload: put the asset identifier in the audio, read it
back, look it up. It does not survive contact with the shortest assets the
product stores. A one-shot ``sfx`` is routinely 0.4 s — 19 200 samples at
48 kHz — and a watermark that is inaudible is by construction some 30 dB below
the programme material, so the detector's whole budget is the processing gain
of correlating over those samples. Spread 64 payload bits across them and each
bit gets 300 samples of gain, which is not enough to read a bit reliably; the
measured error rate for that design was 33%, i.e. a coin toss. Spend the same
budget on *one* hypothesis and the margin is 5 sigma on the same 0.4 s clip and
13 sigma on three seconds.

So the audio answers "is this ours" and the *identifier* lives where identifiers
belong: in the asset's provenance record (``domain/provenance.ts``'s
``watermarkId``) and in the downloaded file's metadata tag (Requirement 13.7).
The three are independent — stripping the container tag does not remove the
mark, and re-encoding does not remove the provenance row.

A consequence worth stating plainly: this detects **that the audio carries this
product's mark**, and it is not a forensic tool. It is not designed to survive
an adversary who knows the key and wants the mark gone, and a determined
re-record through the air will defeat it. What it does do is what the clause
asks: audio that leaves this product can be identified as AI-generated, through
an ordinary format conversion, by anyone holding the key.

### The scheme

A pseudorandom carrier, band-limited to 1–6 kHz, is added at an amplitude that
follows the programme material's own short-term RMS:

* **Band-limited** because the ends of the spectrum are where lossy codecs
  spend their bit budget last. Measured across MP3 and Ogg Vorbis the in-band
  mark survives with a few percent of loss; a full-band carrier loses its top
  octaves to the codec.
* **Envelope-shaped** because a fixed amplitude is the audible design. A mark
  30 dB below a loud passage is 30 dB *above* silence, so a constant-amplitude
  carrier is a hiss in every gap. Following the local RMS puts the mark at a
  fixed ratio to whatever is playing, and takes it to zero where nothing is.
* **Sized from the material** rather than fixed, because a fixed strength is
  wrong in both directions at once. The same in-band energy that hides the mark
  from a listener is the interference the detector has to beat, so the strength
  a signal needs is a property of that signal: measured across the cases in
  ``test_watermark.py``, a 440 Hz tone is detected at 6 sigma with a mark 46 dB
  below it, while 0.4 s of broadband noise needs 22 dB to reach the same
  confidence. A constant chosen for the noise would be audible on the tone; one
  chosen for the tone would be undetectable on the noise.
  :func:`watermark_strength` solves for the strength that reaches
  :data:`TARGET_STATISTIC` on *this* audio, and clamps it.

### The detector

Band-limit to the same band, divide by the envelope — undoing the shaping, so a
loud bar does not dominate the sum — and correlate against the carrier. The
statistic is normalised by the in-band degrees of freedom rather than by the
sample count, because band-limiting leaves only ``2·(HIGH-LOW)/SR`` of the
samples independent. That normalisation is what makes
:data:`DETECTION_THRESHOLD` a number with a meaning rather than a tuned
constant: under the null the statistic is standard normal, so 4.0 is a false
positive rate of about 3 in 100 000 per test. Measured over 200 unmarked
signals — white, tonal, pink and near-silent, 0.1 s to 5 s — the largest null
statistic was 2.46.

### The measured limit

There is one, and it is stated here rather than left to be discovered. Roughly
0.1 s of *loud broadband* material — full-scale white noise, the hardest case
there is — reaches about 4.2, which is at the threshold and slips just under it
through Ogg Vorbis. The mark is already capped at :data:`STRENGTH_RANGE`'s
ceiling before that point, so the shortfall is a choice rather than an
oversight: a tenth of a second of noise cannot carry a mark that is both
inaudible and certain, and inaudible is the half this product keeps. From 0.4 s
upward, and for tonal or sparse material at any length, the margin is
comfortable. ``test_watermark.py`` pins both the comfortable cases and this one.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Final

import numpy as np

from .audio_buffer import AudioBuffer, SAMPLE_DTYPE

__all__ = [
    "DETECTION_THRESHOLD",
    "ENVELOPE_BLOCK",
    "WATERMARK_BAND_HZ",
    "WATERMARK_KEYS",
    "WATERMARK_VERSION",
    "WatermarkDetection",
    "detect_watermark",
    "embed_watermark",
    "watermark_strength",
]

#: Which carrier a stored asset was marked with. Bumped if the scheme changes;
#: :data:`WATERMARK_KEYS` keeps the old ones so old audio stays detectable.
WATERMARK_VERSION: Final[int] = 1

#: Carrier seed per version. Not a secret in this repository — the product's
#: deployment overrides it — but the *shape* is the contract: one integer seed
#: per version, and versions are never removed.
WATERMARK_KEYS: Final[dict[int, int]] = {1: 0x4D53_5749}

#: Hz. Below the first figure and above the second, lossy codecs are free with
#: the bits. See the module docstring.
WATERMARK_BAND_HZ: Final[tuple[float, float]] = (1000.0, 6000.0)

#: Samples per RMS block for the shaping envelope. 1024 at 48 kHz is 21 ms —
#: short enough to follow a note's decay, long enough not to track the waveform
#: itself (which would make the "envelope" a copy of the signal).
ENVELOPE_BLOCK: Final[int] = 1024

#: The detection statistic :func:`watermark_strength` aims for. Three times
#: :data:`DETECTION_THRESHOLD`, which is the margin a lossy re-encode needs:
#: measured loss through MP3 and Ogg Vorbis is a few percent, and the headroom
#: is for the ones not measured — a chain of conversions, a loudness pass, a
#: trim to a fraction of the original.
TARGET_STATISTIC: Final[float] = 12.0

#: Mark amplitude as a fraction of the local RMS, clamped. The ceiling of 0.08
#: is 22 dB below the material and is reached only by broadband content, which
#: is also the best masker there is; the floor keeps sparse material — a single
#: sustained tone, which needs almost nothing — marked strongly enough that
#: dither and codec noise do not erase it.
STRENGTH_RANGE: Final[tuple[float, float]] = (0.004, 0.08)

#: Under the null the statistic is standard normal. See the module docstring.
DETECTION_THRESHOLD: Final[float] = 4.0

#: Envelope floor for the detector's division. Below this the block held no
#: signal, so there is nothing to recover and dividing by it would amplify
#: quantisation noise into the correlation.
_ENVELOPE_FLOOR: Final[float] = 1e-7


@dataclass(frozen=True)
class WatermarkDetection:
    """The answer to "does this audio carry our mark", and the evidence for it."""

    detected: bool
    #: Standard-normal under the null; see the module docstring.
    statistic: float
    #: The version whose carrier matched, or ``None`` when none did.
    version: int | None


def watermark_strength(audio: AudioBuffer) -> float:
    """The gentlest mark that still reaches :data:`TARGET_STATISTIC` on this audio.

    Solved rather than tuned. Whitening turns the received signal into
    ``host + s·carrier``, so the detector's statistic is, to the accuracy that
    matters here,

        ``s / whitened_in_band_rms · sqrt(dof)``

    — linear in ``s``, because the mark contributes ``s`` per whitened sample
    while the material contributes its own in-band energy as interference.
    Inverting that for the target gives the strength below, and both quantities
    in it are measured on the audio in hand.

    The interference is measured *after* the same whitening the detector
    applies, which is why this cannot be replaced by a simpler "in-band RMS":
    the detector divides by the envelope, so a passage that is loud in absolute
    terms but has the same in-band-to-total ratio interferes exactly as much as
    a quiet one.
    """
    if not audio.is_well_formed:
        return STRENGTH_RANGE[0]

    mono = _mono(audio)
    frames = mono.size
    whitened = _band_limit(mono, audio.sample_rate) / np.maximum(
        _envelope(mono), _ENVELOPE_FLOOR
    )
    interference = float(np.sqrt((whitened**2).mean()))
    gain = float(np.sqrt(_degrees_of_freedom(frames, audio.sample_rate)))
    if gain <= 0.0:
        return STRENGTH_RANGE[1]
    return float(np.clip(TARGET_STATISTIC * interference / gain, *STRENGTH_RANGE))


def _envelope(mono: np.ndarray) -> np.ndarray:
    """Short-term RMS, interpolated back to one value per sample.

    Interpolated rather than held per block, because a step in the shaping
    envelope is a step in the added signal, and a step is a click.
    """
    frames = mono.size
    padded = np.concatenate([mono, np.zeros((-frames) % ENVELOPE_BLOCK)])
    rms = np.sqrt((padded.reshape(-1, ENVELOPE_BLOCK) ** 2).mean(axis=1))
    centres = np.arange(rms.size) * ENVELOPE_BLOCK + ENVELOPE_BLOCK / 2
    return np.interp(np.arange(frames), centres, rms)


def _band_mask(frame_count: int, sample_rate: int) -> np.ndarray:
    low, high = WATERMARK_BAND_HZ
    freqs = np.fft.rfftfreq(frame_count, 1.0 / sample_rate)
    return (freqs >= low) & (freqs <= high)


def _band_limit(signal: np.ndarray, sample_rate: int) -> np.ndarray:
    spectrum = np.fft.rfft(signal)
    spectrum[~_band_mask(signal.size, sample_rate)] = 0.0
    return np.fft.irfft(spectrum, signal.size)


def _carrier(frame_count: int, sample_rate: int, version: int) -> np.ndarray:
    """Unit-RMS band-limited carrier for ``version``, deterministic in length.

    Deterministic because the detector regenerates it from the received length:
    the two sides share a seed and a length, and nothing else.
    """
    key = WATERMARK_KEYS[version]
    noise = np.random.default_rng(key).standard_normal(frame_count)
    band = _band_limit(noise, sample_rate)
    power = float((band**2).mean())
    if power <= 0.0:
        # Only reachable for a buffer too short to hold one in-band cycle.
        return np.zeros(frame_count)
    return band / np.sqrt(power)


def _mono(audio: AudioBuffer) -> np.ndarray:
    return np.mean(
        np.stack([channel.astype(np.float64) for channel in audio.channels]), axis=0
    )


def _degrees_of_freedom(frame_count: int, sample_rate: int) -> float:
    """Independent in-band samples — the correct divisor for the statistic.

    Using the sample count instead would inflate the statistic by the square
    root of the band's share of the spectrum, which is where a threshold stops
    meaning a false-positive rate and starts being a tuned number.
    """
    low, high = WATERMARK_BAND_HZ
    return max(2.0 * (high - low) / sample_rate * frame_count, 1.0)


def embed_watermark(
    audio: AudioBuffer, version: int = WATERMARK_VERSION
) -> AudioBuffer:
    """Add the inaudible mark to every channel (Requirement 16.6).

    The same carrier goes into each channel rather than an independent one per
    channel: a listener hears the difference between channels, not their common
    part, so a correlated addition stays centred and inaudible while an
    uncorrelated one widens the stereo image of the noise floor. It also means
    the detector's mono sum adds the mark coherently while summing the
    programme material's stereo difference away.
    """
    if not audio.is_well_formed:
        raise ValueError("cannot watermark a buffer that is not well formed")
    if version not in WATERMARK_KEYS:
        raise ValueError(f"unknown watermark version {version}")

    mono = _mono(audio)
    frames = mono.size
    shaped = (
        watermark_strength(audio)
        * _envelope(mono)
        * _carrier(frames, audio.sample_rate, version)
    )
    return AudioBuffer.from_channels(
        audio.sample_rate,
        [
            (channel.astype(np.float64) + shaped).astype(SAMPLE_DTYPE)
            for channel in audio.channels
        ],
    )


def watermark_statistic(audio: AudioBuffer, version: int) -> float:
    """The correlation statistic for one version. Standard normal under the null."""
    if not audio.is_well_formed:
        return 0.0
    mono = _mono(audio)
    frames = mono.size
    whitened = _band_limit(mono, audio.sample_rate) / np.maximum(
        _envelope(mono), _ENVELOPE_FLOOR
    )
    carrier = _carrier(frames, audio.sample_rate, version)
    denominator = np.sqrt(float(whitened @ whitened) * float(carrier @ carrier))
    if denominator <= 0.0:
        return 0.0
    correlation = float(whitened @ carrier) / denominator
    return correlation * float(np.sqrt(_degrees_of_freedom(frames, audio.sample_rate)))


def detect_watermark(audio: AudioBuffer) -> WatermarkDetection:
    """Requirement 16.6's other half: read the mark back.

    Every known version is tried and the strongest is reported, so audio marked
    by an older release stays identifiable after the scheme moves on. Reporting
    the strongest rather than the first match is what keeps that true when two
    versions' carriers happen to correlate a little.
    """
    best_version: int | None = None
    best_statistic = 0.0
    for version in sorted(WATERMARK_KEYS):
        statistic = watermark_statistic(audio, version)
        if best_version is None or statistic > best_statistic:
            best_version, best_statistic = version, statistic

    detected = best_statistic >= DETECTION_THRESHOLD
    return WatermarkDetection(
        detected=detected,
        statistic=best_statistic,
        version=best_version if detected else None,
    )
