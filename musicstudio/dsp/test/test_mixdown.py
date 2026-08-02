"""Mixdown_Renderer — Requirements 28.24-28.29, design §6.1-§6.3.

Holds task 4.2's two properties (design §10, Properties 12 and 13) alongside the
example-based tests, the way ``test_effects.py`` holds Properties 14 and 24.
"""

from __future__ import annotations

import multiprocessing
import math

import numpy as np
import pytest
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st

from musicstudio_dsp.audio_buffer import AudioBuffer
from musicstudio_dsp.effects import pedalboard_available
from musicstudio_dsp.mixdown import (
    PEAK_TARGET,
    RenderParams,
    TrackRender,
    mixdown_frame_count,
    render_mixdown,
)
from musicstudio_dsp.mixdown_clip import ClipRender, MixdownError, ms_to_frames

SAMPLE_RATE = 48_000

# Summation is elementwise and cheap, but a property that renders several clips a
# hundred times still outruns hypothesis's default deadline on a loaded machine.
# Disabled rather than raised, for the reason given in ``test_effects.py``.
MIX_SETTINGS = settings(
    max_examples=100,
    deadline=None,
    suppress_health_check=[HealthCheck.too_slow, HealthCheck.data_too_large],
)


def tone(frames: int, freq: float = 440.0, amplitude: float = 0.25, channels: int = 1) -> AudioBuffer:
    """A deterministic test signal. No RNG: Requirement 28.27 is about reproducibility."""
    t = np.arange(frames, dtype=np.float64) / SAMPLE_RATE
    wave = amplitude * np.sin(2.0 * math.pi * freq * t)
    return AudioBuffer.from_channels(SAMPLE_RATE, [wave for _ in range(channels)])


def clip(clip_id: str, *, frames: int = SAMPLE_RATE // 10, **kwargs: object) -> ClipRender:
    freq = float(400 + 37 * (sum(ord(c) for c in clip_id) % 12))
    return ClipRender(clip_id=clip_id, audio=tone(frames, freq), **kwargs)  # type: ignore[arg-type]


# --------------------------------------------------------------------------------------
# Requirement 28.29 — nothing to render
# --------------------------------------------------------------------------------------


class TestEmptyRenderTarget:
    def test_rejects_an_empty_clip_list_with_a_reason_code(self) -> None:
        with pytest.raises(MixdownError) as caught:
            render_mixdown([])
        assert caught.value.reason == "no_render_target"

    def test_rejects_when_every_clip_would_land_outside_the_mix(self) -> None:
        # A clip whose play length rounds to nothing leaves the mix with zero frames.
        empty = ClipRender(
            clip_id="a", audio=tone(10), start_time_ms=0, track=0, trim_start_ms=1_000
        )
        with pytest.raises(MixdownError) as caught:
            render_mixdown([empty])
        assert caught.value.reason in {"no_render_target", "clip_play_length_empty"}


# --------------------------------------------------------------------------------------
# Requirement 28.25 — length
# --------------------------------------------------------------------------------------


class TestMixdownLength:
    def test_runs_from_zero_to_the_latest_clip_end(self) -> None:
        first = clip("a", start_time_ms=0, track=0, frames=SAMPLE_RATE // 2)  # 0-500 ms
        second = clip("b", start_time_ms=250, track=1, frames=SAMPLE_RATE // 2)  # 250-750
        result = render_mixdown([first, second])

        expected_ms = 750.0
        assert result.audio.frame_count == ms_to_frames(SAMPLE_RATE, expected_ms)
        assert abs(result.audio.duration_ms - expected_ms) <= 10.0

    def test_a_clip_starting_at_a_later_time_extends_the_mix(self) -> None:
        late = clip("z", start_time_ms=5_000, track=3, frames=SAMPLE_RATE // 10)
        result = render_mixdown([clip("a", start_time_ms=0, track=0), late])
        assert abs(result.audio.duration_ms - 5_100.0) <= 10.0

    def test_trim_shortens_the_contribution_to_the_length(self) -> None:
        # 1000 ms asset, 200 ms off the front and 300 off the back -> 500 ms of play.
        trimmed = ClipRender(
            clip_id="a",
            audio=tone(SAMPLE_RATE),
            start_time_ms=0,
            track=0,
            trim_start_ms=200,
            trim_end_ms=300,
        )
        assert mixdown_frame_count([trimmed], SAMPLE_RATE) == ms_to_frames(SAMPLE_RATE, 500)
        assert abs(render_mixdown([trimmed]).audio.duration_ms - 500.0) <= 10.0

    def test_excluded_clips_are_simply_absent(self) -> None:
        """28.25's "렌더링 대상에서 제외된 클립을 포함하지 않는다".

        Exclusion is `render-target.ts`'s decision (task 4.1), so at this seam it shows
        up as a shorter list. The check that matters here is that the renderer's length
        is a function of exactly what it was handed.
        """
        kept = clip("a", start_time_ms=0, track=0, frames=SAMPLE_RATE // 10)
        dropped = clip("b", start_time_ms=9_000, track=1, frames=SAMPLE_RATE)
        assert render_mixdown([kept]).audio.frame_count < render_mixdown(
            [kept, dropped]
        ).audio.frame_count


# --------------------------------------------------------------------------------------
# Requirements 28.24, 28.28 — peak normalisation
# --------------------------------------------------------------------------------------


class TestPeakNormalisation:
    def test_leaves_samples_untouched_and_reports_zero_db_when_it_fits(self) -> None:
        quiet = ClipRender(clip_id="a", audio=tone(1_000, amplitude=0.25), start_time_ms=0, track=0)
        result = render_mixdown([quiet])

        assert result.attenuation_db == 0.0
        assert result.peak_before <= 1.0
        # 28.24: "샘플 값을 변경하지 않고" — the clip's own samples, spread to stereo.
        np.testing.assert_array_equal(
            result.audio.channels[0], quiet.audio.channels[0].astype(np.float32)
        )

    def test_scales_by_one_factor_and_reports_the_attenuation(self) -> None:
        loud = [
            ClipRender(clip_id=f"c{i}", audio=tone(1_000, amplitude=0.9), start_time_ms=0, track=i)
            for i in range(4)
        ]
        result = render_mixdown(loud)

        assert result.peak_before > 1.0
        # 28.28: normalised peak in [0.99, 1.0].
        assert 0.99 <= result.peak_after <= 1.0
        # 28.28: attenuation reported, above zero.
        assert result.attenuation_db > 0.0
        assert result.attenuation_db <= 40.0
        # One single factor for every sample: the ratio is constant across the buffer.
        expected = PEAK_TARGET / result.peak_before
        assert math.isclose(
            result.attenuation_db, -20.0 * math.log10(expected), rel_tol=1e-9
        )

    def test_normalisation_can_be_switched_off(self) -> None:
        """28.27 lists 피크 정규화 활성 여부 as a render parameter, so it has to be one."""
        loud = [
            ClipRender(clip_id=f"c{i}", audio=tone(1_000, amplitude=0.9), start_time_ms=0, track=i)
            for i in range(4)
        ]
        result = render_mixdown(loud, params=RenderParams(peak_normalise=False))

        assert result.attenuation_db == 0.0
        assert result.peak_after > 1.0


# --------------------------------------------------------------------------------------
# The clip chain — design §5.6, §6.3
# --------------------------------------------------------------------------------------


class TestClipChain:
    def test_gain_scales_the_placed_signal(self) -> None:
        plain = render_mixdown([clip("a", start_time_ms=0, track=0, frames=1_000)])
        loud = render_mixdown([clip("a", start_time_ms=0, track=0, frames=1_000, gain_db=6.0)])
        ratio = float(np.max(np.abs(loud.audio.channels[0]))) / float(
            np.max(np.abs(plain.audio.channels[0]))
        )
        assert math.isclose(ratio, 10.0 ** (6.0 / 20.0), rel_tol=1e-4)

    def test_a_fade_in_starts_at_silence_and_a_fade_out_ends_at_silence(self) -> None:
        faded = clip(
            "a", start_time_ms=0, track=0, frames=SAMPLE_RATE // 5, fade_in_ms=50, fade_out_ms=50
        )
        channel = render_mixdown([faded]).audio.channels[0]

        assert channel[0] == 0.0
        assert abs(float(channel[-1])) < 1e-6

    def test_a_clip_is_placed_at_its_start_time(self) -> None:
        late = clip("a", start_time_ms=100, track=0, frames=1_000)
        channel = render_mixdown([late]).audio.channels[0]
        silent_frames = ms_to_frames(SAMPLE_RATE, 100)

        assert np.all(channel[:silent_frames] == 0.0)
        assert float(np.max(np.abs(channel[silent_frames:]))) > 0.0

    def test_a_mono_clip_reaches_both_output_channels(self) -> None:
        result = render_mixdown([clip("a", start_time_ms=0, track=0, frames=500)])
        assert result.audio.channel_count == 2
        np.testing.assert_array_equal(result.audio.channels[0], result.audio.channels[1])

    def test_a_stereo_clip_folds_down_for_a_mono_mixdown(self) -> None:
        stereo = ClipRender(
            clip_id="a", audio=tone(500, channels=2), start_time_ms=0, track=0
        )
        result = render_mixdown([stereo], params=RenderParams(channels=1))
        assert result.audio.channel_count == 1

    def test_refuses_a_clip_stored_at_another_sample_rate(self) -> None:
        odd = ClipRender(
            clip_id="a",
            audio=AudioBuffer.from_channels(44_100, [np.zeros(100, dtype=np.float32)]),
            start_time_ms=0,
            track=0,
        )
        with pytest.raises(MixdownError) as caught:
            render_mixdown([odd])
        assert caught.value.reason == "clip_sample_rate_mismatch"


# --------------------------------------------------------------------------------------
# Track volume and pan
# --------------------------------------------------------------------------------------


class TestTrackSettings:
    def test_track_volume_scales_every_clip_on_the_track(self) -> None:
        clips = [clip("a", start_time_ms=0, track=2, frames=1_000)]
        plain = render_mixdown(clips)
        quiet = render_mixdown(clips, tracks={2: TrackRender(volume_db=-6.0)})

        ratio = float(np.max(np.abs(quiet.audio.channels[0]))) / float(
            np.max(np.abs(plain.audio.channels[0]))
        )
        assert math.isclose(ratio, 10.0 ** (-6.0 / 20.0), rel_tol=1e-4)

    def test_centre_pan_is_exactly_an_identity(self) -> None:
        """The reason the law is normalised — see ``_apply_pan``'s docstring."""
        clips = [clip("a", start_time_ms=0, track=0, frames=1_000)]
        without = render_mixdown(clips)
        centred = render_mixdown(clips, tracks={0: TrackRender(pan=0.0)})

        for left, right in zip(without.audio.channels, centred.audio.channels):
            assert np.array_equal(left, right)

    def test_hard_pan_silences_the_far_channel(self) -> None:
        clips = [clip("a", start_time_ms=0, track=0, frames=1_000)]
        left = render_mixdown(clips, tracks={0: TrackRender(pan=-1.0)})

        assert float(np.max(np.abs(left.audio.channels[0]))) > 0.0
        assert float(np.max(np.abs(left.audio.channels[1]))) < 1e-6

    def test_pan_holds_power_constant_across_the_sweep(self) -> None:
        clips = [clip("a", start_time_ms=0, track=0, frames=2_000)]
        powers = []
        for pan in (-1.0, -0.5, 0.0, 0.5, 1.0):
            result = render_mixdown(clips, tracks={0: TrackRender(pan=pan)})
            powers.append(sum(float(np.sum(c.astype(np.float64) ** 2)) for c in result.audio.channels))

        assert max(powers) - min(powers) <= max(powers) * 1e-6

    def test_pan_is_ignored_for_a_mono_mixdown(self) -> None:
        clips = [clip("a", start_time_ms=0, track=0, frames=800)]
        mono = RenderParams(channels=1)
        centred = render_mixdown(clips, params=mono)
        panned = render_mixdown(clips, tracks={0: TrackRender(pan=1.0)}, params=mono)
        assert np.array_equal(centred.audio.channels[0], panned.audio.channels[0])


# --------------------------------------------------------------------------------------
# Design §10, Property 12 — Requirement 28.26
# --------------------------------------------------------------------------------------


TRACKS_IN_PLAY = 3


def clip_sets(min_size: int = 3, max_size: int = 8) -> st.SearchStrategy[list[ClipRender]]:
    """Clip sets with explicit start times, **crowded onto few tracks**.

    Tracks are drawn from a range narrower than the clip count, so several clips land on
    one track and overlap there. That is deliberate and it is what gives the property
    its teeth: with one clip per track, every clip owns its accumulator, the tracks are
    summed in index order, and Requirement 28.26 holds no matter what the renderer does
    with the clip order — the property would pass against a renderer that had thrown the
    ordering rule away. Crowding the tracks puts three or more addends into one buffer,
    which is the only place a summation order can be observed at all.

    Requirement 28.12 forbids two clips overlapping on the *same* track, so the service
    will not send this. The renderer is asked for the invariant regardless: 28.26 is
    stated over the renderer's inputs, not over the subset of them the service happens
    to produce, and an invariant that holds only because some other component filters
    the input is not one this module can be said to have.
    """

    @st.composite
    def build(draw: st.DrawFn) -> list[ClipRender]:
        size = draw(st.integers(min_value=min_size, max_value=max_size))
        clips = []
        for index in range(size):
            clips.append(
                ClipRender(
                    clip_id=f"clip-{index:02d}",
                    audio=tone(
                        draw(st.integers(min_value=400, max_value=4_000)),
                        freq=draw(st.floats(min_value=100.0, max_value=4_000.0)),
                        amplitude=draw(st.floats(min_value=0.05, max_value=0.5)),
                    ),
                    start_time_ms=draw(st.integers(min_value=0, max_value=40)),
                    track=draw(st.integers(min_value=0, max_value=TRACKS_IN_PLAY - 1)),
                    gain_db=draw(st.floats(min_value=-40.0, max_value=12.0)),
                    fade_in_ms=draw(st.integers(min_value=0, max_value=4)),
                    fade_out_ms=draw(st.integers(min_value=0, max_value=4)),
                )
            )
        return clips

    return build()


class TestProperty12MixdownCommutativity:
    """Feature: ai-music-generation-service, Property 12: start_time_ms가 모두 명시적으로
    지정된 동일 클립 집합에 대해, 클립 추가 순서만 다르게 구성된 두 Timeline_Project의
    믹스다운 결과는 샘플 수가 동일하고 모든 대응 샘플 값 차이가 0.0001 이하이다.

    **Validates: Requirements 28.26**

    Asserted at 28.26's stated 0.0001 rather than at bit-exactness. The requirement sets
    the looser bound deliberately — a future renderer that sums in parallel partial
    blocks would still satisfy 28.26 — so testing bit-exactness here would over-constrain
    the implementation against its own specification. Requirement 28.27 is where
    bit-exactness is demanded, and :class:`TestProperty13MixdownReproducibility` asserts
    it there.

    ### What this property actually catches

    Recorded because it is not what one would assume. The renderer holds 28.26 by two
    independent mechanisms, and mutation testing during task 4.2 showed that **either one
    alone is sufficient**, so removing just one leaves the property passing:

    1. *float64 accumulation* (``ACCUMULATOR_DTYPE``). Summing a handful of float32
       clip samples in float64 is exact — the wider mantissa has room for the addition
       to carry no rounding at all — so the sum is associative in practice and the order
       cannot be observed. Narrowing the accumulator to float32 does introduce
       reassociation error, but at ~1e-7 for these signals it stays far inside 28.26's
       1e-4 and the property still passes.
    2. *the clip-identifier sort* in ``_accumulate_tracks``. It maps every input order
       onto one summation order, which holds 28.26 even for an operation that is not
       commutative at all.

    The property fails, as it should, once both are gone: replacing the ``+=`` with an
    overwrite *and* dropping the sort produces a renderer whose output depends on clip
    order, and both tests below then fail on the first few examples. So this is a guard
    against an order-dependent renderer, which is what 28.26 forbids — not a check on
    floating-point associativity, which the accumulator width settles on its own.
    """

    @given(clips=clip_sets())
    @MIX_SETTINGS
    def test_reversing_the_clip_order_changes_nothing(
        self, clips: list[ClipRender]
    ) -> None:
        forward = render_mixdown(clips)
        backward = render_mixdown(list(reversed(clips)))

        assert forward.audio.frame_count == backward.audio.frame_count
        assert forward.audio.channel_count == backward.audio.channel_count
        for index, (left, right) in enumerate(
            zip(forward.audio.channels, backward.audio.channels)
        ):
            deviation = float(np.max(np.abs(left.astype(np.float64) - right.astype(np.float64))))
            assert deviation <= 1e-4, f"channel {index} deviates by {deviation}"

    @given(clips=clip_sets(), seed=st.integers(min_value=0, max_value=2**32 - 1))
    @MIX_SETTINGS
    def test_an_arbitrary_permutation_changes_nothing(
        self, clips: list[ClipRender], seed: int
    ) -> None:
        # A fixed-seed permutation rather than `st.permutations`, so the shuffle is part
        # of the generated case and shrinks with it.
        order = np.random.default_rng(seed).permutation(len(clips))
        shuffled = [clips[index] for index in order]

        reference = render_mixdown(clips)
        permuted = render_mixdown(shuffled)

        assert reference.audio.frame_count == permuted.audio.frame_count
        for left, right in zip(reference.audio.channels, permuted.audio.channels):
            assert float(np.max(np.abs(left.astype(np.float64) - right.astype(np.float64)))) <= 1e-4


# --------------------------------------------------------------------------------------
# Design §10, Property 13 — Requirement 28.27
# --------------------------------------------------------------------------------------


def render_in_this_process(seed: int) -> list[list[float]]:
    """Build a case from ``seed`` and render it. Module level so ``spawn`` can import it."""
    rng = np.random.default_rng(seed)
    clips = [
        ClipRender(
            clip_id=f"clip-{index:02d}",
            audio=tone(
                frames=int(rng.integers(400, 4_000)),
                freq=float(rng.uniform(100.0, 4_000.0)),
                amplitude=float(rng.uniform(0.05, 0.5)),
            ),
            start_time_ms=int(rng.integers(0, 2_000)),
            track=index,
            gain_db=float(rng.uniform(-40.0, 12.0)),
            fade_in_ms=int(rng.integers(0, 5)),
            fade_out_ms=int(rng.integers(0, 5)),
        )
        for index in range(4)
    ]
    tracks = {
        index: TrackRender(
            volume_db=float(rng.uniform(-60.0, 12.0)), pan=float(rng.uniform(-1.0, 1.0))
        )
        for index in range(4)
    }
    result = render_mixdown(clips, tracks=tracks)
    return [channel.tolist() for channel in result.audio.channels]


class TestProperty13MixdownReproducibility:
    """Feature: ai-music-generation-service, Property 13: Timeline_Project와 동일 렌더링
    파라미터에 대해, 3회 믹스다운 결과의 샘플 수와 모든 샘플 값은 정확히 동일하다.

    **Validates: Requirements 28.27**

    Bit-exactness, via ``np.array_equal`` on the ``float32`` arrays — 28.27 says 정확히
    동일, and an approximate comparison would pass for a renderer that had picked up a
    dependence on iteration order or accumulator width.

    ### "다른 렌더링 작업자에서 처리되는 경우에도"

    28.27 extends the guarantee across workers, and a property that renders three times
    in one interpreter cannot observe that. :meth:`test_a_separate_worker_process_agrees`
    renders one of the three in a **spawned** process — a fresh interpreter, its own
    NumPy import, its own thread pool — and compares bit for bit. That is as close to
    28.27's clause as this suite can get without a broker.

    What it still cannot cover is a *differently configured* machine, and design §14
    risk #3 names that as open: the mitigation is the identical container image plus
    ``OMP_NUM_THREADS=1``. As in ``test_effects.py``, none of the arithmetic here is work
    a BLAS backend would thread — placement, scaling and summation are all elementwise —
    so these assertions hold under whatever thread count the process happens to have.
    """

    @given(clips=clip_sets())
    @MIX_SETTINGS
    def test_three_renders_agree_to_the_last_bit(self, clips: list[ClipRender]) -> None:
        params = RenderParams()
        tracks = {index: TrackRender(volume_db=-3.0, pan=0.25) for index in range(len(clips))}

        renders = [render_mixdown(clips, tracks=tracks, params=params) for _ in range(3)]

        first = renders[0]
        for other in renders[1:]:
            assert other.audio.frame_count == first.audio.frame_count
            assert other.audio.channel_count == first.audio.channel_count
            assert other.attenuation_db == first.attenuation_db
            for index, (left, right) in enumerate(
                zip(first.audio.channels, other.audio.channels)
            ):
                assert np.array_equal(left, right), f"channel {index} differs"

    def test_a_separate_worker_process_agrees(self) -> None:
        seed = 20_260_802
        here = render_in_this_process(seed)

        context = multiprocessing.get_context("spawn")
        with context.Pool(processes=1) as pool:
            there = pool.apply(render_in_this_process, (seed,))

        assert len(here) == len(there)
        for index, (left, right) in enumerate(zip(here, there)):
            assert left == right, f"channel {index} differs across processes"


# --------------------------------------------------------------------------------------
# Requirement 29.31 — a clip's own Effect_Chain
# --------------------------------------------------------------------------------------


@pytest.mark.skipif(
    not pedalboard_available(),
    reason="pedalboard is unavailable (native wheel needs libatomic.so.1 from the platform)",
)
class TestClipEffectChain:
    """Task 4.3's clause: the chain is applied to trimmed audio and cut to the play length.

    The cut is design §6.3's, and it is what keeps a delay or reverb tail out of the mix
    while Requirement 29.32 still lets the same chain keep its tail when it is stored as a
    Generation_Version. Both behaviours come from one `apply_chain`; only the mixdown
    truncates, and only here.
    """

    GAIN = [{"kind": "gain", "parameters": {"gain_db": -6.0}}]
    # Every parameter, because `validate_chain` requires a complete map (Requirement 29.9).
    REVERB = [
        {
            "kind": "reverb",
            "parameters": {
                "room_size": 0.8,
                "damping": 0.5,
                "wet_level": 0.5,
                "dry_level": 0.4,
                "width": 1.0,
            },
        }
    ]

    def test_applies_the_chain_to_the_clip(self) -> None:
        plain = render_mixdown([clip("a", start_time_ms=0, track=0, frames=4_800)])
        attenuated = render_mixdown(
            [clip("a", start_time_ms=0, track=0, frames=4_800, effect_chain=self.GAIN)]
        )

        ratio = float(np.max(np.abs(attenuated.audio.channels[0]))) / float(
            np.max(np.abs(plain.audio.channels[0]))
        )
        assert math.isclose(ratio, 10.0 ** (-6.0 / 20.0), rel_tol=1e-3)

    def test_cuts_a_reverb_tail_at_the_play_length(self) -> None:
        """Design §6.3: the tail does not extend the mix."""
        frames = 4_800
        without = render_mixdown([clip("a", start_time_ms=0, track=0, frames=frames)])
        with_tail = render_mixdown(
            [clip("a", start_time_ms=0, track=0, frames=frames, effect_chain=self.REVERB)]
        )

        assert with_tail.audio.frame_count == without.audio.frame_count == frames

    def test_a_chain_does_not_change_the_mixdown_length(self) -> None:
        chained = clip("a", start_time_ms=250, track=0, frames=4_800, effect_chain=self.REVERB)
        assert render_mixdown([chained]).audio.frame_count == mixdown_frame_count(
            [chained], SAMPLE_RATE
        )

    def test_three_renders_with_clip_effects_agree_to_the_last_bit(self) -> None:
        """Task 4.3's acceptance criterion, and Requirement 28.27 with a chain in play.

        `apply_chain` builds a fresh `Pedalboard` per call precisely so that a stateful
        effect cannot carry a delay line from one render into the next; this asserts that
        holds when the chain is reached through the mixdown rather than directly.
        """
        clips = [
            clip("a", start_time_ms=0, track=0, frames=4_800, effect_chain=self.REVERB),
            clip("b", start_time_ms=100, track=1, frames=4_800, effect_chain=self.GAIN),
        ]
        tracks = {0: TrackRender(volume_db=-3.0, pan=-0.4), 1: TrackRender(pan=0.6)}

        renders = [render_mixdown(clips, tracks=tracks) for _ in range(3)]

        first = renders[0]
        for other in renders[1:]:
            assert other.audio.frame_count == first.audio.frame_count
            assert other.attenuation_db == first.attenuation_db
            for index, (left, right) in enumerate(
                zip(first.audio.channels, other.audio.channels)
            ):
                assert np.array_equal(left, right), f"channel {index} differs"
