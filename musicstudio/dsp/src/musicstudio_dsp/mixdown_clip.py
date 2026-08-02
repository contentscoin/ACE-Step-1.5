"""One clip's journey from stored asset to a placed signal (design §5.6, §6.1).

The chain is fixed and its order is a requirement, not a preference:

    trim → effects → truncate → gain → fades → channel conform

Trim precedes effects because Requirement 28.13 defines the clip's play length from
the trim values alone; an effect applied to the untrimmed asset would develop reverb
and delay out of material the clip does not play. Truncate follows effects because a
delay or reverb tail extends past the input (``effects.apply_chain`` allows it to, for
Requirement 29.32), and design §6.3 cuts that tail at the clip's play length before it
reaches the mix. Gain precedes fades so that a fade always ends at true silence rather
than at the clip's gain floor.

Everything here is a pure function of the clip and its decoded audio. No storage, no
resampling: an asset is stored at 48 kHz (design §5.2), so a clip arriving at another
rate is a storage bug and is refused rather than silently corrected, which would make
the reproducibility of Requirement 28.27 depend on which resampler version ran.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Mapping, Sequence

import numpy as np

from .audio_buffer import AudioBuffer
from .effects import apply_chain

__all__ = [
    "ClipRender",
    "MixdownError",
    "ms_to_frames",
    "render_clip",
]

#: Accumulation dtype. Design §6.1 sums in float64 and narrows once, at the end.
ACCUMULATOR_DTYPE = np.float64


class MixdownError(ValueError):
    """A mixdown that cannot be rendered, carrying the reason code the API returns.

    Requirement 28.29 answers a render with no target clips with a "렌더링 대상 부재
    사유 코드", so the reason travels as data rather than as prose in a message.
    """

    def __init__(self, reason: str, **detail: str) -> None:
        super().__init__(reason if not detail else f"{reason} ({detail})")
        self.reason = reason
        self.detail = detail


@dataclass(frozen=True)
class ClipRender:
    """A render target clip: its decoded source audio plus the clip's own settings.

    ``audio`` is the **whole** referenced asset, untrimmed — the trim values are applied
    here, so that the caller does not have to decide what "the clip's audio" means and
    then disagree with Requirement 28.13 about it.

    ``effect_chain`` is empty for task 4.2. Requirement 28.27 names 클립별 Effect_Chain
    among the render parameters, so the step exists and is exercised; wiring a stored
    chain onto ``Timeline_Clip`` is task 4.3's (Requirements 29.31, 29.32).
    """

    clip_id: str
    audio: AudioBuffer
    start_time_ms: int
    track: int
    trim_start_ms: int = 0
    trim_end_ms: int = 0
    gain_db: float = 0.0
    fade_in_ms: int = 0
    fade_out_ms: int = 0
    effect_chain: Sequence[Mapping[str, Any]] = field(default_factory=tuple)

    @property
    def source_duration_ms(self) -> float:
        return self.audio.duration_ms

    @property
    def play_duration_ms(self) -> float:
        """Requirement 28.13: ``원본 자산 길이 - trim_start_ms - trim_end_ms``."""
        return self.source_duration_ms - self.trim_start_ms - self.trim_end_ms


def ms_to_frames(sample_rate: int, ms: float) -> int:
    """Frames in ``ms`` at ``sample_rate``, rounded half up, never negative.

    Separate from :func:`audio_buffer.window_sample_count`, which clamps to at least 1
    because a measurement window of zero samples is meaningless. A *position* of zero
    frames is not: a clip at ``start_time_ms = 0`` starts at frame 0, and a zero-length
    fade is a clip with no fade. Sharing the clamped helper would silently shift every
    such clip by one sample.

    Rounded as ``floor(x + 0.5)`` for the reason given in ``window_sample_count``:
    Python's :func:`round` is banker's rounding and JavaScript's ``Math.round`` is not,
    and the two sides of this seam have to agree frame for frame.
    """
    if sample_rate <= 0:
        return 0
    return max(0, int(math.floor((sample_rate * ms) / 1000.0 + 0.5)))


def render_clip(clip: ClipRender, sample_rate: int, channels: int) -> np.ndarray:
    """Run one clip through the chain, returning ``(channels, frames)`` in float64.

    The result is the signal to be placed at ``clip.start_time_ms``; placement itself is
    the caller's, because only the caller knows the mixdown's length.
    """
    if clip.audio.sample_rate != sample_rate:
        raise MixdownError(
            "clip_sample_rate_mismatch",
            clip_id=clip.clip_id,
            actual=str(clip.audio.sample_rate),
            expected=str(sample_rate),
        )
    if not clip.audio.is_well_formed:
        raise MixdownError("clip_audio_malformed", clip_id=clip.clip_id)

    play_frames = ms_to_frames(sample_rate, clip.play_duration_ms)
    if play_frames < 1:
        raise MixdownError(
            "clip_play_length_empty",
            clip_id=clip.clip_id,
            actual=f"{clip.play_duration_ms:.3f}ms",
        )

    trimmed = _trim(clip, sample_rate)
    processed = apply_chain(trimmed, clip.effect_chain).audio if clip.effect_chain else trimmed

    # Design §6.3: whatever the chain produced, the mix sees the clip's play length.
    samples = _to_matrix(processed, play_frames)
    samples = _conform_channels(samples, channels)
    samples *= 10.0 ** (clip.gain_db / 20.0)
    _apply_fades(samples, clip, sample_rate)
    return samples


def _trim(clip: ClipRender, sample_rate: int) -> AudioBuffer:
    """Slice ``[trim_start_ms, source − trim_end_ms)`` out of the asset.

    Both ends are converted from milliseconds independently and the *end* is derived
    from the buffer's own frame count, not from ``start + play_duration``. Deriving it
    from the sum would let two roundings compound into a one-sample drift that
    Requirement 28.25's ±10 ms would never catch but Requirement 28.26's 0.0001 would.
    """
    total = clip.audio.frame_count
    start = min(ms_to_frames(sample_rate, clip.trim_start_ms), total)
    end = max(start, total - ms_to_frames(sample_rate, clip.trim_end_ms))
    if start == 0 and end == total:
        return clip.audio
    return AudioBuffer.from_channels(
        sample_rate, [channel[start:end] for channel in clip.audio.channels]
    )


def _to_matrix(audio: AudioBuffer, frames: int) -> np.ndarray:
    """Stack to ``(channels, frames)`` float64, cutting or zero-padding to ``frames``."""
    matrix = np.zeros((audio.channel_count, frames), dtype=ACCUMULATOR_DTYPE)
    usable = min(frames, audio.frame_count)
    for index, channel in enumerate(audio.channels):
        matrix[index, :usable] = channel[:usable]
    return matrix


def _conform_channels(samples: np.ndarray, channels: int) -> np.ndarray:
    """Fit a clip's channel count to the mixdown's.

    Mono spreads to every output channel; a wider source folds down by averaging. Both
    are the conventional answers, and both are stated here rather than left to the
    summation so that a mono and a stereo clip on the same track contribute at
    comparable level instead of the mono one arriving 3 dB quieter on one side.
    """
    have = samples.shape[0]
    if have == channels:
        return samples
    if have == 1:
        return np.repeat(samples, channels, axis=0)
    if channels == 1:
        return samples.mean(axis=0, keepdims=True)
    fitted = np.zeros((channels, samples.shape[1]), dtype=ACCUMULATOR_DTYPE)
    for index in range(channels):
        fitted[index] = samples[min(index, have - 1)]
    return fitted


def _apply_fades(samples: np.ndarray, clip: ClipRender, sample_rate: int) -> None:
    """Requirement 28.16's linear fades, in place.

    Linear in amplitude, as design §5.6 specifies for the crossfade it shares this shape
    with. The ramps are built with :func:`numpy.linspace` over a fixed count, so the
    same clip yields the same ramp on any worker — Requirement 28.27.

    A fade longer than the clip is clamped to the clip. Requirement 28.17 already caps
    each fade at half the play length, so the clamp is unreachable through the service;
    it exists so that this function has an answer for every input rather than producing
    a silently mis-shaped ramp for one it was not supposed to receive.
    """
    frames = samples.shape[1]
    fade_in = min(ms_to_frames(sample_rate, clip.fade_in_ms), frames)
    fade_out = min(ms_to_frames(sample_rate, clip.fade_out_ms), frames)

    if fade_in > 1:
        samples[:, :fade_in] *= np.linspace(
            0.0, 1.0, fade_in, endpoint=False, dtype=ACCUMULATOR_DTYPE
        )
    elif fade_in == 1:
        samples[:, 0] = 0.0

    # `endpoint` differs between the two ramps on purpose. The fade in excludes its
    # endpoint so that full gain lands on the first sample *after* the ramp, with no
    # value repeated; the fade out includes it so that the clip's last sample is
    # exactly silent, which is the property the chain order was chosen to give.
    if fade_out > 1:
        samples[:, frames - fade_out :] *= np.linspace(
            1.0, 0.0, fade_out, endpoint=True, dtype=ACCUMULATOR_DTYPE
        )
    elif fade_out == 1:
        samples[:, frames - 1] = 0.0
