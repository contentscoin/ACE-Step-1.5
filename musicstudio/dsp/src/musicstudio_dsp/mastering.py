"""Loudness normalisation, dialogue cleanup and auto-ducking (Requirements 30.6–30.18).

Plain callables, like :mod:`musicstudio_dsp.loudness` and :mod:`musicstudio_dsp.effects`.
:mod:`musicstudio_dsp.worker`'s task shells are three lines each and delegate here,
because **no broker is reachable from a test environment** and behaviour that lives in a
task body can only be tested by standing up Redis or by pretending.

### Determinism (Requirement 30.18)

"동일한 입력 오디오와 동일한 처리 파라미터로 마스터링 처리가 2회 이상 요청되면 … 매 회
샘플 단위로 동일한 오디오를 산출한다". Nothing here draws from an RNG, reads a clock or
keeps state between calls; every function is a pure transform of its arguments. The
NumPy work is elementwise (multiplies, slices, cumulative sums), and elementwise
operations are not parallelised or reassociated by any BLAS backend — so the property is
thread-count independent by construction rather than by configuration, exactly as
:mod:`musicstudio_dsp.effects` argues for Requirement 29.29. ``test_mastering.py``
asserts it under whatever thread count the test process happens to have.

### The numbers come from the shared registry, never from literals here

``mastering_registry.json`` mirrors ``domain/mastering/bounds.ts`` and the initial values
of the Quality_Threshold_Set. Every threshold-derived argument below has a default of
``None`` that resolves to the registry, and the product layer overrides it per call with
the set in force — because Requirement 34.4 lets an operator change a threshold between
two runs, and a worker pinned to the checked-in initial value would put the judgement and
the processing on different numbers.

### Why normalisation is a single gain and not a limiter

Requirement 30.6 asks for the integrated loudness to land within ±0.5 LUFS of the target
and Requirement 30.7 requires the true peak to stay at or below −1.0 dBTP **in
preference** to reaching the target. A single broadband gain satisfies both readings
exactly:

* Integrated loudness is scale-equivariant — scaling by ``g`` moves it by
  ``20·log10(g)`` — because the K-weighting filter is linear and both gates are defined
  relative to the signal's own mean. So the gain needed is *computed*, not searched for.
* True peak is likewise scale-equivariant, so the largest admissible gain is
  ``ceiling − current_peak`` and the applied gain is the smaller of the two.

A limiter or compressor would reach the target *and* the ceiling together, and would be
the better-sounding choice — but it is not scale-equivariant, so re-applying it would
change the audio again, and Requirement 30.8's idempotence (Property 15) would fail. The
requirement asks for idempotence, so the implementation is the one that has it. This is
worth stating plainly because it is a real product trade-off, not an oversight: audio
whose peaks force the ceiling to bind will be quieter than its target, and Requirement
30.25 exists precisely to report that rather than to hide it.

**Why idempotence is exact rather than approximate.** The second application's computed
gain is ``target − loudness(g·x)`` = ``target − (loudness(x) + 20·log10(g))`` = 0, up to
the ``float32`` rounding of the samples themselves. So the ≤0.1 dB bound of Requirement
30.8 is met with a large margin rather than just met, and Property 15 passes for reasons
rather than by tuning.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Sequence

import numpy as np

from .audio_buffer import AudioBuffer, SAMPLE_DTYPE, window_sample_count
from .loudness import (
    MeasurementReport,
    integrated_loudness_lufs,
    measure,
    registry,
    rms_db,
)

__all__ = [
    "CleanupResult",
    "DuckingResult",
    "NormalisationResult",
    "SpeechRegion",
    "apply_gain_db",
    "clean_dialogue",
    "detect_speech_regions",
    "duck",
    "ducking_envelope",
    "normalise_loudness",
    "speech_loudness_lufs",
]


def apply_gain_db(audio: AudioBuffer, gain_db: float) -> AudioBuffer:
    """Scale every channel by ``gain_db``.

    No clamping and no dithering. Clamping would silently break the scale-equivariance
    the idempotence argument rests on, and dithering would draw from an RNG, which
    Requirement 30.18 forbids. Design §5.1 keeps the internal representation at 32-bit
    float precisely so that headroom is available; the 24-bit conversion happens on
    export (:mod:`musicstudio_dsp.formats`).
    """
    if gain_db == 0.0:
        return audio
    factor = np.float32(10.0 ** (gain_db / 20.0))
    return AudioBuffer.from_channels(
        audio.sample_rate, [channel * factor for channel in audio.channels]
    )


@dataclass(frozen=True)
class NormalisationResult:
    """Requirements 30.6, 30.7, 30.8, 30.25.

    Mirrors ``NormaliseLoudnessResult`` in ``services/mastering/ports.ts`` field for
    field, so nothing has to be reshaped at the seam.
    """

    audio: AudioBuffer
    before: MeasurementReport
    after: MeasurementReport
    #: The gain actually applied, in dB. **This is the quantity Property 15 bounds.**
    applied_gain_db: float
    #: The gain the target alone would have asked for, before the ceiling was considered.
    requested_gain_db: float
    #: Requirement 30.7: True when the true-peak ceiling reduced the gain.
    true_peak_limited: bool
    #: Requirement 30.25: True when the target was not reached as a result.
    target_missed: bool
    #: Requirement 30.6's precondition: was there a block above the −70 LUFS gate?
    measurable: bool
    #: The target the gain was computed against, echoed so the shortfall is derivable.
    target_lufs: float

    @property
    def shortfall_lufs(self) -> float:
        """Requirement 30.25: 목표값 대비 미달량. Zero when the target was reached."""
        if not self.target_missed:
            return 0.0
        return self.target_lufs - self.after.integrated_loudness_lufs


def normalise_loudness(
    audio: AudioBuffer,
    target_lufs: float | None = None,
    *,
    target_tolerance_lufs: float | None = None,
    true_peak_ceiling_dbtp: float | None = None,
) -> NormalisationResult:
    """Requirements 30.6, 30.7, 30.8, 30.25: normalise to ``target_lufs``.

    The gain is computed in one step, for the reasons the module docstring gives, and
    then clamped by the headroom the true-peak ceiling leaves:

    ``applied = min(target − loudness, ceiling − true_peak)``

    ``min`` and not ``max``: Requirement 30.7 gives the ceiling priority, so a signal
    with only 2 dB of true-peak headroom that wants 6 dB gets 2 dB and
    ``target_missed`` set. Note that the clamp is one-sided in effect only when the
    target asks the signal *up*; a target that asks it down is always achievable, and the
    ``min`` returns the negative target gain because the ceiling term is then the larger.

    A signal with **no** measurable loudness is returned untouched with
    ``measurable=False`` — Requirement 30.6 conditions the whole operation on there
    being a gating block above −70 LUFS, and applying 60 dB of gain to a noise floor is
    the one behaviour that clause exists to prevent.
    """
    reg = registry()
    target = reg.loudness_target_default_lufs if target_lufs is None else float(target_lufs)
    tolerance = (
        reg.threshold("loudness_normalization_target_tolerance_lufs")
        if target_tolerance_lufs is None
        else float(target_tolerance_lufs)
    )
    ceiling = (
        reg.true_peak_ceiling_dbtp
        if true_peak_ceiling_dbtp is None
        else float(true_peak_ceiling_dbtp)
    )

    before = measure(audio)
    loudness = before.integrated_loudness_lufs
    peak = before.true_peak_dbtp

    if not math.isfinite(loudness):
        return NormalisationResult(
            audio=audio,
            before=before,
            after=before,
            applied_gain_db=0.0,
            requested_gain_db=0.0,
            true_peak_limited=False,
            target_missed=True,
            measurable=False,
            target_lufs=target,
        )

    requested_gain_db = target - loudness
    # A true peak of -inf means the buffer is all zeros, which the loudness check above
    # has already excluded; the guard keeps the arithmetic total regardless.
    headroom_db = math.inf if not math.isfinite(peak) else ceiling - peak
    applied_gain_db = min(requested_gain_db, headroom_db)
    true_peak_limited = applied_gain_db < requested_gain_db

    result_audio = apply_gain_db(audio, applied_gain_db)
    after = measure(result_audio)
    target_missed = (
        not math.isfinite(after.integrated_loudness_lufs)
        or abs(target - after.integrated_loudness_lufs) > tolerance
    )

    return NormalisationResult(
        audio=result_audio,
        before=before,
        after=after,
        applied_gain_db=applied_gain_db,
        requested_gain_db=requested_gain_db,
        true_peak_limited=true_peak_limited,
        target_missed=target_missed,
        measurable=True,
        target_lufs=target,
    )


@dataclass(frozen=True)
class SpeechRegion:
    """A region judged to hold speech (Requirement 30.12). Half-open ``[start_ms, end_ms)``.

    Mirrors ``SpeechRegion`` in ``domain/mastering/ducking.ts``.
    """

    start_ms: float
    end_ms: float

    @property
    def duration_ms(self) -> float:
        return max(0.0, self.end_ms - self.start_ms)

    def as_dict(self) -> dict[str, float]:
        return {"startMs": self.start_ms, "endMs": self.end_ms}


def detect_speech_regions(
    audio: AudioBuffer,
    *,
    rms_threshold_db: float | None = None,
    min_duration_ms: float | None = None,
    window_ms: float | None = None,
) -> tuple[SpeechRegion, ...]:
    """Requirement 30.12: 100 ms window RMS ≥ −45 dB, sustained for ≥ 200 ms.

    Read exactly as written, in three steps:

    1. Cut the audio into **non-overlapping** ``window_ms`` windows and take each one's
       RMS across all channels together. Non-overlapping because the clause says "100
       밀리초 창의 RMS 레벨" and a run of overlapping windows would count the same
       samples several times, making the sustained-duration test depend on the hop size
       — a number the requirement does not give.
    2. Mark each window as speech-bearing when its RMS is **at or above** the threshold.
       "이상" is inclusive, so the comparison is ``>=``.
    3. Keep maximal runs of marked windows whose total length is at least
       ``min_duration_ms``. "200밀리초 이상 연속 구간" — the *run* must reach the
       duration, not each window.

    Channels are summed into one RMS rather than judged separately: a line of dialogue
    panned to one side is still speech, and a per-channel rule would report two
    overlapping region sets that the ducking envelope would then have to reconcile.

    The window count is derived with :func:`window_sample_count`, which reproduces
    JavaScript's round-half-up — so a window at an odd sample rate is the same number of
    samples here as in the TypeScript layer.

    A trailing partial window is judged on the samples it actually has. Dropping it would
    make the last up-to-100 ms of every asset unclassifiable, and a line of speech that
    ends at the very end of the file is the common case for a dialogue asset.
    """
    reg = registry()
    threshold_db = (
        reg.threshold("speech_detection_rms_threshold_db")
        if rms_threshold_db is None
        else float(rms_threshold_db)
    )
    minimum_ms = (
        reg.threshold("speech_detection_min_duration_ms")
        if min_duration_ms is None
        else float(min_duration_ms)
    )
    window = reg.speech_window_ms if window_ms is None else float(window_ms)

    if not audio.is_well_formed:
        return ()

    window_frames = window_sample_count(audio.sample_rate, window)
    frames = audio.frame_count
    stacked = np.stack([channel.astype(np.float64) for channel in audio.channels], axis=0)

    marked: list[tuple[float, float, bool]] = []
    for start in range(0, frames, window_frames):
        stop = min(start + window_frames, frames)
        level = rms_db(stacked[:, start:stop])
        marked.append(
            (
                start * 1000.0 / audio.sample_rate,
                stop * 1000.0 / audio.sample_rate,
                level >= threshold_db,
            )
        )

    regions: list[SpeechRegion] = []
    run_start: float | None = None
    run_end = 0.0
    for start_ms, end_ms, is_speech in marked:
        if is_speech:
            if run_start is None:
                run_start = start_ms
            run_end = end_ms
            continue
        if run_start is not None:
            if run_end - run_start >= minimum_ms:
                regions.append(SpeechRegion(run_start, run_end))
            run_start = None
    if run_start is not None and run_end - run_start >= minimum_ms:
        regions.append(SpeechRegion(run_start, run_end))

    return tuple(regions)


def _region_mask(audio: AudioBuffer, regions: Sequence[SpeechRegion]) -> np.ndarray:
    """A per-frame boolean mask, True inside any region.

    Frame boundaries are derived from the region times with the same rounding
    :func:`detect_speech_regions` used to produce them, so a mask built from a region set
    covers exactly the windows that produced it.
    """
    mask = np.zeros(audio.frame_count, dtype=bool)
    for region in regions:
        start = max(0, int(round(region.start_ms * audio.sample_rate / 1000.0)))
        stop = min(audio.frame_count, int(round(region.end_ms * audio.sample_rate / 1000.0)))
        if stop > start:
            mask[start:stop] = True
    return mask


def speech_loudness_lufs(audio: AudioBuffer, regions: Sequence[SpeechRegion]) -> float:
    """Integrated loudness of the speech sections alone (Requirement 30.9).

    The speech frames are **concatenated** and measured as one buffer, rather than each
    region being measured and the results averaged. Two reasons, and both matter for the
    ±1.0 LUFS criterion:

    * Integrated loudness is not linear in its input, so the mean of per-region
      loudnesses is not the loudness of the speech. Averaging would give a number that
      moved when the region *boundaries* moved even though no sample changed.
    * BS.1770-4's relative gate is defined over the whole measured signal. Applied per
      region it would gate each region against itself, so a quiet line and a loud line
      would both come out near the middle of their own range.

    Concatenation introduces discontinuities at the joins, which the K-weighting filter
    sees as transients. They are the same joins before and after cleanup — cleanup does
    not move a region boundary — so the *difference* Requirement 30.9 bounds is unaffected
    even though the absolute number is very slightly raised.

    ``-inf`` when there is no speech, which is the honest answer and which the caller
    must handle: Requirement 30.9's ±1.0 LUFS comparison is vacuous for audio with no
    speech in it.
    """
    if not audio.is_well_formed or not regions:
        return -math.inf
    mask = _region_mask(audio, regions)
    if not bool(mask.any()):
        return -math.inf
    return integrated_loudness_lufs(
        AudioBuffer.from_channels(
            audio.sample_rate, [channel[mask] for channel in audio.channels]
        )
    )


@dataclass(frozen=True)
class CleanupResult:
    """Requirements 30.9, 30.10. Mirrors ``DialogueCleanupResultDsp``."""

    audio: AudioBuffer
    speech_regions: tuple[SpeechRegion, ...]
    non_speech_rms_before_db: float
    non_speech_rms_after_db: float
    speech_loudness_before_lufs: float
    speech_loudness_after_lufs: float
    input_duration_ms: float
    output_duration_ms: float
    #: The envelope floor the solver settled on, in dB. Reported for audit, not for a check.
    applied_floor_db: float
    #: False when the audio is speech end to end, which makes 30.9's first clause vacuous.
    has_non_speech: bool

    @property
    def non_speech_attenuation_db(self) -> float:
        """Requirement 30.9: how far the non-speech level came down. Positive is down."""
        return self.non_speech_rms_before_db - self.non_speech_rms_after_db

    @property
    def speech_loudness_delta_lufs(self) -> float:
        return self.speech_loudness_after_lufs - self.speech_loudness_before_lufs

    @property
    def length_error_ms(self) -> float:
        return abs(self.output_duration_ms - self.input_duration_ms)


def clean_dialogue(
    audio: AudioBuffer,
    *,
    rms_threshold_db: float | None = None,
    min_duration_ms: float | None = None,
    attenuation_db: float | None = None,
    transition_ms: float = 20.0,
) -> CleanupResult:
    """Requirements 30.9, 30.10: attenuate everything that is not speech.

    A **gain envelope multiplied into the signal**, never a cut. That is what makes
    Requirement 30.10's ±10 ms length preservation exact rather than within tolerance: no
    samples are added or removed, so the output has precisely as many frames as the input
    and the error is 0 ms. An implementation that deleted the non-speech sections would be
    the obvious reading of "정리" and would breach 30.10 on every input.

    ### The floor is solved for, not assumed

    ``attenuation_db`` is the reduction the *measurement* must show. Every non-speech frame
    receives the full floor (see :func:`_cleanup_shape` on why the ramps sit inside each
    speech region rather than outside it), so the floor and the achieved reduction are the
    same number in exact arithmetic — but not once the output samples are stored as
    ``float32``. That rounding left the measured reduction a couple of nanodecibels short
    of the requested 10 dB, which the strict ``<`` comparison in
    ``services/mastering/mastering-assistant.ts`` reads as a failure.

    So :func:`_solve_floor_db` bisects for the floor whose **quantised** output meets the
    requirement, keeping the invariant that its lower bound always satisfies it and
    returning that bound. The guarantee is therefore structural rather than a margin
    someone tuned, and the achieved attenuation is ``≥`` the requested value by
    construction rather than to within a tolerance.

    The ramps exist so the envelope does not step discontinuously, which would produce an
    audible click at every region edge and would put broadband energy into the speech
    sections — moving the very loudness Requirement 30.9 requires held within ±1.0 LUFS.

    Requirement 30.11's "음성 향상" is a separate operation and is not this: cleanup only
    reduces what is not speech, and never boosts the speech itself.
    """
    reg = registry()
    attenuation = (
        reg.threshold("dialogue_cleanup_non_speech_attenuation_min_db")
        if attenuation_db is None
        else float(attenuation_db)
    )

    regions = detect_speech_regions(
        audio, rms_threshold_db=rms_threshold_db, min_duration_ms=min_duration_ms
    )
    mask = _region_mask(audio, regions)
    input_duration_ms = audio.duration_ms
    has_non_speech = bool((~mask).any())

    stacked_before = np.stack([channel.astype(np.float64) for channel in audio.channels], axis=0)
    non_speech_before_db = rms_db(stacked_before[:, ~mask]) if has_non_speech else -math.inf
    speech_before_lufs = speech_loudness_lufs(audio, regions)

    shape = _cleanup_shape(audio, mask, transition_ms)
    floor_db = _solve_floor_db(audio, shape, mask, attenuation)
    cleaned = _apply_cleanup_envelope(audio, shape, floor_db)

    stacked_after = np.stack([channel.astype(np.float64) for channel in cleaned.channels], axis=0)
    non_speech_after_db = rms_db(stacked_after[:, ~mask]) if has_non_speech else -math.inf

    return CleanupResult(
        audio=cleaned,
        speech_regions=regions,
        non_speech_rms_before_db=non_speech_before_db,
        non_speech_rms_after_db=non_speech_after_db,
        speech_loudness_before_lufs=speech_before_lufs,
        speech_loudness_after_lufs=speech_loudness_lufs(cleaned, regions),
        input_duration_ms=input_duration_ms,
        output_duration_ms=cleaned.duration_ms,
        applied_floor_db=floor_db,
        has_non_speech=has_non_speech,
    )


def _apply_cleanup_envelope(
    audio: AudioBuffer, shape: np.ndarray, floor_db: float
) -> AudioBuffer:
    """Multiply ``10^(floor_db·shape/20)`` into every channel and store as ``float32``.

    The single place the envelope is applied, so that :func:`_solve_floor_db` can call it
    and measure exactly what :func:`clean_dialogue` will produce — including the ``float32``
    rounding of the stored samples. That matters more than it looks: solving in ``float64``
    and storing in ``float32`` left the achieved attenuation about 2e-9 dB *below* the
    requested 10 dB, which the strict ``<`` comparison in
    ``services/mastering/mastering-assistant.ts`` would have read as a failure and refused a
    perfectly good cleanup over. Solving against the quantised output removes the class of
    bug rather than widening the comparison to hide it.
    """
    envelope = np.power(10.0, (floor_db * shape) / 20.0)
    return AudioBuffer.from_channels(
        audio.sample_rate,
        [
            (channel.astype(np.float64) * envelope).astype(SAMPLE_DTYPE)
            for channel in audio.channels
        ],
    )


def _cleanup_shape(audio: AudioBuffer, mask: np.ndarray, transition_ms: float) -> np.ndarray:
    """1 across all non-speech, 0 in each speech region's interior, ramped inside its edges.

    A *shape* rather than a finished envelope, so the envelope is ``floor_db × shape`` for
    any floor. That factorisation is what lets :func:`_solve_floor_db` bisect on one scalar
    without rebuilding the geometry each iteration, and it is why the ramp is linear in
    **dB**: a linear-in-amplitude ramp of 10 dB or more sounds like a step near its quiet
    end, because loudness is logarithmic.

    ### The ramps are inside each region, not outside it

    This is the subtle decision in dialogue cleanup, and the obvious arrangement is the
    wrong one. Placing the ramps in the *non-speech* side leaves no speech sample
    attenuated at all — which sounds ideal — but it makes Requirement 30.9's first half
    unsatisfiable for a class of real input, and a property test found it:

    Requirement 30.12 fixes the detection grid at 100 ms, so a burst of speech that starts
    or ends mid-window leaves up to 100 ms of genuinely loud audio *outside* the detected
    region. Those samples are part of the non-speech set the clause measures. With the
    ramps outside, the ones nearest the edge are barely attenuated, and because they are
    30 dB louder than the room floor they dominate the non-speech energy — so the measured
    reduction **saturates**. On one generated case it stopped at 8.39 dB no matter how deep
    the floor went, including at 130 dB below target. Requirement 30.9 asks for 10 dB, so
    the operation would have had to be refused for audio nothing was wrong with.

    Ramping inside the region removes the class of failure rather than tuning around it:

    * **Every** non-speech sample now gets the full floor, so the achieved attenuation is
      the floor exactly and can never saturate.
    * The cost is that the first and last ``transition_ms`` of each *detected* region are
      partly attenuated. For a 20 ms ramp on a 400–800 ms region that is under 7 % of the
      region, and the resulting shift in speech loudness is around 0.2 LUFS — comfortably
      inside Requirement 30.9's ±1.0 LUFS, which ``TestSpeechLoudnessBound`` holds it to
      across generated input rather than on one example.
    * Perceptually it is also the better trade: the region boundaries are already ±100 ms
      uncertain, and the first 20 ms of a detected region is the attack of a word rather
      than its body.

    A region shorter than twice the ramp gets proportionally shorter ramps, so the two
    never cross and no interior sample is ramped twice.
    """
    shape = np.where(mask, 0.0, 1.0)
    ramp_frames = max(1, window_sample_count(audio.sample_rate, transition_ms))

    # Run boundaries from the mask itself, padded so a region touching either end of the
    # buffer is still found. `changes` alternates start, stop (stop exclusive).
    padded = np.concatenate(([False], mask, [False]))
    changes = np.flatnonzero(np.diff(padded.astype(np.int8)))

    for start, stop in zip(changes[0::2], changes[1::2]):
        span = int(stop - start)
        ramp = max(1, min(ramp_frames, span // 2))
        # Fade in: starts at 1 (continuous with the non-speech frame before it) and falls
        # to the region's interior value of 0.
        shape[start : start + ramp] = np.maximum(
            shape[start : start + ramp], np.linspace(1.0, 0.0, ramp, endpoint=False)
        )
        # Fade out: rises back towards 1, reaching it at the first non-speech frame after
        # the region.
        shape[stop - ramp : stop] = np.maximum(
            shape[stop - ramp : stop], np.linspace(0.0, 1.0, ramp, endpoint=False)
        )

    return shape


#: Bisection iterations for :func:`_solve_floor_db`. 34 halvings of a 120 dB bracket
#: resolve the floor to ~7e-9 dB, three orders of magnitude below the 0.1 dB Requirement
#: 30.24 reports at. The count is **fixed** rather than tolerance-driven so the function
#: performs the same arithmetic on every run and is bit-for-bit reproducible — which is
#: what Requirement 30.18 asks for and what a `while abs(hi - lo) > eps` loop would not
#: give, since its iteration count would depend on the input.
_FLOOR_SOLVE_ITERATIONS = 34
#: How far below the requested attenuation the search is allowed to reach.
_FLOOR_SOLVE_HEADROOM_DB = 120.0


def _solve_floor_db(
    audio: AudioBuffer, shape: np.ndarray, mask: np.ndarray, attenuation_db: float
) -> float:
    """The least-deep envelope floor whose measured non-speech reduction meets the target.

    Monotone by construction — deepening the floor can only reduce the non-speech energy —
    so bisection is exact rather than approximate. The invariant maintained is that
    ``deep`` always satisfies the requirement, and ``deep`` is what is returned, which is
    why the achieved attenuation is ``≥`` the target rather than ``≈`` it.

    ``achieved`` measures the **quantised** output, by calling the same
    :func:`_apply_cleanup_envelope` :func:`clean_dialogue` uses. Measuring an unquantised
    ``float64`` product instead left the real, stored result a few nanodecibels short of the
    target — enough for the strict comparison in the product layer to refuse it. See that
    function's docstring.

    Returns ``−attenuation_db`` unchanged when there is nothing to solve for: no non-speech
    frames, or non-speech frames that are already exactly silent. In both cases the
    measurement is ``-inf`` and no floor changes it.
    """
    target = abs(attenuation_db)
    non_speech = ~mask
    if not bool(non_speech.any()):
        return -target

    before = np.stack([channel.astype(np.float64) for channel in audio.channels], axis=0)
    total = float(np.sum(np.square(before[:, non_speech])))
    if total <= 0.0:
        return -target

    # Only the non-speech frames are measured, so only they are evaluated. The arithmetic
    # is elementwise, so `(x·g).astype(float32)` restricted to these frames is bit-identical
    # to the same expression over the whole channel — which is what makes this both the
    # cheap form and the exact one.
    before_non_speech = before[:, non_speech]
    shape_non_speech = shape[non_speech]

    def achieved(floor_db: float) -> float:
        gains = np.power(10.0, (floor_db * shape_non_speech) / 20.0)
        quantised = (before_non_speech * gains).astype(SAMPLE_DTYPE).astype(np.float64)
        remaining = float(np.sum(np.square(quantised)))
        if remaining <= 0.0:
            return math.inf
        return 10.0 * math.log10(total / remaining)

    deep = -(target + _FLOOR_SOLVE_HEADROOM_DB)
    if achieved(deep) < target:
        # Unreachable for any real signal: 120 dB below the requested reduction cannot
        # leave more energy than the target allows unless the ramps *are* the non-speech
        # audio. Returned anyway, so the caller measures what was achieved and
        # `services/mastering/mastering-assistant.ts` refuses rather than this raising.
        return deep

    shallow = 0.0
    for _ in range(_FLOOR_SOLVE_ITERATIONS):
        middle = (deep + shallow) / 2.0
        if achieved(middle) >= target:
            deep = middle
        else:
            shallow = middle
    return deep


@dataclass(frozen=True)
class DuckingResult:
    """Requirements 30.12–30.17. Mirrors ``DuckingResultDsp``."""

    audio: AudioBuffer
    speech_regions: tuple[SpeechRegion, ...]
    #: Requirement 30.17's stored artefact: ``(time_ms, gain_db)`` breakpoints.
    automation_points: tuple[tuple[float, float], ...]
    duration_ms: float

    def automation_as_dicts(self) -> list[dict[str, float]]:
        return [{"timeMs": time_ms, "gainDb": gain_db} for time_ms, gain_db in self.automation_points]


def ducking_envelope(
    regions: Sequence[SpeechRegion],
    duration_ms: float,
    depth_db: float,
    attack_ms: float,
    release_ms: float,
) -> tuple[tuple[float, float], ...]:
    """Requirements 30.12, 30.14–30.17: the automation curve, as breakpoints.

    For each region ``[s, e)``: a ramp from 0 dB to ``depth_db`` **ending at ``s``**, a
    hold across ``[s, e)``, and a ramp back to 0 dB over ``release_ms`` from ``e``.
    Values between breakpoints are linear in dB, which is what
    ``gainAtMs`` in ``domain/mastering/ducking.ts`` assumes when it verifies the curve.

    The attack *ends* at ``s`` — a look-ahead — because Requirement 30.12 requires the
    music attenuated to within ±1.0 dB of the depth across the **whole** region, and an
    attack starting at ``s`` would leave the first ``attack_ms`` of every line
    under-ducked. Look-ahead is available because this is offline processing of a stored
    track, not a live mixer.

    Overlapping envelopes take the **lower** (more attenuated) gain, so two lines closer
    together than ``attack_ms + release_ms`` do not produce a partial lift between them.
    That is achieved by building the curve on a dense grid and then reducing it to
    breakpoints, rather than by merging intervals analytically: the analytic version has
    a case for every way two windows can overlap, and this has none.

    ``domain/mastering/ducking.ts`` documents the one place the spec conflicts with
    itself — Requirement 30.16 versus 30.14/30.15 — and why the transition ramps are
    exempt from 30.16's steady-state bound.
    """
    if duration_ms <= 0:
        return ((0.0, 0.0),)
    if not regions:
        return ((0.0, 0.0), (duration_ms, 0.0))

    depth = -abs(depth_db)
    # A 1 ms grid: fine enough that a breakpoint lands within a millisecond of every
    # true corner, and Requirement 30.17's curve is stored in integer-ish milliseconds
    # for a user to edit anyway.
    grid = np.arange(0.0, duration_ms + 1.0, 1.0)
    gains = np.zeros(grid.size, dtype=np.float64)

    for region in regions:
        attack_start = region.start_ms - attack_ms
        release_end = region.end_ms + release_ms
        contribution = np.zeros(grid.size, dtype=np.float64)

        rising = (grid > attack_start) & (grid < region.start_ms)
        if attack_ms > 0:
            contribution[rising] = depth * (grid[rising] - attack_start) / attack_ms
        held = (grid >= region.start_ms) & (grid < region.end_ms)
        contribution[held] = depth
        falling = (grid >= region.end_ms) & (grid < release_end)
        if release_ms > 0:
            contribution[falling] = depth * (1.0 - (grid[falling] - region.end_ms) / release_ms)

        gains = np.minimum(gains, contribution)

    # Reduce the grid to breakpoints: keep the ends, and keep any sample that is not the
    # linear interpolation of its neighbours. Anything collinear carries no information
    # and a curve of 240 000 points is not something a user can edit (Requirement 30.17).
    keep = [0]
    for index in range(1, grid.size - 1):
        midpoint = (gains[index - 1] + gains[index + 1]) / 2.0
        if abs(gains[index] - midpoint) > 1e-9:
            keep.append(index)
    keep.append(grid.size - 1)

    return tuple((float(grid[index]), float(gains[index])) for index in keep)


def duck(
    dialogue: AudioBuffer,
    music: AudioBuffer,
    *,
    depth_db: float | None = None,
    attack_ms: float | None = None,
    release_ms: float | None = None,
    rms_threshold_db: float | None = None,
    min_duration_ms: float | None = None,
) -> DuckingResult:
    """Requirements 30.12–30.17: detect speech in ``dialogue``, attenuate ``music``.

    ``dialogue`` is read and never modified — Requirement 30.12 names the music track as
    the one attenuated, and the dialogue track is the reference. That asymmetry is why
    the two are separate parameters rather than a list of two.

    The envelope is generated over the **music** track's own duration, because that is
    the signal being multiplied. A dialogue track longer than the music simply has its
    later regions clipped by the grid; a shorter one leaves the music unducked past its
    end, which is correct — there is no speech there.

    The curve returned is the curve applied, sampled back onto the frame grid by linear
    interpolation in dB. So Requirement 30.17's stored artefact provably describes the
    audio: ``domain/mastering/ducking.ts`` verifies the breakpoints against Requirements
    30.12 and 30.16, and what it verifies is what was rendered.
    """
    reg = registry()
    depth = reg.ducking_depth_default_db if depth_db is None else float(depth_db)
    attack = reg.ducking_attack_default_ms if attack_ms is None else float(attack_ms)
    release = reg.ducking_release_default_ms if release_ms is None else float(release_ms)

    regions = detect_speech_regions(
        dialogue, rms_threshold_db=rms_threshold_db, min_duration_ms=min_duration_ms
    )
    duration_ms = music.duration_ms
    points = ducking_envelope(regions, duration_ms, depth, attack, release)

    if music.is_well_formed:
        times_ms = np.arange(music.frame_count, dtype=np.float64) * 1000.0 / music.sample_rate
        breakpoint_times = np.array([time_ms for time_ms, _ in points], dtype=np.float64)
        breakpoint_gains = np.array([gain_db for _, gain_db in points], dtype=np.float64)
        gains_db = np.interp(times_ms, breakpoint_times, breakpoint_gains)
        factors = np.power(10.0, gains_db / 20.0)
        ducked = AudioBuffer.from_channels(
            music.sample_rate,
            [
                (channel.astype(np.float64) * factors).astype(SAMPLE_DTYPE)
                for channel in music.channels
            ],
        )
    else:  # pragma: no cover - a malformed buffer has nothing to duck
        ducked = music

    return DuckingResult(
        audio=ducked,
        speech_regions=regions,
        automation_points=points,
        duration_ms=duration_ms,
    )
