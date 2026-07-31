"""Deterministic mixdown rendering (Requirements 28.24–28.29, design §5.6, §6.1–§6.3).

Plain callables, like :mod:`musicstudio_dsp.effects` and
:mod:`musicstudio_dsp.mastering`. Nothing here imports Celery, touches a broker or
reaches storage; :mod:`musicstudio_dsp.worker`'s shell is a few lines and delegates,
because **no broker is reachable from a test environment**.

### What is here, and what is deliberately not

Here: the *samples*. Design §5.6's per-clip chain, the summation of Requirement 28.24,
the length arithmetic of 28.25, the peak normalisation of 28.28, and the two invariants
that only exist at sample level — 28.26's commutativity and 28.27's reproducibility
(design §10's Properties 12 and 13, asserted in ``dsp/test/test_mixdown.py``).

Not here: **which clips render**. Requirements 28.19 and 28.20 are decided from stored
solo and mute state by ``domain/timeline/render-target.ts``, and the product layer sends
the resulting set (see ``services/timeline/mixdown-ports.ts``). A worker that re-derived
the selection would be a second answer to a settled question, and a project whose mute
state changed between the decision and the render would render something nobody asked
for. :func:`render_mixdown` therefore takes clips, not a project — and it still refuses
an empty set, because Requirement 28.29 is an obligation on the renderer and a task
accepts whatever is on the queue (the same reasoning :mod:`musicstudio_dsp.effects`
gives for validating a chain the product layer already validated).

### The per-clip chain (design §5.6)

``load → trim → effects → truncate to play length → gain → fade → place``, in that
order, for every clip. Two notes:

* **Effects are a wired slot, not a behaviour.** ``MixdownClip.effect_chain`` and the
  ``effect_processor`` argument exist so the stage sits in the right place in the chain;
  the behaviour, and in particular the delay/reverb tail policy of Requirement 29.32 and
  design §6.3, belongs to the task that owns clip effects. A clip that carries a chain
  with no processor supplied raises rather than silently dropping the chain — dropping it
  would make a mix that looks finished and is missing the user's edits.
* **Truncation to the play length is 4.2's, not the effect stage's.** Requirement 28.13
  makes play length ``source − trim_start − trim_end``, and 28.25's total length is stated
  over exactly that quantity. So the clip is conformed to its play length whether or not
  anything lengthened it, and the mix length arithmetic cannot be thrown off by a stage
  upstream of it.

### Track volume and pan are folded into the per-clip gain, and that is exact

Design §6.1 applies track volume and pan at step 5, *after* every clip has been summed
into a single ``output`` buffer. That is not implementable as written — after summation
the track a sample came from is no longer recoverable — so the pseudocode is read as
"each clip is scaled by its track's volume and pan", which is what a per-track bus would
compute. This implementation folds that scalar into the gain stage instead of building 32
buses, and the two agree **exactly** rather than approximately:

* Track volume and pan are constant linear scalars per output channel. Multiplication by
  a constant distributes over addition.
* Requirement 28.7 forbids two clips on the same ``track`` from overlapping, so no output
  sample ever receives two clips of the same track. A per-track bus therefore never sums
  two addends before being scaled, and ``Σ(g·x)`` and ``g·Σ(x)`` are not merely equal in
  exact arithmetic here — they are the *same* floating-point operations.

The 32-bus alternative also costs 32 buffers: five minutes of stereo ``float64`` is
230 MB per bus, 7 GB for the set. This is recorded because it is a real reading of a
defective pseudocode step, not a shortcut.

### Determinism (Requirement 28.27, design §5.5, §10 Property 13)

Three things give it, and one of them is not this module's to give:

1. **Fixed summation order.** Clips are summed in ascending ``clip_id`` order, sorted
   here rather than trusted from the caller. Floating-point addition is not associative,
   so a fixed order is what makes 28.26's commutativity and 28.27's reproducibility hold
   *together*: reordering the input cannot reorder the arithmetic.
2. **No randomness, no clock, no state between calls.** Every function here is a pure
   transform of its arguments. No dithering — dithering draws from an RNG, and 28.27
   forbids a second render from differing at all.
3. **Single-threaded BLAS is not set here, and cannot be.** Design §5.5 asks for it, but
   NumPy fixes its thread-pool size when its backend loads, before this module is
   imported, so an ``os.environ`` write here would be read by nothing. It belongs in the
   worker container's environment (``OMP_NUM_THREADS=1`` and the vendor equivalents),
   which design §11.3's topology is where to declare. Tasks 3.1, 3.2 and 3.3 recorded the
   same finding for ``worker.py``, ``effects.py`` and ``mastering.py``.

   Property 13 does not *rely* on that pin, and the argument is the same one
   :mod:`musicstudio_dsp.effects` makes for Requirement 29.29, restated for summation
   because summation is where a reader would expect BLAS to appear: every array operation
   below is **elementwise** — slicing, zero-padding, scalar multiplication, ``+=`` between
   equal-length slices, ``np.abs``/``np.max``. None of them is a BLAS call. BLAS covers
   ``dot``/``matmul``-shaped work, and only *those* kernels block, tile and reassociate;
   elementwise ufuncs are evaluated in index order by a single thread regardless of
   ``OMP_NUM_THREADS``. There is no ``np.dot``, no ``@``, no ``einsum`` and no
   ``np.sum`` over an accumulation axis anywhere in this module — the mix is accumulated
   by repeated ``+=`` in a stated order precisely so that the addition order is the
   module's own and not a library's. So the reproducibility invariant is thread-count
   independent **by construction rather than by configuration**, and
   ``dsp/test/test_mixdown.py`` asserts it under whatever thread count the test process
   happens to have.

### Accumulation is ``float64``, output is ``float32``

Design §6.1's buffer is ``float64`` and its return is ``float32``, and that is kept: the
accumulator has headroom for a sum that overshoots 1.0 (which Requirement 28.28 exists to
handle) and rounds once at the end rather than once per clip. Design §5.1's internal
representation is ``float32``, so that is what comes back.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Callable, Mapping, Sequence

import numpy as np

from .audio_buffer import AudioBuffer
from .resample import INTERNAL_SAMPLE_RATE

__all__ = [
    "ATTENUATION_DB_MAX",
    "MIXDOWN_LENGTH_TOLERANCE_MS",
    "NORMALISED_PEAK_MAX",
    "NORMALISED_PEAK_MIN",
    "NORMALISATION_TARGET_PEAK",
    "PEAK_CEILING",
    "SAMPLE_DIFFERENCE_TOLERANCE",
    "ClipEffectProcessor",
    "EmptyRenderError",
    "MixdownClip",
    "MixdownError",
    "MixdownResult",
    "PeakNormalisation",
    "RenderParams",
    "TrackState",
    "mixdown_length_ms",
    "peak_normalisation",
    "render_mixdown",
]

#: Requirement 28.24/28.28's threshold between "leave alone" and "attenuate".
PEAK_CEILING = 1.0

#: Requirement 28.28's admissible window for the normalised peak.
NORMALISED_PEAK_MIN = 0.99
NORMALISED_PEAK_MAX = 1.0

#: Where inside that window normalisation aims. Design §6.1's ``0.995 / peak``.
#:
#: The midpoint rather than either edge, so that the ``float32`` rounding of the scaled
#: samples cannot carry the result out of the window: at 0.995 the margin to each edge is
#: 5·10⁻³, some seven orders of magnitude larger than a ``float32`` ulp near 1.0.
NORMALISATION_TARGET_PEAK = 0.995

#: Requirement 28.28's reportable attenuation ceiling, in dB. See :class:`PeakNormalisation`
#: on what happens above it.
ATTENUATION_DB_MAX = 40.0

#: Requirement 28.25's tolerance between the requested and the produced length, in ms.
MIXDOWN_LENGTH_TOLERANCE_MS = 10.0

#: Requirement 28.26's per-sample tolerance for two orderings of the same clip set.
SAMPLE_DIFFERENCE_TOLERANCE = 0.0001


class MixdownError(Exception):
    """A mixdown request the renderer refuses."""

    def __init__(self, code: str, detail: str = "") -> None:
        self.code = code
        self.detail = detail
        super().__init__(f"{code}: {detail}" if detail else code)


class EmptyRenderError(MixdownError):
    """Requirement 28.29: nothing to render.

    Named as design §6.1's pseudocode names it. The product layer refuses this case
    *before* it reaches a worker (see ``services/timeline/mixdown-renderer.ts``), which is
    what makes 28.29's "Timeline_Project 상태를 변경하지 않는다" trivially true there. This
    class is the worker's own guard, for a payload that arrives from anywhere else.
    """

    def __init__(self) -> None:
        super().__init__(
            "mixdown_no_render_target",
            "the render target set is empty; Requirement 28.29 refuses the request",
        )


@dataclass(frozen=True)
class RenderParams:
    """Requirement 28.27's 렌더링 파라미터, minus the ones stored on the clips and tracks.

    ``normalise_peak`` is listed by 28.27 as a parameter of the render ("피크 정규화 활성
    여부"), so it is one, defaulting to on because 28.24 and 28.28 describe normalisation
    as what the renderer does rather than as an option someone enables.
    """

    sample_rate: int = INTERNAL_SAMPLE_RATE
    channels: int = 2
    normalise_peak: bool = True


@dataclass(frozen=True)
class TrackState:
    """Requirement 28.18's two continuous track settings.

    Mute and solo are **not** here. They decide membership of the render target set
    (Requirements 28.19, 28.20), which is settled before this module is called; carrying
    them would invite a second, disagreeing answer.
    """

    volume_db: float = 0.0
    pan: float = 0.0


@dataclass(frozen=True)
class MixdownClip:
    """One render target, with its source audio already loaded (design §5.6 step 1).

    ``play_length_ms`` is passed rather than recomputed. Requirement 28.13 derives it from
    the *stored* asset duration, and the stored duration is what Requirement 28.25's total
    length is stated over; deriving it from the decoded frame count instead would let a
    one-frame decode difference move the mix length.
    """

    clip_id: str
    track: int
    audio: AudioBuffer
    start_time_ms: int
    play_length_ms: int
    trim_start_ms: int = 0
    trim_end_ms: int = 0
    gain_db: float = 0.0
    fade_in_ms: int = 0
    fade_out_ms: int = 0
    #: Design §5.6 step 3's slot. Behaviour belongs to the clip-effects task; see the
    #: module docstring.
    effect_chain: tuple[Mapping[str, Any], ...] = field(default_factory=tuple)


#: Design §5.6 step 3's seam. Takes the trimmed audio and the clip's chain, returns
#: processed audio of any length — this module truncates to the play length afterwards.
ClipEffectProcessor = Callable[[AudioBuffer, Sequence[Mapping[str, Any]]], AudioBuffer]


@dataclass(frozen=True)
class PeakNormalisation:
    """Requirements 28.24 and 28.28's verdict about one summed mix.

    ``attenuation_db`` is 0.0 exactly when the peak was already at or below 1.0, which is
    28.24's "감쇠량 0데시벨로 기록", and strictly positive otherwise, which is 28.28's
    "0데시벨 초과".

    ``within_reportable_range`` exists because Requirement 28.28 states two obligations
    that a loud enough mix cannot both satisfy: bring the peak into [0.99, 1.0] **and**
    report an attenuation of at most 40 dB. 40 dB is a factor of 100, so any summed peak
    above ``0.995 × 100 = 99.5`` needs more attenuation than the clause permits itself to
    report — and that is reachable inside Requirement 28's own bounds (a clip at +12 dB on
    a track at +12 dB is ×15.85, and 32 tracks can sound at once). The amplitude window is
    the obligation about the *audio* and is always met; the flag reports that the dB figure
    fell outside the range the clause anticipated, rather than clamping the coefficient and
    quietly leaving the peak above 1.0. **Open question for the spec** — see the task 4.2
    report.
    """

    #: The single coefficient applied to every sample (28.28's 동일한 단일 감쇠 계수).
    coefficient: float
    #: Positive dB of attenuation; 0.0 when none was applied.
    attenuation_db: float
    applied: bool
    within_reportable_range: bool


def peak_normalisation(peak: float) -> PeakNormalisation:
    """Requirements 28.24, 28.28: the coefficient for a summed mix with this peak.

    Pure arithmetic over the peak, exported because it is the rule itself and both the
    unit tests and the product layer's mirror in ``domain/timeline/mixdown.ts`` assert
    against it directly.
    """
    if not math.isfinite(peak) or peak < 0.0:
        raise MixdownError("mixdown_peak_not_finite", f"peak was {peak!r}")

    # 28.24: at or below the ceiling nothing is touched and the recorded attenuation is 0.
    if peak <= PEAK_CEILING:
        return PeakNormalisation(
            coefficient=1.0, attenuation_db=0.0, applied=False, within_reportable_range=True
        )

    coefficient = NORMALISATION_TARGET_PEAK / peak
    attenuation_db = -20.0 * math.log10(coefficient)
    return PeakNormalisation(
        coefficient=coefficient,
        attenuation_db=attenuation_db,
        applied=True,
        within_reportable_range=attenuation_db <= ATTENUATION_DB_MAX,
    )


@dataclass(frozen=True)
class MixdownResult:
    """The rendered mix, plus everything Requirements 28.24–28.28 report.

    Mirrors ``MixdownRenderResult`` in ``services/timeline/mixdown-ports.ts`` field for
    field, so nothing is reshaped at the seam.
    """

    audio: AudioBuffer
    #: The summation order actually used: ascending ``clip_id``.
    rendered_clip_ids: tuple[str, ...]
    #: Requirement 28.25's 구간 길이, computed from clip times in milliseconds.
    requested_length_ms: float
    #: Largest absolute sample before normalisation.
    peak_before: float
    #: Largest absolute sample after normalisation.
    peak_after: float
    normalisation: PeakNormalisation

    @property
    def attenuation_db(self) -> float:
        return self.normalisation.attenuation_db

    @property
    def duration_ms(self) -> float:
        return self.audio.duration_ms

    @property
    def length_error_ms(self) -> float:
        """Requirement 28.25's error term, for a caller that checks the tolerance."""
        return abs(self.audio.duration_ms - self.requested_length_ms)


def _frames(ms: float, sample_rate: int) -> int:
    """Milliseconds to frames, rounding halves upward.

    ``floor(x + 0.5)`` rather than :func:`round`, for the reason
    :func:`musicstudio_dsp.audio_buffer.window_sample_count` gives: Python's :func:`round`
    is banker's rounding and JavaScript's ``Math.round`` is not, and the two sides of the
    seam have to agree frame for frame.
    """
    return int(math.floor(ms * sample_rate / 1000.0 + 0.5))


def mixdown_length_ms(clips: Sequence[MixdownClip]) -> float:
    """Requirement 28.25: 시각 0 부터 max(start_time_ms + 재생 길이) 까지.

    Over the clips given, which are the render targets — Requirement 28.25's second half
    ("렌더링 대상에서 제외된 클립을 길이 계산에 포함하지 않는다") is satisfied by the
    caller having excluded them, and cannot be violated here because an excluded clip is
    not in the argument.
    """
    if not clips:
        return 0.0
    return float(max(clip.start_time_ms + clip.play_length_ms for clip in clips))


def _conform_channels(signal: np.ndarray, channels: int) -> np.ndarray:
    """Bring a ``(source_channels, frames)`` array to ``channels`` rows.

    Mono to stereo duplicates; stereo to mono averages. Requirement 19.3 stores 1 or 2
    channels and nothing else, so those are the only conversions, and both are stated here
    rather than left to a caller so that every clip in a mix is conformed the same way.

    Averaging rather than summing for the downmix, because summing two correlated channels
    doubles the amplitude and would make peak normalisation fire on a mix that was inside
    the ceiling in stereo — a channel-count choice would change the samples of every other
    clip through the shared attenuation coefficient.
    """
    rows = signal.shape[0]
    if rows == channels:
        return signal
    if rows == 1:
        return np.repeat(signal, channels, axis=0)
    if rows == 2 and channels == 1:
        return ((signal[0] + signal[1]) * 0.5).reshape(1, -1)
    raise MixdownError(
        "mixdown_channel_count_unsupported",
        f"cannot conform {rows} channels to {channels}",
    )


def _pan_gains(pan: float, channels: int) -> tuple[float, ...]:
    """Requirement 28.18's pan as one gain per output channel.

    **The pan law is underdetermined by the requirement**, which states only the −1…+1
    range. The one used is a *balance* law: ``left = min(1, 1 − pan)``,
    ``right = min(1, 1 + pan)``. Two reasons for that choice over a constant-power
    (sine/cosine) law:

    * ``pan = 0`` is exactly unity on both channels, so the overwhelmingly common case
      multiplies by 1.0 and changes no sample. A constant-power law scales a centred clip
      by ``√½``, which would attenuate every default mix by 3 dB and make peak
      normalisation fire differently depending on a setting nobody touched.
    * A hard-panned clip keeps its full level in the channel it lands in, which is what
      Requirement 28.24's summation of a hard-panned clip with a centred one is expected
      to sound like.

    For a **mono render** pan is not applied at all: there is no channel to move between,
    and folding the balance gains into a mono output would attenuate hard-panned clips by
    up to 6 dB for no reason a user could see. Recorded as an open question.
    """
    if channels == 1:
        return (1.0,)
    if channels != 2:
        raise MixdownError(
            "mixdown_channel_count_unsupported", f"pan is undefined for {channels} channels"
        )
    return (min(1.0, 1.0 - pan), min(1.0, 1.0 + pan))


def _fade_envelope(frames: int, fade_in_frames: int, fade_out_frames: int) -> np.ndarray | None:
    """Requirement 28.17's fades as a ``float64`` envelope, or ``None`` for no fade.

    Linear, as design §5.6 step 5 says ("선형 크로스페이드"). The fade-in ramp starts at
    exactly 0 and the fade-out ramp ends at exactly 0 — a fade that does not reach silence
    leaves the step it exists to remove. The ramps are computed from a single
    ``arange``/``n`` so an ``n``-frame fade is exactly ``n`` frames long, which is what
    Requirement 28.17's ceiling is stated in.
    """
    if fade_in_frames <= 0 and fade_out_frames <= 0:
        return None

    envelope = np.ones(frames, dtype=np.float64)
    fade_in = min(fade_in_frames, frames)
    if fade_in > 0:
        envelope[:fade_in] = np.arange(fade_in, dtype=np.float64) / float(fade_in)
    fade_out = min(fade_out_frames, frames)
    if fade_out > 0:
        ramp = np.arange(fade_out, dtype=np.float64) / float(fade_out)
        # Multiplied in rather than assigned, so a fade-in and a fade-out that overlap on a
        # very short clip compose instead of one overwriting the other.
        envelope[frames - fade_out :] *= ramp[::-1]
    return envelope


def _clip_signal(
    clip: MixdownClip,
    params: RenderParams,
    track: TrackState,
    effect_processor: ClipEffectProcessor | None,
) -> np.ndarray:
    """Design §5.6 steps 1–5 for one clip: trim, effects, truncate, gain, fade.

    Returns a ``(params.channels, play_frames)`` ``float64`` array ready to be added into
    the mix at its start offset.
    """
    if clip.audio.sample_rate != params.sample_rate:
        # Resampling is design §5.2's operation and happens on the way into storage
        # (Requirement 19.4), so every stored asset is already at the internal rate. A
        # mismatch here means the caller handed over something that never went through
        # that path, and silently resampling would hide it.
        raise MixdownError(
            "mixdown_sample_rate_mismatch",
            f"clip {clip.clip_id} is {clip.audio.sample_rate} Hz, render is {params.sample_rate} Hz",
        )
    if not clip.audio.is_well_formed:
        raise MixdownError("mixdown_clip_audio_malformed", f"clip {clip.clip_id}")
    if clip.play_length_ms <= 0:
        raise MixdownError(
            "mixdown_clip_play_length_invalid",
            f"clip {clip.clip_id} has play length {clip.play_length_ms} ms",
        )

    source = np.stack(clip.audio.channels, axis=0).astype(np.float64, copy=True)

    # 2. Trim (Requirements 28.10, 28.12): a non-destructive slice of the loaded audio.
    start = min(_frames(clip.trim_start_ms, params.sample_rate), source.shape[1])
    end = max(start, source.shape[1] - _frames(clip.trim_end_ms, params.sample_rate))
    signal = source[:, start:end]

    # 3. Clip effects. See the module docstring: the slot is wired, the behaviour is not.
    if clip.effect_chain:
        if effect_processor is None:
            raise MixdownError(
                "mixdown_clip_effects_unsupported",
                f"clip {clip.clip_id} carries an Effect_Chain but no processor was supplied",
            )
        processed = effect_processor(
            AudioBuffer.from_channels(
                params.sample_rate, [signal[row] for row in range(signal.shape[0])]
            ),
            clip.effect_chain,
        )
        signal = np.stack(processed.channels, axis=0).astype(np.float64, copy=False)

    # 4. Truncate (or pad) to exactly the play length. See MixdownClip.play_length_ms.
    play_frames = max(1, _frames(clip.play_length_ms, params.sample_rate))
    if signal.shape[1] > play_frames:
        signal = signal[:, :play_frames]
    elif signal.shape[1] < play_frames:
        signal = np.concatenate(
            [signal, np.zeros((signal.shape[0], play_frames - signal.shape[1]))], axis=1
        )

    signal = _conform_channels(signal, params.channels)

    # 5. Gain: the clip's own gain, the track's volume, and the track's pan, as one scalar
    #    per output channel. See the module docstring on why folding these is exact.
    clip_gain = 10.0 ** (clip.gain_db / 20.0)
    track_gain = 10.0 ** (track.volume_db / 20.0)
    pan_gains = _pan_gains(track.pan, params.channels)
    scaled = np.empty_like(signal)
    for channel in range(params.channels):
        scaled[channel] = signal[channel] * (clip_gain * track_gain * pan_gains[channel])

    # 6. Fades (Requirement 28.17).
    envelope = _fade_envelope(
        scaled.shape[1],
        _frames(clip.fade_in_ms, params.sample_rate),
        _frames(clip.fade_out_ms, params.sample_rate),
    )
    if envelope is not None:
        scaled *= envelope

    return scaled


def render_mixdown(
    clips: Sequence[MixdownClip],
    tracks: Mapping[int, TrackState] | None = None,
    params: RenderParams | None = None,
    *,
    effect_processor: ClipEffectProcessor | None = None,
) -> MixdownResult:
    """Requirements 28.24–28.28: render the given target clips into one mix.

    ``clips`` is the render target set (Requirements 28.19, 28.20), already decided; an
    empty one raises :class:`EmptyRenderError` (Requirement 28.29). ``tracks`` supplies
    Requirement 28.18's volume and pan per track number, defaulting to unity and centre
    for any track not named.

    The mix starts at time 0 (Requirement 28.24) and is as long as the latest clip end
    (Requirement 28.25). Clips are summed in ascending ``clip_id`` order, which is what
    Requirements 28.26 and 28.27 rest on — see the module docstring.
    """
    if not clips:
        raise EmptyRenderError()

    render_params = RenderParams() if params is None else params
    if render_params.channels not in (1, 2):
        raise MixdownError(
            "mixdown_channel_count_unsupported",
            f"output channels must be 1 or 2, got {render_params.channels}",
        )
    track_states = {} if tracks is None else tracks

    # Requirement 28.26's ordering, established here rather than trusted from the caller:
    # the caller's order is exactly what the clause says must not matter.
    ordered = sorted(clips, key=lambda clip: clip.clip_id)

    for clip in ordered:
        if clip.start_time_ms < 0:
            raise MixdownError(
                "mixdown_clip_start_time_invalid",
                f"clip {clip.clip_id} starts at {clip.start_time_ms} ms",
            )

    requested_length_ms = mixdown_length_ms(ordered)

    # The buffer is sized from the per-clip frame counts rather than from the total in
    # milliseconds. Rounding each of `start` and `play_length` to frames can put a clip's
    # last frame one sample beyond `frames(start + play_length)`, and truncating a clip to
    # keep an exact millisecond total would drop audio to satisfy a tolerance that already
    # allows 10 ms (Requirement 28.25). The resulting difference is at most one frame,
    # 0.021 ms at 48 kHz, and `MixdownResult.length_error_ms` reports it.
    total_frames = max(
        _frames(clip.start_time_ms, render_params.sample_rate)
        + max(1, _frames(clip.play_length_ms, render_params.sample_rate))
        for clip in ordered
    )

    output = np.zeros((render_params.channels, total_frames), dtype=np.float64)

    for clip in ordered:
        track = track_states.get(clip.track, TrackState())
        signal = _clip_signal(clip, render_params, track, effect_processor)

        # 7. Place at start_time_ms and sum (Requirements 28.9, 28.24). `+=` over a slice:
        #    elementwise, in index order, no BLAS. See the module docstring.
        offset = _frames(clip.start_time_ms, render_params.sample_rate)
        width = min(signal.shape[1], total_frames - offset)
        if width <= 0:
            continue
        output[:, offset : offset + width] += signal[:, :width]

    peak_before = float(np.max(np.abs(output))) if total_frames > 0 else 0.0
    normalisation = peak_normalisation(peak_before)
    if render_params.normalise_peak and normalisation.applied:
        output *= normalisation.coefficient
    elif normalisation.applied:
        # 28.27 lists 피크 정규화 활성 여부 as a render parameter, so it can be off. The
        # verdict is still reported — a caller that disabled normalisation should be able to
        # see that the mix clips — but no coefficient is applied and none is claimed.
        normalisation = PeakNormalisation(
            coefficient=1.0,
            attenuation_db=0.0,
            applied=False,
            within_reportable_range=True,
        )

    audio = AudioBuffer.from_channels(
        render_params.sample_rate, [output[row] for row in range(output.shape[0])]
    )
    peak_after = float(
        max((float(np.max(np.abs(channel))) for channel in audio.channels), default=0.0)
    )

    return MixdownResult(
        audio=audio,
        rendered_clip_ids=tuple(clip.clip_id for clip in ordered),
        requested_length_ms=requested_length_ms,
        peak_before=peak_before,
        peak_after=peak_after,
        normalisation=normalisation,
    )
