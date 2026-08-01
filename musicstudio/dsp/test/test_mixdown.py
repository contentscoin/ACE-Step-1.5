"""Deterministic mixdown rendering, and design §10's Properties 12 and 13.

**Properties 12 and 13 (design §10) are the two classes so named.** Per tasks.md §9.2's
ownership table — "Property 12–13 믹스다운 가환성·재현성 (Req 28.26–28.27) → 태스크 4.2" —
this task owns them, and nothing else. Everything else in this file is either an
example-based unit test or an explicitly *unnumbered* property test; design §10 assigns no
number to those, and inventing one would be a change to §10 that is not this task's to
make. Task 9.2's coverage audit must count only the two numbered classes.

### Why the two numbered properties are here and not in `test/property/`

Both are stated over *samples*. Requirement 28.26 bounds "대응하는 모든 샘플 값의 차이" and
28.27 requires "모든 샘플 값을 정확히 동일하게", and samples only exist on this side of the
seam: the product layer decides *which* clips render (``domain/timeline/render-target.ts``)
and never sees a buffer. Design §10's harness for Python is ``hypothesis``, so that is what
is used. The product layer's own half — that the plan is ordered by clip id and that the
length excludes non-targets — is an unnumbered property in
``test/property/timeline-mixdown-plan.test.ts``.

No broker anywhere. These call the plain functions of :mod:`musicstudio_dsp.mixdown`
directly, which is why the Celery shell in :mod:`musicstudio_dsp.worker` is thin.

### Runtime

Buffers are deliberately short — tens of milliseconds, a few clips — because rendering
real audio 100 times per property is the expensive part and the invariants under test are
not length-sensitive. Long inputs get targeted example-based tests instead
(``TestLength``, ``TestPeakNormalisation``).
"""

from __future__ import annotations

import math
from typing import Any

import numpy as np
import pytest
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from musicstudio_dsp.audio_buffer import AudioBuffer
from musicstudio_dsp.clip_effects import clip_effect_processor
from musicstudio_dsp.effects import pedalboard_available
from musicstudio_dsp.effects import registry as effect_registry
from musicstudio_dsp.mixdown import (
    ATTENUATION_DB_MAX,
    MIXDOWN_LENGTH_TOLERANCE_MS,
    NORMALISATION_TARGET_PEAK,
    NORMALISED_PEAK_MAX,
    NORMALISED_PEAK_MIN,
    SAMPLE_DIFFERENCE_TOLERANCE,
    EmptyRenderError,
    MixdownClip,
    MixdownError,
    RenderParams,
    TrackState,
    mixdown_length_ms,
    peak_normalisation,
    render_mixdown,
)
from musicstudio_dsp.resample import INTERNAL_SAMPLE_RATE

#: The guard ``test_effects.py`` established, applied to the two Property 13 cases that route
#: audio through ``pedalboard``. Property 13's dry cases carry no such dependency and keep
#: running on every host, so the property itself is never wholly skipped.
requires_pedalboard = pytest.mark.skipif(
    not pedalboard_available(),
    reason="pedalboard is unavailable (native wheel needs libatomic.so.1 from the platform)",
)

DSP_SETTINGS = settings(
    max_examples=100,
    deadline=None,
    suppress_health_check=[HealthCheck.too_slow, HealthCheck.data_too_large],
)

#: Requirement 28's own limits, so the generators stay inside the input space the
#: Timeline_Service can actually produce (domain/timeline/bounds.ts).
CLIP_GAIN_DB_MIN = -40.0
CLIP_GAIN_DB_MAX = 12.0
TRACK_VOLUME_DB_MIN = -60.0
TRACK_VOLUME_DB_MAX = 12.0
TRACK_INDEX_MAX = 31


# --------------------------------------------------------------------------------------
# Generators. Constrained rather than filtered: an invalid clip is not a member of the
# set Requirements 28.26 and 28.27 quantify over, so filtering would test the same set
# more slowly (the discipline test_effects.py and timeline-harness.ts both use).
# --------------------------------------------------------------------------------------


def source_audio(
    frames: int = 960, channels: int = 2, seed: int = 11, sample_rate: int = INTERNAL_SAMPLE_RATE
) -> AudioBuffer:
    """Deterministic broadband source audio, 20 ms of stereo by default.

    A seeded RNG rather than a sine: a tone is symmetric enough that a summation-order bug
    could cancel out of the comparison, and noise makes every sample distinct. The seed is
    fixed so a failure is reproducible, which matters most for the two properties whose
    subject *is* reproducibility.
    """
    rng = np.random.default_rng(seed)
    return AudioBuffer.from_channels(
        sample_rate,
        [(rng.standard_normal(frames) * 0.2).astype(np.float32) for _ in range(channels)],
    )


@st.composite
def clip_specs(draw: st.DrawFn, count: int) -> list[MixdownClip]:
    """``count`` render-target clips laid out so every one is individually valid.

    Overlap is *not* avoided: two clips on different tracks may sound at once, and
    Requirement 28.24's summation is the whole subject here. What is avoided is per-clip
    invalidity — trims that consume the source (28.10), fades over half the play length
    (28.17), gains outside 28.16's range.

    Clip ids are drawn as a permutation of a fixed pool so that two projects can hold the
    *same* clip set in different orders, which is Requirement 28.26's antecedent.
    """
    clips: list[MixdownClip] = []
    for index in range(count):
        source_frames = draw(st.integers(min_value=240, max_value=1_440))
        channels = draw(st.sampled_from([1, 2]))
        audio = source_audio(frames=source_frames, channels=channels, seed=index + 1)
        source_ms = source_frames * 1000.0 / INTERNAL_SAMPLE_RATE

        trim_start_ms = draw(st.integers(min_value=0, max_value=max(0, int(source_ms * 0.3))))
        trim_end_ms = draw(st.integers(min_value=0, max_value=max(0, int(source_ms * 0.3))))
        play_length_ms = max(1, int(source_ms) - trim_start_ms - trim_end_ms)
        fade_ceiling = play_length_ms // 2

        clips.append(
            MixdownClip(
                clip_id=f"clip-{index:02d}",
                track=draw(st.integers(min_value=0, max_value=min(3, TRACK_INDEX_MAX))),
                audio=audio,
                start_time_ms=draw(st.integers(min_value=0, max_value=40)),
                play_length_ms=play_length_ms,
                trim_start_ms=trim_start_ms,
                trim_end_ms=trim_end_ms,
                gain_db=draw(
                    st.floats(
                        min_value=CLIP_GAIN_DB_MIN,
                        max_value=CLIP_GAIN_DB_MAX,
                        allow_nan=False,
                        allow_infinity=False,
                    )
                ),
                fade_in_ms=draw(st.integers(min_value=0, max_value=fade_ceiling)),
                fade_out_ms=draw(st.integers(min_value=0, max_value=fade_ceiling)),
            )
        )
    return clips


@st.composite
def clip_sets(draw: st.DrawFn) -> list[MixdownClip]:
    """A small render target set. Small on purpose — see the module docstring on runtime."""
    return draw(clip_specs(draw(st.integers(min_value=1, max_value=4))))


@st.composite
def track_maps(draw: st.DrawFn) -> dict[int, TrackState]:
    """Requirement 28.18's volume and pan for the four tracks the generators use."""
    return {
        track: TrackState(
            volume_db=draw(
                st.floats(
                    min_value=TRACK_VOLUME_DB_MIN,
                    max_value=TRACK_VOLUME_DB_MAX,
                    allow_nan=False,
                    allow_infinity=False,
                )
            ),
            pan=draw(
                st.floats(min_value=-1.0, max_value=1.0, allow_nan=False, allow_infinity=False)
            ),
        )
        for track in range(4)
    }


def render_params() -> st.SearchStrategy[RenderParams]:
    return st.builds(
        RenderParams,
        sample_rate=st.just(INTERNAL_SAMPLE_RATE),
        channels=st.sampled_from([1, 2]),
        normalise_peak=st.booleans(),
    )


@st.composite
def clip_effect_chains(draw: st.DrawFn) -> tuple[dict[str, Any], ...]:
    """A valid ``Effect_Chain`` for a clip (Requirements 29.1–29.13, 29.31).

    Constrained, not filtered: parameter values are drawn inside each kind's registered range,
    read from the registry rather than written out here, so a range change cannot leave this
    generator producing chains ``validate_chain`` rejects.

    ``delay`` and ``reverb`` are included deliberately and are the interesting cases — they are
    the two tail-extending kinds (Requirements 29.30, 29.32), so a chain containing one produces
    audio longer than the clip's play length, which is exactly what design §6.3's cut is for.
    Chains are kept to at most two items to keep 100 examples affordable; ``pedalboard`` is the
    expensive part of these properties.
    """
    reg = effect_registry()
    kinds = draw(st.lists(st.sampled_from(list(reg.kinds)), min_size=1, max_size=2))
    chain: list[dict[str, Any]] = []
    for kind in kinds:
        definition = reg.effects[kind]
        parameters: dict[str, float] = {}
        for name, prange in definition.parameters.items():
            step = draw(st.integers(min_value=0, max_value=8))
            value = prange.minimum + (prange.maximum - prange.minimum) * step / 8
            parameters[name] = round(value, 6)
        chain.append({"kind": kind, "parameters": parameters})
    return tuple(chain)


@st.composite
def clip_sets_with_effects(draw: st.DrawFn) -> list[MixdownClip]:
    """A render target set in which some clips carry a chain and some do not.

    Both states matter: Requirement 29.31 is a ``WHERE`` clause, so a mix normally contains a
    mixture, and the reproducibility claim has to hold for the mixture rather than for the
    all-wet case only.
    """
    clips = draw(clip_specs(draw(st.integers(min_value=1, max_value=3))))
    return [
        clip
        if draw(st.booleans())
        else MixdownClip(**{**clip.__dict__, "effect_chain": draw(clip_effect_chains())})
        for clip in clips
    ]


def clip(**overrides: object) -> MixdownClip:
    """One clip with sensible defaults, for the example-based tests."""
    base: dict[str, object] = {
        "clip_id": "clip-a",
        "track": 0,
        "audio": source_audio(),
        "start_time_ms": 0,
        "play_length_ms": 20,
    }
    base.update(overrides)
    return MixdownClip(**base)  # type: ignore[arg-type]


def constant_audio(value: float, frames: int = 960, channels: int = 2) -> AudioBuffer:
    """A DC buffer, for tests that need a known peak."""
    return AudioBuffer.from_channels(
        INTERNAL_SAMPLE_RATE,
        [np.full(frames, value, dtype=np.float32) for _ in range(channels)],
    )


# --------------------------------------------------------------------------------------
# Design §10, Property 12 — Requirement 28.26
# --------------------------------------------------------------------------------------


class TestProperty12MixdownCommutativity:
    """Feature: ai-music-generation-service, Property 12: 믹스다운 가환성 — `start_time_ms`가
    모두 명시적으로 지정된 동일 클립 집합에 대해, 클립 추가 순서만 다르게 구성된 두
    `Timeline_Project`의 믹스다운 결과는 샘플 수가 동일하고 모든 대응 샘플 값 차이가 0.0001
    이하이다.

    **Validates: Requirements 28.26**

    The two "projects" are the same clip set in two different orders — which is exactly
    what 28.26 quantifies over ("클립 추가 순서만 다르게 구성된"). Everything else is held
    equal, because the clause holds the render parameters equal too.

    The clause's bound is ≤0.0001 per sample and the assertion below uses it. The
    implementation is *stronger* than that — it sorts by clip id before summing, so the two
    renders perform bit-for-bit the same additions in the same order and the observed
    difference is exactly zero — and :meth:`test_reordering_is_bit_exact_not_merely_close`
    asserts that separately.

    Both are worth having, and the reason is worth stating because it is easy to
    over-claim. A ``float64`` accumulator absorbs reassociation error so thoroughly that a
    hypothetical implementation summing in *caller* order would still usually produce
    bit-identical ``float32`` output for a handful of clips — so the sample comparisons
    alone would not catch the loss of the ordering guarantee, and would not catch it at all
    until a mix large enough for the error to reach the last ``float32`` mantissa bit. What
    does catch it directly is the assertion on ``rendered_clip_ids``: that is the summation
    order the renderer actually used, so an implementation that stopped sorting fails with a
    message naming the two orders rather than with a numeric drift nobody can localise.
    """

    @given(clips=clip_sets(), tracks=track_maps(), params=render_params(), seed=st.integers())
    @DSP_SETTINGS
    def test_sample_difference_stays_within_the_tolerance(
        self,
        clips: list[MixdownClip],
        tracks: dict[int, TrackState],
        params: RenderParams,
        seed: int,
    ) -> None:
        shuffled = list(clips)
        # A deterministic permutation from the drawn seed: `hypothesis` supplies the
        # entropy, so no RNG state leaks between examples.
        rotation = seed % max(1, len(shuffled))
        shuffled = shuffled[rotation:] + shuffled[:rotation]
        shuffled.reverse()

        first = render_mixdown(clips, tracks, params)
        second = render_mixdown(shuffled, tracks, params)

        # "두 결과의 샘플 개수를 동일하게 산출하고" — shape first.
        assert first.audio.frame_count == second.audio.frame_count
        assert first.audio.channel_count == second.audio.channel_count
        assert first.audio.sample_rate == second.audio.sample_rate

        # "대응하는 모든 샘플 값의 차이 절대값을 0.0001 이하로 유지한다".
        for index, (left, right) in enumerate(zip(first.audio.channels, second.audio.channels)):
            drift = float(np.max(np.abs(left.astype(np.float64) - right.astype(np.float64))))
            # `not (drift <= tol)` rather than `drift > tol`: a NaN would pass the latter
            # silently, and a NaN in a mix is precisely a summation bug.
            assert not (drift > SAMPLE_DIFFERENCE_TOLERANCE), (
                f"channel {index} drifted by {drift}, above {SAMPLE_DIFFERENCE_TOLERANCE}"
            )

    @given(clips=clip_sets(), tracks=track_maps(), params=render_params())
    @DSP_SETTINGS
    def test_reordering_is_bit_exact_not_merely_close(
        self,
        clips: list[MixdownClip],
        tracks: dict[int, TrackState],
        params: RenderParams,
    ) -> None:
        # Stronger than 28.26 and true by construction: the summation order is the clip-id
        # order, so the input order cannot reach the arithmetic. See the class docstring.
        first = render_mixdown(clips, tracks, params)
        second = render_mixdown(list(reversed(clips)), tracks, params)

        assert first.rendered_clip_ids == second.rendered_clip_ids
        for index, (left, right) in enumerate(zip(first.audio.channels, second.audio.channels)):
            assert np.array_equal(left, right), f"channel {index} differs bit for bit"

    @given(clips=clip_sets(), tracks=track_maps(), params=render_params())
    @DSP_SETTINGS
    def test_reported_attenuation_is_order_independent_too(
        self,
        clips: list[MixdownClip],
        tracks: dict[int, TrackState],
        params: RenderParams,
    ) -> None:
        # Requirement 28.28's coefficient is derived from the summed peak, so an
        # order-dependent sum would show up here as well as in the samples. Asserted
        # because the attenuation is stored on the asset (28.28) and a project reordered by
        # an undo would otherwise produce a mix whose metadata disagreed with its twin.
        first = render_mixdown(clips, tracks, params)
        second = render_mixdown(list(reversed(clips)), tracks, params)
        assert first.attenuation_db == second.attenuation_db
        assert first.peak_before == second.peak_before


# --------------------------------------------------------------------------------------
# Design §10, Property 13 — Requirement 28.27
# --------------------------------------------------------------------------------------


class TestProperty13MixdownReproducibility:
    """Feature: ai-music-generation-service, Property 13: 믹스다운 재현성 — 동일
    `Timeline_Project`와 동일 렌더링 파라미터에 대해 3회 믹스다운 결과의 샘플 수와 모든 샘플
    값은 정확히 동일하다.

    **Validates: Requirements 28.27**

    Three renders, as the clause and task 4.2's acceptance criterion both say, compared
    with :func:`numpy.array_equal` on the raw ``float32`` arrays — **bit equality, not
    ``approx``**. An approximate comparison would pass for an implementation that summed in
    a thread-dependent order and differed in the last mantissa bit, which is exactly the
    failure 28.27 names.

    ### "다른 렌더링 작업자에서 처리되는 경우에도"

    The clause requires the three renders to agree even when one of them runs on a
    different worker. A test cannot start a second worker here — no broker is reachable —
    so what is asserted instead is the property that *makes* cross-worker agreement hold:
    :func:`render_mixdown` is a pure function of its arguments, so a second worker running
    the same code on the same input differs only in its process environment.

    The one environmental difference that could matter is the BLAS thread count, and
    :meth:`test_is_bit_exact_under_the_ambient_thread_count` is where that is addressed.
    Design §5.5 asks for single-threaded BLAS and it **cannot** be set from Python: NumPy
    fixes its thread-pool size when its backend loads, before these modules are imported.
    It belongs in the worker container's environment (``OMP_NUM_THREADS=1`` and the vendor
    equivalents), and design §11.3's topology is where to declare it. Tasks 3.1, 3.2 and
    3.3 recorded the same finding.

    This property is therefore written to be **thread-count independent rather than
    thread-count pinned**, and that is a fact about the arithmetic rather than a
    concession: every array operation in :mod:`musicstudio_dsp.mixdown` is elementwise
    (slicing, zero-padding, scalar multiplication, ``+=`` between equal-length slices,
    ``abs``/``max``). BLAS parallelises and reassociates ``dot``/``matmul``-shaped kernels;
    elementwise ufuncs are evaluated in index order by one thread whatever
    ``OMP_NUM_THREADS`` says. The module contains no ``dot``, no ``@``, no ``einsum`` and
    no ``sum`` over an accumulation axis — the mix is accumulated by repeated ``+=`` in an
    order the module fixes itself. Nothing here sets or requires an environment variable,
    and the test records the ambient thread count in its failure message so a future breach
    is diagnosable rather than mysterious.

    ### Clip effects are part of this property, not a separate one

    Requirement 29.31 puts an ``Effect_Chain`` on a clip, and a chain changes the samples exactly
    as a gain does — so "동일 `Timeline_Project`와 동일 렌더링 파라미터" includes the clips'
    chains, and the reproducibility claim is *about* a mix that contains them. Task 4.3's
    acceptance criterion asks for "클립 이펙트 포함 믹스다운 결과 재현성 3회 확인", and that is
    :meth:`test_three_renders_with_clip_effects_are_sample_identical` below: the same three-render
    comparison with an ``effect_processor`` supplied.

    It is **an extension of Property 13, not a new numbered property**. Design §10 numbers
    Properties 1–24 and ``tasks.md`` §9.2 assigns Property 13 to task 4.2 and Property 14 (effect
    processing reproducibility, Requirement 29.29) to task 3.2; task 4.3 owns no number at all, so
    inventing one would be a change to §10 that is not task 4.3's to make and would break §9.2's
    audit. The clause the extended case validates is still 28.27 — it is the same invariant over a
    project whose clips happen to carry chains.

    The case is worth having because clip effects are the one thing that could break
    reproducibility for a reason unrelated to summation: ``pedalboard``'s delay lines, reverb tanks
    and compressor envelopes are *stateful*, so a board reused between clips or between renders
    would make the second render depend on the first.
    :func:`musicstudio_dsp.effects.apply_chain` builds a fresh board per call precisely to prevent
    that, and this is where the prevention is checked at the mixdown level.
    """

    #: Requirement 28.27's 3회.
    RUNS = 3

    @given(clips=clip_sets(), tracks=track_maps(), params=render_params())
    @DSP_SETTINGS
    def test_three_renders_are_sample_identical(
        self,
        clips: list[MixdownClip],
        tracks: dict[int, TrackState],
        params: RenderParams,
    ) -> None:
        runs = [render_mixdown(clips, tracks, params) for _ in range(self.RUNS)]

        first = runs[0]
        for later in runs[1:]:
            # "3회 결과의 샘플 개수" — shape.
            assert later.audio.frame_count == first.audio.frame_count
            assert later.audio.channel_count == first.audio.channel_count
            assert later.audio.sample_rate == first.audio.sample_rate
            # "대응하는 모든 샘플 값을 정확히 동일하게" — bit for bit.
            for index, (left, right) in enumerate(zip(first.audio.channels, later.audio.channels)):
                assert np.array_equal(left, right), f"channel {index} differs between renders"
            # The reported quantities are part of the render's result and are compared too:
            # a mix whose samples matched but whose recorded attenuation did not would still
            # store two different assets for one project.
            assert later.attenuation_db == first.attenuation_db
            assert later.peak_before == first.peak_before
            assert later.rendered_clip_ids == first.rendered_clip_ids

    @requires_pedalboard
    @given(clips=clip_sets_with_effects(), tracks=track_maps(), params=render_params())
    @settings(
        max_examples=100,
        deadline=None,
        suppress_health_check=[HealthCheck.too_slow, HealthCheck.data_too_large],
    )
    def test_three_renders_with_clip_effects_are_sample_identical(
        self,
        clips: list[MixdownClip],
        tracks: dict[int, TrackState],
        params: RenderParams,
    ) -> None:
        """Requirement 28.27 over a project whose clips carry Effect_Chains (Requirement 29.31).

        Task 4.3's acceptance criterion: "클립 이펙트 포함 믹스다운 결과 재현성 3회 확인". Still
        Property 13 — see the class docstring on why this is an extension rather than a new number.

        The comparison is the same one: three renders, ``np.array_equal`` on the raw ``float32``
        arrays. The only difference is ``effect_processor``, which routes every chain through
        ``pedalboard``. That is the part that could fail: a reused ``Pedalboard`` would carry one
        clip's delay line into the next clip, and one render's into the next render.
        """
        processor = clip_effect_processor()
        runs = [
            render_mixdown(clips, tracks, params, effect_processor=processor)
            for _ in range(self.RUNS)
        ]

        first = runs[0]
        # The case has to actually contain a chain, or it is asserting nothing about effects.
        # Not every draw will — Requirement 29.31 is a WHERE clause and the generator produces
        # both — so this is recorded rather than assumed.
        wet = [clip for clip in clips if clip.effect_chain]
        assert first.clip_effects_applied == tuple(
            sorted(clip.clip_id for clip in wet)
        ), "the renderer applied a different set of chains than the clips carry"

        for later in runs[1:]:
            assert later.audio.frame_count == first.audio.frame_count
            assert later.audio.channel_count == first.audio.channel_count
            assert later.audio.sample_rate == first.audio.sample_rate
            for index, (left, right) in enumerate(zip(first.audio.channels, later.audio.channels)):
                assert np.array_equal(left, right), (
                    f"channel {index} differs between renders of a project with "
                    f"{len(wet)} effected clip(s)"
                )
            assert later.attenuation_db == first.attenuation_db
            assert later.peak_before == first.peak_before
            assert later.rendered_clip_ids == first.rendered_clip_ids
            assert later.clip_effects_applied == first.clip_effects_applied

    @requires_pedalboard
    @given(clips=clip_sets_with_effects(), tracks=track_maps())
    @settings(
        max_examples=100,
        deadline=None,
        suppress_health_check=[HealthCheck.too_slow, HealthCheck.data_too_large],
    )
    def test_a_fresh_processor_per_render_gives_the_same_result(
        self,
        clips: list[MixdownClip],
        tracks: dict[int, TrackState],
    ) -> None:
        """Requirement 28.27 "다른 렌더링 작업자에서 처리되는 경우에도", for clip effects.

        A second worker builds its own processor. This constructs one per render rather than
        sharing one, which is the closest a single process gets to that, and asserts the results
        are still bit-identical. If ``apply_chain`` ever started caching a board, this is the test
        that would fail — and it is the failure a cross-worker comparison would show.
        """
        runs = [
            render_mixdown(clips, tracks, effect_processor=clip_effect_processor())
            for _ in range(self.RUNS)
        ]
        for later in runs[1:]:
            for index, (left, right) in enumerate(zip(runs[0].audio.channels, later.audio.channels)):
                assert np.array_equal(left, right), f"channel {index} differs across processors"

    @given(clips=clip_sets(), tracks=track_maps())
    @DSP_SETTINGS
    def test_is_bit_exact_under_the_ambient_thread_count(
        self, clips: list[MixdownClip], tracks: dict[int, TrackState]
    ) -> None:
        import os

        ambient = {
            name: os.environ.get(name, "<unset>")
            for name in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS")
        }
        runs = [render_mixdown(clips, tracks) for _ in range(self.RUNS)]
        for later in runs[1:]:
            for left, right in zip(runs[0].audio.channels, later.audio.channels):
                assert np.array_equal(left, right), (
                    "mixdown is not bit-exact under the ambient BLAS thread configuration "
                    f"{ambient}; see this class's docstring"
                )


# --------------------------------------------------------------------------------------
# Requirement 28.29 — the empty render target set
# --------------------------------------------------------------------------------------


class TestEmptyRenderTarget:
    """Requirement 28.29: 렌더링 대상 클립이 0개이면 요청을 거부한다."""

    def test_an_empty_clip_list_is_refused(self) -> None:
        with pytest.raises(EmptyRenderError) as raised:
            render_mixdown([])
        assert raised.value.code == "mixdown_no_render_target"

    def test_the_refusal_precedes_every_other_check(self) -> None:
        # No params, no tracks, no audio — nothing else can be wrong yet, so the refusal
        # cannot be mistaken for a validation failure of something else.
        with pytest.raises(EmptyRenderError):
            render_mixdown([], {}, RenderParams(channels=2))


# --------------------------------------------------------------------------------------
# Requirements 28.24, 28.25 — placement and length
# --------------------------------------------------------------------------------------


class TestLength:
    """Requirement 28.25: the mix runs from 0 to the latest clip end, within 10 ms."""

    def test_length_is_the_latest_clip_end(self) -> None:
        result = render_mixdown(
            [
                clip(clip_id="clip-a", start_time_ms=0, play_length_ms=20),
                clip(clip_id="clip-b", track=1, start_time_ms=100, play_length_ms=20),
            ]
        )
        assert result.requested_length_ms == 120.0
        assert result.length_error_ms <= MIXDOWN_LENGTH_TOLERANCE_MS

    def test_length_ignores_clips_that_are_not_targets(self) -> None:
        # Requirement 28.25's second half. The excluded clip is simply absent from the
        # argument — which is the point of the renderer not deciding membership itself.
        targets = [clip(clip_id="clip-a", start_time_ms=0, play_length_ms=20)]
        assert mixdown_length_ms(targets) == 20.0

        with_late_clip = [
            *targets,
            clip(clip_id="clip-z", track=2, start_time_ms=5_000, play_length_ms=20),
        ]
        assert mixdown_length_ms(with_late_clip) == 5_020.0

    def test_the_mix_starts_at_time_zero(self) -> None:
        # Requirement 28.24: "시각 0에서 시작하도록". A clip at 100 ms leaves the first
        # 100 ms silent rather than being pulled to the front.
        result = render_mixdown(
            [clip(clip_id="clip-a", start_time_ms=100, play_length_ms=20, audio=constant_audio(0.5))]
        )
        head = result.audio.channels[0][: int(0.1 * INTERNAL_SAMPLE_RATE)]
        assert float(np.max(np.abs(head))) == 0.0
        assert result.audio.duration_ms == pytest.approx(120.0, abs=0.05)

    def test_a_long_mix_keeps_the_tolerance(self) -> None:
        # A targeted example rather than a property: five minutes of audio per render is
        # far too slow for 100 draws, and the arithmetic under test is a rounding rule.
        result = render_mixdown(
            [
                clip(clip_id="clip-a", start_time_ms=0, play_length_ms=299_999),
                clip(clip_id="clip-b", track=1, start_time_ms=1, play_length_ms=17),
            ]
        )
        assert result.requested_length_ms == 299_999.0
        assert result.length_error_ms <= MIXDOWN_LENGTH_TOLERANCE_MS

    def test_odd_millisecond_times_stay_inside_one_frame(self) -> None:
        # The rounding case the buffer sizing comment in `render_mixdown` describes:
        # frames(start) + frames(play) can exceed frames(start + play) by one sample.
        result = render_mixdown(
            [clip(clip_id="clip-a", start_time_ms=1, play_length_ms=1)],
            params=RenderParams(channels=1),
        )
        assert result.length_error_ms <= 1000.0 / INTERNAL_SAMPLE_RATE + 1e-9


class TestSummation:
    """Requirements 28.9, 28.24: clips on different tracks sound at once."""

    def test_two_simultaneous_clips_add(self) -> None:
        result = render_mixdown(
            [
                clip(clip_id="clip-a", track=0, audio=constant_audio(0.25)),
                clip(clip_id="clip-b", track=1, audio=constant_audio(0.25)),
            ],
            params=RenderParams(normalise_peak=False),
        )
        assert float(result.audio.channels[0][0]) == pytest.approx(0.5, abs=1e-6)

    def test_clip_gain_is_applied_in_decibels(self) -> None:
        result = render_mixdown(
            [clip(clip_id="clip-a", audio=constant_audio(0.5), gain_db=-6.0)],
            params=RenderParams(normalise_peak=False),
        )
        assert float(result.audio.channels[0][0]) == pytest.approx(0.5 * 10 ** (-6 / 20), abs=1e-6)

    def test_track_volume_is_applied(self) -> None:
        result = render_mixdown(
            [clip(clip_id="clip-a", track=3, audio=constant_audio(0.5))],
            {3: TrackState(volume_db=-6.0)},
            RenderParams(normalise_peak=False),
        )
        assert float(result.audio.channels[0][0]) == pytest.approx(0.5 * 10 ** (-6 / 20), abs=1e-6)

    def test_centre_pan_changes_no_sample(self) -> None:
        # The reason the balance law was chosen over constant power: pan 0 is unity.
        panned = render_mixdown(
            [clip(clip_id="clip-a", audio=constant_audio(0.5))],
            {0: TrackState(pan=0.0)},
            RenderParams(normalise_peak=False),
        )
        unset = render_mixdown(
            [clip(clip_id="clip-a", audio=constant_audio(0.5))],
            params=RenderParams(normalise_peak=False),
        )
        assert np.array_equal(panned.audio.channels[0], unset.audio.channels[0])

    def test_hard_pan_silences_the_other_channel(self) -> None:
        result = render_mixdown(
            [clip(clip_id="clip-a", audio=constant_audio(0.5))],
            {0: TrackState(pan=1.0)},
            RenderParams(normalise_peak=False),
        )
        assert float(np.max(np.abs(result.audio.channels[0]))) == 0.0
        assert float(result.audio.channels[1][0]) == pytest.approx(0.5, abs=1e-6)

    def test_trim_selects_the_interior_of_the_source(self) -> None:
        ramp = AudioBuffer.from_channels(
            INTERNAL_SAMPLE_RATE, [np.linspace(0.0, 1.0, 960, dtype=np.float32)]
        )
        result = render_mixdown(
            [
                clip(
                    clip_id="clip-a",
                    audio=ramp,
                    trim_start_ms=10,
                    trim_end_ms=0,
                    play_length_ms=10,
                )
            ],
            params=RenderParams(channels=1, normalise_peak=False),
        )
        # The first 10 ms are dropped, so the mix opens at the middle of the ramp.
        assert float(result.audio.channels[0][0]) == pytest.approx(0.5, abs=0.01)

    def test_mono_source_is_duplicated_into_a_stereo_render(self) -> None:
        result = render_mixdown(
            [clip(clip_id="clip-a", audio=constant_audio(0.5, channels=1))],
            params=RenderParams(channels=2, normalise_peak=False),
        )
        assert np.array_equal(result.audio.channels[0], result.audio.channels[1])

    def test_stereo_source_is_averaged_into_a_mono_render(self) -> None:
        stereo = AudioBuffer.from_channels(
            INTERNAL_SAMPLE_RATE,
            [np.full(960, 0.4, dtype=np.float32), np.full(960, 0.2, dtype=np.float32)],
        )
        result = render_mixdown(
            [clip(clip_id="clip-a", audio=stereo)],
            params=RenderParams(channels=1, normalise_peak=False),
        )
        assert float(result.audio.channels[0][0]) == pytest.approx(0.3, abs=1e-6)


class TestFades:
    """Requirement 28.17's fades, and design §5.6 step 5's linearity."""

    def test_fade_in_starts_at_silence_and_reaches_unity(self) -> None:
        result = render_mixdown(
            [clip(clip_id="clip-a", audio=constant_audio(0.5), fade_in_ms=10)],
            params=RenderParams(channels=1, normalise_peak=False),
        )
        samples = result.audio.channels[0]
        assert float(samples[0]) == 0.0
        assert float(samples[-1]) == pytest.approx(0.5, abs=1e-6)

    def test_fade_out_ends_at_silence(self) -> None:
        result = render_mixdown(
            [clip(clip_id="clip-a", audio=constant_audio(0.5), fade_out_ms=10)],
            params=RenderParams(channels=1, normalise_peak=False),
        )
        samples = result.audio.channels[0]
        assert float(samples[0]) == pytest.approx(0.5, abs=1e-6)
        assert float(samples[-1]) == 0.0

    def test_a_linear_fade_is_half_way_at_its_midpoint(self) -> None:
        result = render_mixdown(
            [clip(clip_id="clip-a", audio=constant_audio(1.0), fade_in_ms=10)],
            params=RenderParams(channels=1, normalise_peak=False),
        )
        midpoint = result.audio.channels[0][int(0.005 * INTERNAL_SAMPLE_RATE)]
        assert float(midpoint) == pytest.approx(0.5, abs=0.01)


# --------------------------------------------------------------------------------------
# Requirements 28.24, 28.28 — peak normalisation
# --------------------------------------------------------------------------------------


class TestPeakNormalisation:
    """Requirement 28.24's untouched case and 28.28's single-coefficient attenuation."""

    def test_a_peak_at_or_below_one_changes_nothing(self) -> None:
        verdict = peak_normalisation(1.0)
        assert verdict.applied is False
        assert verdict.coefficient == 1.0
        # 28.24: "샘플 값을 변경하지 않고 감쇠량 0데시벨로 기록".
        assert verdict.attenuation_db == 0.0

    def test_samples_are_untouched_when_the_mix_fits(self) -> None:
        source = constant_audio(0.5)
        result = render_mixdown([clip(clip_id="clip-a", audio=source)])
        assert result.attenuation_db == 0.0
        assert np.array_equal(result.audio.channels[0], source.channels[0])

    def test_an_overshoot_is_brought_into_the_window(self) -> None:
        # Two full-scale clips on different tracks sum to 2.0.
        result = render_mixdown(
            [
                clip(clip_id="clip-a", track=0, audio=constant_audio(1.0)),
                clip(clip_id="clip-b", track=1, audio=constant_audio(1.0)),
            ]
        )
        assert result.peak_before == pytest.approx(2.0, abs=1e-6)
        assert NORMALISED_PEAK_MIN <= result.peak_after <= NORMALISED_PEAK_MAX
        assert result.peak_after == pytest.approx(NORMALISATION_TARGET_PEAK, abs=1e-3)
        # 28.28: 0 dB 초과 40 dB 이하.
        assert 0.0 < result.attenuation_db <= ATTENUATION_DB_MAX
        assert result.normalisation.within_reportable_range is True

    def test_the_coefficient_is_single_and_uniform(self) -> None:
        # 28.28: "모든 샘플에 동일한 단일 감쇠 계수". Two different levels keep their ratio.
        loud = AudioBuffer.from_channels(
            INTERNAL_SAMPLE_RATE,
            [np.concatenate([np.full(480, 2.0), np.full(480, 0.5)]).astype(np.float32)],
        )
        result = render_mixdown(
            [clip(clip_id="clip-a", audio=loud)], params=RenderParams(channels=1)
        )
        samples = result.audio.channels[0]
        assert float(samples[0]) / float(samples[-1]) == pytest.approx(4.0, abs=1e-3)

    def test_normalisation_can_be_switched_off(self) -> None:
        # Requirement 28.27 lists 피크 정규화 활성 여부 as a render parameter.
        result = render_mixdown(
            [
                clip(clip_id="clip-a", track=0, audio=constant_audio(1.0)),
                clip(clip_id="clip-b", track=1, audio=constant_audio(1.0)),
            ],
            params=RenderParams(normalise_peak=False),
        )
        assert result.peak_after == pytest.approx(2.0, abs=1e-6)
        assert result.attenuation_db == 0.0

    def test_an_attenuation_beyond_forty_decibels_is_flagged_not_clamped(self) -> None:
        """Requirement 28.28's two halves conflict for a loud enough mix.

        40 dB is a factor of 100, so a summed peak above 99.5 cannot be brought into
        [0.99, 1.0] *and* reported as ≤40 dB. That is reachable inside Requirement 28's own
        bounds. The amplitude window wins — it is the obligation about the audio — and the
        dB figure is reported with a flag saying it left the range the clause anticipated.
        See the task 4.2 report; this is an open question for the spec, not a decision the
        implementation should have made silently.
        """
        verdict = peak_normalisation(500.0)
        assert verdict.applied is True
        assert verdict.attenuation_db > ATTENUATION_DB_MAX
        assert verdict.within_reportable_range is False
        # The window is still met.
        assert NORMALISED_PEAK_MIN <= 500.0 * verdict.coefficient <= NORMALISED_PEAK_MAX

    def test_a_peak_just_over_one_attenuates_by_more_than_zero(self) -> None:
        verdict = peak_normalisation(1.000001)
        assert verdict.applied is True
        assert verdict.attenuation_db > 0.0

    def test_a_non_finite_peak_is_refused(self) -> None:
        with pytest.raises(MixdownError):
            peak_normalisation(math.nan)


# --------------------------------------------------------------------------------------
# Rejections
# --------------------------------------------------------------------------------------


class TestRejections:
    def test_a_sample_rate_mismatch_is_refused(self) -> None:
        odd = source_audio(frames=480, sample_rate=44_100)
        with pytest.raises(MixdownError) as raised:
            render_mixdown([clip(clip_id="clip-a", audio=odd)])
        assert raised.value.code == "mixdown_sample_rate_mismatch"

    def test_an_unsupported_output_channel_count_is_refused(self) -> None:
        with pytest.raises(MixdownError) as raised:
            render_mixdown([clip()], params=RenderParams(channels=3))
        assert raised.value.code == "mixdown_channel_count_unsupported"

    def test_a_negative_start_time_is_refused(self) -> None:
        with pytest.raises(MixdownError) as raised:
            render_mixdown([clip(start_time_ms=-1)])
        assert raised.value.code == "mixdown_clip_start_time_invalid"

    def test_a_clip_effect_chain_without_a_processor_is_refused(self) -> None:
        # The wired-but-inert slot of design §5.6 step 3. Dropping the chain silently would
        # produce a mix that looks finished and is missing the user's edits.
        with pytest.raises(MixdownError) as raised:
            render_mixdown([clip(effect_chain=({"kind": "gain", "parameters": {}},))])
        assert raised.value.code == "mixdown_clip_effects_unsupported"

    def test_a_supplied_processor_is_used_and_its_output_truncated(self) -> None:
        seen: list[int] = []

        def processor(audio: AudioBuffer, chain: object) -> AudioBuffer:
            seen.append(len(tuple(chain)))  # type: ignore[arg-type]
            # Lengthen, as a delay or reverb tail would, to show the truncation happens.
            padded = [
                np.concatenate([channel, np.zeros(4_800, dtype=np.float32)])
                for channel in audio.channels
            ]
            return AudioBuffer.from_channels(audio.sample_rate, padded)

        result = render_mixdown(
            [clip(effect_chain=({"kind": "gain", "parameters": {}},), play_length_ms=20)],
            params=RenderParams(channels=2),
            effect_processor=processor,
        )
        assert seen == [1]
        # Truncated back to the play length (design §5.6 step 3, §6.3).
        assert result.audio.duration_ms == pytest.approx(20.0, abs=0.05)


# --------------------------------------------------------------------------------------
# Unnumbered property tests. Design §10 assigns these no number; task 9.2's audit must
# not count them against Properties 12 or 13.
# --------------------------------------------------------------------------------------


class TestLengthPropertiesUnnumbered:
    """Requirement 28.25 over generated clip sets — unnumbered."""

    @given(clips=clip_sets(), params=render_params())
    @DSP_SETTINGS
    def test_produced_length_stays_within_the_tolerance(
        self, clips: list[MixdownClip], params: RenderParams
    ) -> None:
        result = render_mixdown(clips, None, params)
        assert not (result.length_error_ms > MIXDOWN_LENGTH_TOLERANCE_MS), (
            f"length error {result.length_error_ms} ms exceeds {MIXDOWN_LENGTH_TOLERANCE_MS} ms"
        )

    @given(clips=clip_sets(), params=render_params())
    @DSP_SETTINGS
    def test_the_normalised_peak_never_exceeds_the_ceiling(
        self, clips: list[MixdownClip], params: RenderParams
    ) -> None:
        result = render_mixdown(clips, None, RenderParams(channels=params.channels))
        assert result.peak_after <= NORMALISED_PEAK_MAX + 1e-6
        if result.normalisation.applied:
            assert result.peak_after >= NORMALISED_PEAK_MIN - 1e-6
