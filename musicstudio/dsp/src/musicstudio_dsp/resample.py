"""Sample-rate normalisation to 48 kHz with ``libsoxr`` VHQ (design §5.2).

Requirement 19.4 stores every ``Audio_Asset`` at 48 000 Hz and Requirement 19.5
says what happens when an engine hands back something else: resample, **record
the original rate in the provenance**, and keep the stored length within ±10 ms
of the original. Requirement 13.10 then applies the same rate to every download.

Three consequences shape this module:

1. **The original rate is a return value, not a side effect.** Requirement 19.5
   requires it to be written to provenance by whoever stores the asset, so
   :func:`normalise_sample_rate` reports it in :class:`ResampleReport` rather
   than quietly discarding it. A resampler that returned only audio would make
   that clause unimplementable from the outside.

2. **The length error is measured, never assumed** — but it is worth knowing why
   the ±10 ms bound is met so comfortably. Resampling can only round the frame
   count, so the error is bounded by one period of the *output* rate: at 48 kHz
   that is 0.0208 ms, some 480 times inside the requirement. Measured worst case
   across rates from 8 kHz to 192 kHz and lengths from 1 ms to minutes is
   0.0104 ms. A consequence is that
   :func:`normalise_sample_rate_strict` cannot actually reject any input while
   the target is 48 kHz; the guard is there for a future change of target rate
   or resampler, which is exactly the change Requirement 19.5 would need to
   catch.

3. **Quality is fixed at VHQ**, per design §5.2. It is not a parameter of the
   pipeline entry point. Making it configurable would mean two assets stored by
   the same service could differ in resampling quality, and nothing in the
   requirements distinguishes them.

``libsoxr`` is deterministic for a given version, input, rate pair and quality,
which is what design §5.5's reproducibility rule needs from this stage.
"""

from __future__ import annotations

from dataclasses import dataclass

import soxr

from .audio_buffer import AudioBuffer, from_interleaved, to_interleaved

__all__ = [
    "INTERNAL_SAMPLE_RATE",
    "LENGTH_TOLERANCE_MS",
    "RESAMPLE_QUALITY",
    "LengthToleranceExceededError",
    "ResampleReport",
    "normalise_sample_rate",
    "normalise_sample_rate_strict",
    "resample",
]

#: Design §5.1, Requirements 19.4 and 13.10. Both ACE-Step and Woosh emit 48 kHz.
INTERNAL_SAMPLE_RATE = 48_000

#: Design §5.2: ``libsoxr`` "Very High Quality" band-limited resampling.
RESAMPLE_QUALITY = "VHQ"

#: Requirement 19.5: the stored length stays within ±10 ms of the original.
LENGTH_TOLERANCE_MS = 10.0


class LengthToleranceExceededError(ValueError):
    """Raised when resampling moved the length by more than ±10 ms.

    Requirement 19.5 states the tolerance as a condition on what is *stored*, so
    the failure has to stop the store rather than be logged and ignored. The
    message carries the measured error and the bound, in the shape the
    requirement's "위반된 제약과 허용값" wording asks for.
    """

    def __init__(self, error_ms: float, tolerance_ms: float = LENGTH_TOLERANCE_MS) -> None:
        super().__init__(
            f"resampled length differs by {error_ms:.4f} ms, which exceeds the "
            f"±{tolerance_ms:g} ms tolerance of Requirement 19.5"
        )
        self.error_ms = error_ms
        self.tolerance_ms = tolerance_ms


@dataclass(frozen=True)
class ResampleReport:
    """The result of normalising one buffer to the internal rate.

    ``original_sample_rate`` is what Requirement 19.5 wants recorded in
    provenance. ``resampled`` is false when the input was already at the
    internal rate, which lets a caller record "no resampling occurred" instead
    of an identity conversion — Requirement 19.5 only applies its clause to
    audio that was *not* already 48 kHz.
    """

    audio: AudioBuffer
    original_sample_rate: int
    original_duration_ms: float
    length_error_ms: float
    resampled: bool

    @property
    def within_tolerance(self) -> bool:
        return abs(self.length_error_ms) <= LENGTH_TOLERANCE_MS


def resample(audio: AudioBuffer, target_sample_rate: int) -> AudioBuffer:
    """Resample ``audio`` to ``target_sample_rate`` with ``libsoxr`` VHQ.

    Returns the input unchanged when it is already at the target rate: an
    identity pass through a band-limited resampler is not free, and it is not
    lossless either, so the no-op case must actually be a no-op for the
    losslessness that Requirement 13.3's conversions rely on.
    """
    if not audio.is_well_formed:
        raise ValueError("cannot resample a buffer that is not well formed")
    if target_sample_rate <= 0:
        raise ValueError(f"target sample rate must be positive, got {target_sample_rate}")
    if audio.sample_rate == target_sample_rate:
        return audio

    converted = from_interleaved(
        soxr.resample(
            to_interleaved(audio),
            audio.sample_rate,
            target_sample_rate,
            quality=RESAMPLE_QUALITY,
        ),
        target_sample_rate,
    )
    if converted.frame_count < 1:
        # Only reachable when the ratio is small enough that the whole input is
        # shorter than one output sample. Unreachable on the real path — the
        # target is always 48 kHz and Requirement 19.11 keeps inputs at 1 ms or
        # longer — but an empty buffer is not well formed, and returning one
        # would push a malformed value downstream where the cause is no longer
        # visible. Raised here, where the ratio that caused it is still in hand.
        raise ValueError(
            f"resampling {audio.frame_count} frame(s) from {audio.sample_rate} Hz to "
            f"{target_sample_rate} Hz yields no samples"
        )
    return converted


def normalise_sample_rate(
    audio: AudioBuffer, target_sample_rate: int = INTERNAL_SAMPLE_RATE
) -> ResampleReport:
    """Bring ``audio`` to the internal rate and report what that cost.

    Does not raise on a tolerance breach — it reports one. The caller decides
    whether a breach is fatal, because Requirement 19.5 constrains storing while
    an intermediate stage inside a longer chain may legitimately want to inspect
    the number first. :func:`normalise_sample_rate_strict` is the storing path.
    """
    original_rate = audio.sample_rate
    original_duration_ms = audio.duration_ms
    converted = resample(audio, target_sample_rate)
    return ResampleReport(
        audio=converted,
        original_sample_rate=original_rate,
        original_duration_ms=original_duration_ms,
        length_error_ms=converted.duration_ms - original_duration_ms,
        resampled=original_rate != target_sample_rate,
    )


def normalise_sample_rate_strict(
    audio: AudioBuffer, target_sample_rate: int = INTERNAL_SAMPLE_RATE
) -> ResampleReport:
    """:func:`normalise_sample_rate`, refusing a result outside ±10 ms.

    Used by the storing and download paths, where Requirement 19.5's tolerance
    is a precondition of writing the asset rather than a diagnostic.
    """
    report = normalise_sample_rate(audio, target_sample_rate)
    if not report.within_tolerance:
        raise LengthToleranceExceededError(report.length_error_ms)
    return report
