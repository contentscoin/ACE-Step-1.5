"""Clip effects inside a mixdown, and the tail policy (Requirements 29.31, 29.32; design §6.3).

Example-based, and **numbered nothing**. Task 4.3 owns no design §10 Property — ``tasks.md``
§9.2's ownership table has no 4.3 row — so the reproducibility evidence its acceptance criterion
asks for is an extension of Property 13 in ``test_mixdown.py``, and everything here is a unit
test. Requirement 29.29's effect reproducibility (Property 14) and 29.30's length preservation
(Property 24) are task 3.2's, in ``test_effects.py``, and are not restated.

What these establish is the thing that only exists once the two modules are joined: that a delay
or reverb tail produced *inside a mixdown* does not survive, that it survives for an independent
version, and that a chain reaching a renderer with no processor is refused rather than dropped.
"""

from __future__ import annotations

from typing import Any

import numpy as np
import pytest

from musicstudio_dsp.audio_buffer import AudioBuffer
from musicstudio_dsp.clip_effects import (
    MIXDOWN_TAIL_PRESERVED,
    chain_needs_tail_room,
    clip_effect_processor,
    mixdown_tail_ceiling_ms,
    tail_allowance_ms,
    version_tail_ceiling_ms,
)
from musicstudio_dsp.effects import apply_chain, pedalboard_available, registry
from musicstudio_dsp.mixdown import (
    MixdownClip,
    MixdownError,
    RenderParams,
    TrackState,
    render_mixdown,
)
from musicstudio_dsp.resample import INTERNAL_SAMPLE_RATE

#: The same guard ``test_effects.py`` uses, for the same reason. ``pedalboard`` is a default
#: dependency (dsp/pyproject.toml) but a *native* wheel linking ``libatomic.so.1`` from the
#: platform, so on a host without that library a skip with a stated reason is more honest than
#: a hard failure. Applied per test rather than to the module: the two ceilings of Requirement
#: 29.32, the registry's ``extends_tail`` flags, the refusal of a chain with no processor and
#: the chain validation are all arithmetic and metadata, and must keep running everywhere.
requires_pedalboard = pytest.mark.skipif(
    not pedalboard_available(),
    reason="pedalboard is unavailable (native wheel needs libatomic.so.1 from the platform)",
)

#: A chain with a long, loud tail, so the truncation is unmistakable in the samples.
REVERB: tuple[dict[str, Any], ...] = (
    {
        "kind": "reverb",
        "parameters": {
            "room_size": 1.0,
            "damping": 0.0,
            "wet_level": 1.0,
            "dry_level": 0.0,
            "width": 1.0,
        },
    },
)

DELAY: tuple[dict[str, Any], ...] = (
    {"kind": "delay", "parameters": {"delay_seconds": 0.25, "feedback": 0.9, "mix": 0.7}},
)

GAIN: tuple[dict[str, Any], ...] = (
    {"kind": "gain", "parameters": {"gain_db": 6.0}},
)


def peak_of(audio: AudioBuffer) -> float:
    """Largest absolute sample. ``AudioBuffer`` exposes no peak, so it is computed here."""
    return float(max(float(np.max(np.abs(channel))) for channel in audio.channels))


def burst(ms: int = 200, channels: int = 2, seed: int = 7) -> AudioBuffer:
    """Loud broadband audio, so a reverb has something to ring on from."""
    rng = np.random.default_rng(seed)
    frames = int(ms * INTERNAL_SAMPLE_RATE / 1000)
    return AudioBuffer.from_channels(
        INTERNAL_SAMPLE_RATE,
        [(rng.standard_normal(frames) * 0.5).astype(np.float32) for _ in range(channels)],
    )


def wet_clip(chain: tuple[dict[str, Any], ...], play_length_ms: int = 200, **overrides: Any):
    base: dict[str, Any] = {
        "clip_id": "clip-a",
        "track": 0,
        "audio": burst(play_length_ms),
        "start_time_ms": 0,
        "play_length_ms": play_length_ms,
        "effect_chain": chain,
    }
    base.update(overrides)
    return MixdownClip(**base)


class TestTheTwoCeilings:
    """Design §6.3's two destinations, and the one number that separates them."""

    def test_a_mixdown_cuts_at_the_play_length(self) -> None:
        assert mixdown_tail_ceiling_ms(4_000) == 4_000

    def test_a_version_keeps_the_tail_up_to_ten_seconds(self) -> None:
        assert version_tail_ceiling_ms(4_000) == 4_000 + 10_000

    def test_the_allowance_comes_from_the_registry(self) -> None:
        # One declaration on this side (``effect_registry.json``), mirrored by
        # ``domain/effects/registry.ts`` with a bidirectional parity test.
        assert tail_allowance_ms() == registry().tail_allowance_ms == 10_000

    def test_a_mixdown_preserves_no_tail_and_says_so(self) -> None:
        assert MIXDOWN_TAIL_PRESERVED is False

    def test_the_difference_between_the_ceilings_is_exactly_the_allowance(self) -> None:
        for length in (0, 1, 4_000, 3_600_000):
            assert (
                version_tail_ceiling_ms(length) - mixdown_tail_ceiling_ms(length)
                == tail_allowance_ms()
            )


class TestWhichChainsRing:
    """Requirements 29.30, 29.32: delay and reverb, and no others."""

    def test_reverb_and_delay_need_tail_room(self) -> None:
        assert chain_needs_tail_room(REVERB) is True
        assert chain_needs_tail_room(DELAY) is True

    def test_the_other_six_do_not(self) -> None:
        assert chain_needs_tail_room(GAIN) is False

    def test_a_mixed_chain_needs_room_if_any_item_does(self) -> None:
        assert chain_needs_tail_room(GAIN + DELAY) is True

    def test_the_registry_flags_exactly_two_kinds(self) -> None:
        extending = sorted(
            kind for kind, definition in registry().effects.items() if definition.extends_tail
        )
        assert extending == ["delay", "reverb"]


class TestTheProcessorItself:
    """:func:`clip_effect_processor` — the seam's shape, and what it deliberately does not do."""

    @requires_pedalboard
    def test_it_applies_the_chain(self) -> None:
        processor = clip_effect_processor()
        audio = burst(100)
        processed = processor(audio, GAIN)
        # +6 dB is a factor of 1.995, so the peak must have grown by about that.
        assert peak_of(processed) == pytest.approx(peak_of(audio) * 1.9953, rel=1e-3)

    @requires_pedalboard
    def test_it_does_not_truncate_the_tail(self) -> None:
        # The cut belongs to ``mixdown.py`` step 4, which runs for clips with no chain too. A
        # processor that also cut would be a second copy of Requirement 28.13's arithmetic.
        processor = clip_effect_processor()
        audio = burst(200)
        processed = processor(audio, REVERB)
        assert processed.frame_count > audio.frame_count

    @requires_pedalboard
    def test_it_caps_the_tail_at_the_allowance_the_way_apply_chain_does(self) -> None:
        # Requirement 29.32's ceiling is ``apply_chain``'s, and the processor inherits it rather
        # than reimplementing it — so the two agree by construction.
        audio = burst(200)
        direct = apply_chain(audio, REVERB)
        through_processor = clip_effect_processor()(audio, REVERB)
        assert through_processor.frame_count == direct.audio.frame_count
        assert through_processor.duration_ms <= version_tail_ceiling_ms(audio.duration_ms)

    def test_it_validates_the_chain(self) -> None:
        # Requirements 29.9, 29.10 through ``apply_chain``. The worker accepts whatever is on the
        # queue, so it checks rather than trusting the product layer's check.
        with pytest.raises(Exception):
            clip_effect_processor()(burst(50), ({"kind": "reverb", "parameters": {}},))

    @requires_pedalboard
    def test_two_calls_give_identical_samples(self) -> None:
        # Requirement 29.29's reproducibility, at this seam: a fresh ``Pedalboard`` per call.
        processor = clip_effect_processor()
        audio = burst(150)
        first = processor(audio, DELAY)
        second = processor(audio, DELAY)
        for left, right in zip(first.channels, second.channels):
            assert np.array_equal(left, right)


@requires_pedalboard
class TestTailTruncationInsideAMixdown:
    """Requirement 29.31 and design §6.3: no tail survives a mix.

    Every test here renders a real tail through ``pedalboard``, so the guard is class-wide.
    """

    def test_a_reverb_clip_occupies_exactly_its_play_length(self) -> None:
        clip = wet_clip(REVERB, play_length_ms=200)
        result = render_mixdown([clip], None, None, effect_processor=clip_effect_processor())

        # Requirement 28.25: the mix is as long as the latest clip end, and the clip's end is its
        # play length — not its play length plus a reverb tail.
        assert result.audio.frame_count == int(200 * INTERNAL_SAMPLE_RATE / 1000)
        assert result.duration_ms == pytest.approx(200.0)

    def test_a_delay_clip_does_the_same(self) -> None:
        # 250 ms of delay with 0.9 feedback would otherwise ring on for seconds.
        clip = wet_clip(DELAY, play_length_ms=200)
        result = render_mixdown([clip], None, None, effect_processor=clip_effect_processor())
        assert result.duration_ms == pytest.approx(200.0)

    def test_the_mix_is_no_longer_than_the_same_project_rendered_dry(self) -> None:
        wet = wet_clip(REVERB, play_length_ms=200)
        dry = wet_clip((), play_length_ms=200)

        wet_result = render_mixdown([wet], None, None, effect_processor=clip_effect_processor())
        dry_result = render_mixdown([dry], None, None)

        assert wet_result.audio.frame_count == dry_result.audio.frame_count

    def test_the_tail_does_not_bleed_over_the_next_clip(self) -> None:
        # The reason the cut exists, stated as audio: a clip placed after a reverb clip must not
        # have the reverb underneath it. Rendered twice — once with the reverb clip, once with it
        # replaced by silence-length-equivalent dry audio — and compared where only the second
        # clip sounds.
        reverb_clip = wet_clip(REVERB, clip_id="clip-a", play_length_ms=200, start_time_ms=0)
        later = MixdownClip(
            clip_id="clip-b",
            track=1,
            audio=burst(100, seed=21),
            start_time_ms=400,
            play_length_ms=100,
        )

        # Normalisation off in both renders. Requirement 28.28's coefficient is derived from the
        # *whole* mix's peak, and the reverb clip raises it — so with normalisation on, the later
        # clip's samples would differ between the two renders by that coefficient and the
        # comparison would fail for a reason that has nothing to do with a tail.
        dry_params = RenderParams(normalise_peak=False)
        with_reverb = render_mixdown(
            [reverb_clip, later], None, dry_params, effect_processor=clip_effect_processor()
        )
        without = render_mixdown([later], None, dry_params)

        start = int(400 * INTERNAL_SAMPLE_RATE / 1000)
        end = start + int(100 * INTERNAL_SAMPLE_RATE / 1000)
        for channel_index, channel in enumerate(with_reverb.audio.channels):
            segment = channel[start:end]
            reference = without.audio.channels[channel_index][start:end]
            assert np.array_equal(segment, reference), (
                f"channel {channel_index}: the reverb tail reached the later clip's interval"
            )

    def test_the_tail_is_cut_before_the_fade_out(self) -> None:
        # Requirement 29.31's order: truncate, *then* gain and fade. So the fade-out lands on the
        # clip's last audible millisecond. The last sample of a clip faded to zero must be zero,
        # which it would not be if the fade had been applied inside a longer, later-cut buffer.
        clip = wet_clip(REVERB, play_length_ms=200, fade_out_ms=100)
        result = render_mixdown([clip], None, None, effect_processor=clip_effect_processor())
        for channel in result.audio.channels:
            assert channel[-1] == pytest.approx(0.0, abs=1e-6)

    def test_effects_are_applied_after_the_trim(self) -> None:
        # Requirement 29.31: "트림이 적용된 클립 오디오에". A chain must never hear trimmed-away
        # audio, so trimming and then processing differs from processing the whole source — which
        # it does here because the reverb is fed different input.
        audio = burst(400)
        trimmed = MixdownClip(
            clip_id="clip-a",
            track=0,
            audio=audio,
            start_time_ms=0,
            play_length_ms=200,
            trim_start_ms=200,
            effect_chain=REVERB,
        )
        untrimmed = MixdownClip(
            clip_id="clip-a",
            track=0,
            audio=AudioBuffer.from_channels(
                audio.sample_rate,
                [
                    channel[int(200 * INTERNAL_SAMPLE_RATE / 1000) :]
                    for channel in audio.channels
                ],
            ),
            start_time_ms=0,
            play_length_ms=200,
            effect_chain=REVERB,
        )

        processor = clip_effect_processor()
        from_trim = render_mixdown([trimmed], None, None, effect_processor=processor)
        from_slice = render_mixdown([untrimmed], None, None, effect_processor=processor)

        # Trimming then processing is the same as processing the already-sliced audio: the chain
        # saw only the audible part in both cases.
        for left, right in zip(from_trim.audio.channels, from_slice.audio.channels):
            assert np.array_equal(left, right)


class TestWhichChainsWereApplied:
    """Requirement 29.31's report, which the product layer checks against what it sent."""

    @requires_pedalboard
    def test_it_names_the_clips_that_carried_a_chain(self) -> None:
        clips = [
            wet_clip(REVERB, clip_id="clip-a", start_time_ms=0),
            MixdownClip(
                clip_id="clip-b",
                track=1,
                audio=burst(100),
                start_time_ms=0,
                play_length_ms=100,
            ),
            wet_clip(GAIN, clip_id="clip-c", start_time_ms=0, track=2),
        ]
        result = render_mixdown(clips, None, None, effect_processor=clip_effect_processor())
        assert result.clip_effects_applied == ("clip-a", "clip-c")

    def test_it_is_empty_when_no_clip_carries_a_chain(self) -> None:
        clip = MixdownClip(
            clip_id="clip-a", track=0, audio=burst(100), start_time_ms=0, play_length_ms=100
        )
        result = render_mixdown([clip], None, None, effect_processor=clip_effect_processor())
        assert result.clip_effects_applied == ()

    @requires_pedalboard
    def test_it_is_in_summation_order(self) -> None:
        clips = [
            wet_clip(GAIN, clip_id="clip-z", start_time_ms=0, track=1),
            wet_clip(GAIN, clip_id="clip-a", start_time_ms=0, track=0),
        ]
        result = render_mixdown(clips, None, None, effect_processor=clip_effect_processor())
        # Ascending clip id, the same order ``rendered_clip_ids`` uses.
        assert result.clip_effects_applied == ("clip-a", "clip-z")
        assert result.rendered_clip_ids == ("clip-a", "clip-z")

    def test_a_processor_is_not_called_for_a_clip_without_a_chain(self) -> None:
        calls: list[int] = []

        def counting(audio: AudioBuffer, items: Any) -> AudioBuffer:
            calls.append(1)
            return audio

        clips = [
            MixdownClip(
                clip_id="clip-a", track=0, audio=burst(100), start_time_ms=0, play_length_ms=100
            ),
            wet_clip(GAIN, clip_id="clip-b", track=1, start_time_ms=0),
        ]
        render_mixdown(clips, None, None, effect_processor=counting)
        assert len(calls) == 1


class TestTheRefusalIsNowLive:
    """A chain with no processor is refused, not dropped (task 4.2's choice, now reachable)."""

    def test_a_chain_without_a_processor_is_refused(self) -> None:
        clip = wet_clip(REVERB)
        with pytest.raises(MixdownError) as raised:
            render_mixdown([clip], None, None)
        assert raised.value.code == "mixdown_clip_effects_unsupported"
        assert "clip-a" in raised.value.detail

    def test_a_clip_without_a_chain_needs_no_processor(self) -> None:
        clip = MixdownClip(
            clip_id="clip-a", track=0, audio=burst(100), start_time_ms=0, play_length_ms=100
        )
        result = render_mixdown([clip], None, None)
        assert result.clip_effects_applied == ()

    @requires_pedalboard
    def test_supplying_a_processor_makes_the_same_project_render(self) -> None:
        clip = wet_clip(REVERB)
        result = render_mixdown([clip], None, None, effect_processor=clip_effect_processor())
        assert result.clip_effects_applied == ("clip-a",)


@requires_pedalboard
class TestClipEffectsAndTheRestOfRequirement28:
    """The stages around the chain still behave as Requirements 28.16–28.18 say.

    Every test renders a real chain, so the guard is class-wide.
    """

    def test_clip_gain_applies_after_the_chain(self) -> None:
        processor = clip_effect_processor()
        quiet = render_mixdown(
            [wet_clip(REVERB, gain_db=-20.0)], None, None, effect_processor=processor
        )
        loud = render_mixdown([wet_clip(REVERB, gain_db=0.0)], None, None, effect_processor=processor)
        assert quiet.peak_before < loud.peak_before

    def test_track_volume_still_scales_an_effected_clip(self) -> None:
        processor = clip_effect_processor()
        clip = wet_clip(REVERB)
        full = render_mixdown([clip], None, None, effect_processor=processor)
        halved = render_mixdown(
            [clip], {0: TrackState(volume_db=-20.0)}, None, effect_processor=processor
        )
        assert halved.peak_before < full.peak_before

    def test_peak_normalisation_still_applies_to_an_effected_mix(self) -> None:
        # Requirement 28.28 over a summed mix that clip effects made loud.
        clips = [
            wet_clip(({"kind": "gain", "parameters": {"gain_db": 40.0}},), clip_id=f"clip-{index}", track=index)
            for index in range(3)
        ]
        result = render_mixdown(
            clips, None, RenderParams(normalise_peak=True), effect_processor=clip_effect_processor()
        )
        assert result.normalisation.applied is True
        assert result.peak_after <= 1.0 + 1e-6

    def test_a_mono_render_of_an_effected_clip_is_mono(self) -> None:
        result = render_mixdown(
            [wet_clip(REVERB)],
            None,
            RenderParams(channels=1),
            effect_processor=clip_effect_processor(),
        )
        assert result.audio.channel_count == 1
