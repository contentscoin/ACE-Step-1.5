"""Decoded PCM, in the one shape the DSP worker passes around (design §5.1).

This is the Python counterpart of ``musicstudio/domain/audio/pcm.ts`` and it is
deliberately the same shape rather than a convenient-for-NumPy one:

* **De-interleaved** — one 1-D array per channel, because every rule in
  Requirements 21, 22 and 30 that measures anything measures it per channel, and
  because ``PcmAudio`` on the TypeScript side is de-interleaved. A worker that
  reported interleaved frames would force every caller across the seam described
  in ``services/sound/measurement.ts`` to re-derive the strides.
* **``float32`` in nominal ``[-1, 1]``** — the 32-bit float internal
  representation design §5.1 fixes. 24-bit appears only on export
  (``formats.py``).
* **Nothing clamps.** An engine that returns an inter-sample overshoot must stay
  *measurable*; Requirement 21.8 compares against the channel's own peak, so an
  overshoot moves the reference instead of invalidating the check.

Interleaved arrays still exist at the edges, because ``libsndfile`` and
``libsoxr`` both speak interleaved ``(frames, channels)``. Those conversions are
confined to :func:`from_interleaved` and :func:`to_interleaved` so no other
module has to think about layout.

Pure data plus arithmetic over it — no file access, no resampling, no encoding.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Sequence

import numpy as np

__all__ = [
    "AudioBuffer",
    "MAX_CHANNELS",
    "from_interleaved",
    "to_interleaved",
    "window_sample_count",
]

#: Requirement 19.3 stores 1 (mono) or 2 (stereo) and nothing else.
MAX_CHANNELS = 2

SAMPLE_DTYPE = np.float32


@dataclass(frozen=True)
class AudioBuffer:
    """De-interleaved PCM at a known sample rate.

    Attributes mirror ``PcmAudio``: ``sample_rate`` plus one ``float32`` array
    per channel, all of the same length. Construct through
    :func:`from_interleaved` or :meth:`from_channels` rather than by hand, so
    the dtype and the equal-length rule are enforced in one place.
    """

    sample_rate: int
    channels: tuple[np.ndarray, ...]

    @classmethod
    def from_channels(
        cls, sample_rate: int, channels: Sequence[Sequence[float] | np.ndarray]
    ) -> "AudioBuffer":
        """Build a buffer, coercing every channel to a contiguous ``float32`` array."""
        coerced = tuple(
            np.ascontiguousarray(np.asarray(channel, dtype=SAMPLE_DTYPE).reshape(-1))
            for channel in channels
        )
        return cls(sample_rate=int(sample_rate), channels=coerced)

    @property
    def channel_count(self) -> int:
        return len(self.channels)

    @property
    def frame_count(self) -> int:
        """Samples per channel. Zero for a buffer with no channels."""
        if not self.channels:
            return 0
        return int(self.channels[0].size)

    @property
    def duration_ms(self) -> float:
        """Length in milliseconds, unrounded.

        Unrounded because the ±10 ms tolerance of Requirement 19.5 is checked
        against this value; rounding to whole milliseconds first would hide up
        to 0.5 ms of the very error under test.
        """
        if self.sample_rate <= 0:
            return 0.0
        return (self.frame_count * 1000.0) / self.sample_rate

    @property
    def is_well_formed(self) -> bool:
        """True when every channel is the same length and there is at least one sample."""
        frames = self.frame_count
        if frames < 1 or self.channel_count < 1:
            return False
        if not math.isfinite(self.sample_rate) or self.sample_rate <= 0:
            return False
        return all(channel.size == frames for channel in self.channels)


def window_sample_count(sample_rate: int, ms: float) -> int:
    """Samples in a window of ``ms`` at ``sample_rate``, at least 1.

    Rounded rather than truncated, so a 10 ms window at 44 100 Hz is 441 samples
    and not 440 — the same reasoning, and the same result, as
    ``windowSampleCount`` in ``domain/audio/pcm.ts``.

    The rounding is written out as ``floor(x + 0.5)`` instead of using
    :func:`round`, because Python's :func:`round` is banker's rounding while
    JavaScript's ``Math.round`` rounds halves upward. Those disagree on exactly
    the inputs a window calculation hits often: ``round(0.5)`` is 0 in Python
    and 1 in JavaScript, ``round(2.5)`` is 2 and 3. The two sides of the seam in
    ``services/sound/measurement.ts`` have to agree sample-for-sample, so the
    JavaScript behaviour is the one reproduced here.
    """
    return max(1, int(math.floor((sample_rate * ms) / 1000.0 + 0.5)))


def from_interleaved(interleaved: np.ndarray, sample_rate: int) -> AudioBuffer:
    """Split an interleaved ``(frames, channels)`` array into an :class:`AudioBuffer`.

    A 1-D array is read as single-channel, which is what both ``libsndfile`` and
    ``libsoxr`` hand back for mono.
    """
    array = np.asarray(interleaved, dtype=SAMPLE_DTYPE)
    if array.ndim == 1:
        array = array.reshape(-1, 1)
    if array.ndim != 2:
        raise ValueError(f"interleaved audio must be 1-D or 2-D, got {array.ndim}-D")
    return AudioBuffer.from_channels(
        sample_rate, [array[:, index] for index in range(array.shape[1])]
    )


def to_interleaved(audio: AudioBuffer) -> np.ndarray:
    """Stack an :class:`AudioBuffer` back into a ``(frames, channels)`` array.

    Always 2-D, even for mono, so callers never branch on channel count.
    """
    if not audio.channels:
        return np.zeros((0, 0), dtype=SAMPLE_DTYPE)
    frames = audio.frame_count
    if any(channel.size != frames for channel in audio.channels):
        raise ValueError("channels have unequal lengths; buffer is not well formed")
    return np.stack(audio.channels, axis=1).astype(SAMPLE_DTYPE, copy=False)
