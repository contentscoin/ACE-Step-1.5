"""Mixdown_Renderer: sum the render target clips into one audio (design §6.1, §6.2).

Requirements 28.24–28.29. Three of them are invariants over *how* the sum is taken,
and they are what shapes this module:

* **28.26, commutativity.** Adding the same clips in a different order must give the
  same samples. Float addition is not associative, so "the same set" is not enough on
  its own — the clips are sorted by identifier before summation, which turns any input
  order into one summation order. Design §6.1 fixes the same rule.
* **28.27, reproducibility, across workers.** Nothing here draws on wall-clock time, a
  random source, or thread count. Accumulation is float64 and narrows to float32 once,
  at the end, so a partial sum's precision does not depend on how the work was divided.
  The remaining cross-worker risk is threaded BLAS reassociating a reduction, which is
  why the worker container pins ``OMP_NUM_THREADS=1`` (design §5.5, §14 risk #3); no
  operation below is one that BLAS would thread anyway.
* **28.25, length.** Derived from the render target clips only, so a muted clip past
  the end of everything else cannot stretch the result.

Track volume and pan are applied to a per-track accumulator rather than to each clip,
following design §6.1's step ordering. The two are algebraically equivalent — both are
linear and constant per track — but accumulating first means a track's setting is
applied once, at one precision, however many clips sit on it.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Iterable, Mapping, Sequence

import numpy as np

from .audio_buffer import AudioBuffer
from .mixdown_clip import (
    ACCUMULATOR_DTYPE,
    ClipRender,
    MixdownError,
    ms_to_frames,
    render_clip,
)

__all__ = [
    "MixdownResult",
    "PEAK_TARGET",
    "RenderParams",
    "TrackRender",
    "mixdown_frame_count",
    "render_mixdown",
]

#: Requirement 28.28 wants the normalised peak in [0.99, 1.0]. Sitting at 0.995 rather
#: than at either edge leaves room for the float32 narrowing at the end to move the
#: peak either way without leaving the interval.
PEAK_TARGET = 0.995


@dataclass(frozen=True)
class TrackRender:
    """A track's contribution settings. Mute and solo are not here — see below.

    Requirement 28.20's mute and 28.19's solo decide *membership* of the render target
    set, which `domain/timeline/render-target.ts` settles before anything reaches this
    module (task 4.1 owns that function and says so). A muted track therefore arrives as
    an absence of clips, not as a flag to re-check here.
    """

    volume_db: float = 0.0
    pan: float = 0.0


@dataclass(frozen=True)
class RenderParams:
    sample_rate: int = 48_000
    channels: int = 2
    #: Requirement 28.28's 피크 정규화 활성 여부, a render parameter under 28.27.
    peak_normalise: bool = True


@dataclass(frozen=True)
class MixdownResult:
    """The rendered audio plus what Requirements 28.24 and 28.28 must report."""

    audio: AudioBuffer
    #: 0.0 when the sum already fit (28.24); >0 when it was scaled down (28.28).
    attenuation_db: float
    #: Peak before normalisation, so a caller can see how close to clipping it came.
    peak_before: float

    @property
    def peak_after(self) -> float:
        return max((float(np.max(np.abs(c))) for c in self.audio.channels), default=0.0)


def mixdown_frame_count(clips: Iterable[ClipRender], sample_rate: int) -> int:
    """Requirement 28.25: 0 to the largest ``start_time_ms + 재생 길이``.

    Converted to frames once, from the summed milliseconds, rather than by adding a
    start in frames to a length in frames. The two disagree by up to a sample when both
    roundings go the same way, and this is the value 28.25's ±10 ms is measured against.
    """
    return max(
        (ms_to_frames(sample_rate, clip.start_time_ms + clip.play_duration_ms) for clip in clips),
        default=0,
    )


def render_mixdown(
    clips: Sequence[ClipRender],
    tracks: Mapping[int, TrackRender] | None = None,
    params: RenderParams | None = None,
) -> MixdownResult:
    """Render the target clips into a single audio starting at time 0.

    ``clips`` is the **render target set** — Requirements 28.19 and 28.20 have already
    been applied. ``tracks`` supplies settings for the track indices in use; an index
    with no entry renders at unity gain and centre pan.
    """
    settings = params or RenderParams()
    _validate_params(settings)

    # Requirement 28.29. Distinguished from "the project had clips but all were muted"
    # by the caller, which knows the exclusions; both land on the same reason code.
    if not clips:
        raise MixdownError("no_render_target")

    frames = mixdown_frame_count(clips, settings.sample_rate)
    if frames < 1:
        raise MixdownError("no_render_target", actual="0 frames")

    accumulators = _accumulate_tracks(clips, frames, settings)
    output = _sum_tracks(accumulators, tracks or {}, frames, settings)
    return _normalise_peak(output, settings)


def _validate_params(params: RenderParams) -> None:
    if params.sample_rate <= 0:
        raise MixdownError("sample_rate_invalid", actual=str(params.sample_rate))
    if params.channels < 1 or params.channels > 2:
        # Requirement 19.3 stores 1 or 2 and nothing else.
        raise MixdownError("channel_count_invalid", actual=str(params.channels))


def _accumulate_tracks(
    clips: Sequence[ClipRender], frames: int, params: RenderParams
) -> dict[int, np.ndarray]:
    """One buffer per track that has clips, each clip placed at its start time.

    Sorted by ``clip_id`` — this is Requirement 28.26's commutativity, and it is the
    only place the input order is allowed to matter. Only tracks actually carrying a
    clip are allocated: a project may declare 32 tracks (Requirement 28.11) while using
    two, and 30 buffers of silence would cost the length of the mix apiece.
    """
    accumulators: dict[int, np.ndarray] = {}

    for clip in sorted(clips, key=lambda item: item.clip_id):
        samples = render_clip(clip, params.sample_rate, params.channels)
        start = ms_to_frames(params.sample_rate, clip.start_time_ms)
        if start >= frames:
            continue
        width = min(samples.shape[1], frames - start)
        if width < 1:
            continue

        buffer = accumulators.get(clip.track)
        if buffer is None:
            buffer = np.zeros((params.channels, frames), dtype=ACCUMULATOR_DTYPE)
            accumulators[clip.track] = buffer
        buffer[:, start : start + width] += samples[:, :width]

    return accumulators


def _sum_tracks(
    accumulators: Mapping[int, np.ndarray],
    tracks: Mapping[int, TrackRender],
    frames: int,
    params: RenderParams,
) -> np.ndarray:
    """Apply each track's volume and pan, then add the tracks in track-index order."""
    output = np.zeros((params.channels, frames), dtype=ACCUMULATOR_DTYPE)

    for index in sorted(accumulators):
        buffer = accumulators[index]
        setting = tracks.get(index, TrackRender())
        if setting.volume_db != 0.0:
            buffer = buffer * (10.0 ** (setting.volume_db / 20.0))
        buffer = _apply_pan(buffer, setting.pan, params.channels)
        output += buffer

    return output


def _apply_pan(buffer: np.ndarray, pan: float, channels: int) -> np.ndarray:
    """Constant-power pan, normalised so that centre is exactly unity.

    No requirement fixes a pan law — Requirement 28.18 only bounds the control to
    [-1.0, +1.0] — so the law is a product decision, recorded here:

    * **Constant power.** ``left² + right²`` is invariant across the sweep, so a source
      does not appear to dip in loudness as it crosses the middle, which is what a
      linear law does.
    * **Unity at centre**, via the ``√2``. The textbook constant-power law puts centre
      at −3 dB, which would mean the default project — every track at ``pan = 0``, the
      control never touched — renders 3 dB below the sum of its clips. Normalising makes
      an untouched pan control exactly an identity, and moves the +3 dB to the hard-panned
      extremes where it is asked for.

    For a mono mixdown pan has nothing to act on and is ignored; folding it in would
    turn a pan into a volume change, which is not what the control means.
    """
    if channels < 2 or pan == 0.0:
        return buffer

    angle = (max(-1.0, min(1.0, pan)) + 1.0) * (math.pi / 4.0)
    gains = np.array(
        [math.sqrt(2.0) * math.cos(angle), math.sqrt(2.0) * math.sin(angle)],
        dtype=ACCUMULATOR_DTYPE,
    )
    return buffer * gains[:, np.newaxis]


def _normalise_peak(output: np.ndarray, params: RenderParams) -> MixdownResult:
    """Requirements 28.24 and 28.28: leave it alone, or scale it by one factor.

    One factor for every sample and every channel, which is what 28.28 says and also
    what keeps the mix's balance: a per-channel factor would move the stereo image.

    The reported attenuation can exceed 28.28's 40 dB ceiling, and is reported honestly
    when it does. That needs a peak above ~99.5, which takes hundreds of clips summing
    in phase. Given the choice between a sample that overflows on export and a reported
    number outside its stated band, the export wins — a caller can see the value and
    reject, but it cannot recover clipped audio.
    """
    peak = float(np.max(np.abs(output))) if output.size else 0.0

    if not params.peak_normalise or peak <= 1.0:
        # Requirement 28.24: samples unchanged, attenuation recorded as 0 dB.
        return MixdownResult(
            audio=_to_buffer(output, params.sample_rate),
            attenuation_db=0.0,
            peak_before=peak,
        )

    factor = PEAK_TARGET / peak
    output = output * factor
    return MixdownResult(
        audio=_to_buffer(output, params.sample_rate),
        attenuation_db=-20.0 * math.log10(factor),
        peak_before=peak,
    )


def _to_buffer(output: np.ndarray, sample_rate: int) -> AudioBuffer:
    """Narrow to the float32 of design §5.1, once, after all arithmetic."""
    return AudioBuffer.from_channels(sample_rate, [output[index] for index in range(output.shape[0])])
