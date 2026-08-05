"""The inaudible AI-generation watermark.

**Validates: Requirement 16.6**

Three claims, and they pull against each other, which is why they are tested
together rather than one per file:

1. the mark is **there** — a marked buffer detects, through each of the four
   download formats;
2. the mark is **inaudible** — it stays a fixed distance under the programme
   material and vanishes where the material does;
3. the detector does not **invent** it — unmarked audio, and audio marked with
   another key, stay under the threshold.

Claim 3 is the one that decides whether the other two mean anything: a detector
that answered yes to everything would satisfy claim 1 perfectly.
"""

from __future__ import annotations

import numpy as np
import pytest
from hypothesis import given, settings
from hypothesis import strategies as st

from musicstudio_dsp.audio_buffer import AudioBuffer
from musicstudio_dsp.formats import decode, encode
from musicstudio_dsp.resample import INTERNAL_SAMPLE_RATE
from musicstudio_dsp.watermark import (
    DETECTION_THRESHOLD,
    STRENGTH_RANGE,
    WATERMARK_KEYS,
    WATERMARK_VERSION,
    detect_watermark,
    embed_watermark,
    watermark_statistic,
    watermark_strength,
)

SR = INTERNAL_SAMPLE_RATE


def _stereo(mono: np.ndarray, sample_rate: int = SR) -> AudioBuffer:
    return AudioBuffer.from_channels(sample_rate, [mono, mono * 0.9])


def white(frames: int, amplitude: float = 0.1, seed: int = 3) -> AudioBuffer:
    rng = np.random.default_rng(seed)
    return _stereo((rng.standard_normal(frames) * amplitude).astype(np.float32))


def tone(frames: int, hz: float = 440.0, amplitude: float = 0.3) -> AudioBuffer:
    t = np.arange(frames, dtype=np.float64) / SR
    return _stereo((amplitude * np.sin(2 * np.pi * hz * t)).astype(np.float32))


def pink(frames: int, seed: int = 5) -> AudioBuffer:
    rng = np.random.default_rng(seed)
    spectrum = np.fft.rfft(rng.standard_normal(frames))
    freqs = np.fft.rfftfreq(frames, 1.0 / SR)
    spectrum[1:] /= np.sqrt(freqs[1:])
    samples = np.fft.irfft(spectrum, frames)
    peak = np.abs(samples).max()
    return _stereo((samples / max(peak, 1e-12) * 0.5).astype(np.float32))


def added(before: AudioBuffer, after: AudioBuffer) -> np.ndarray:
    return after.channels[0].astype(np.float64) - before.channels[0].astype(np.float64)


class TestStrength:
    def test_sparse_material_is_marked_far_more_gently_than_broadband(self) -> None:
        # The whole reason the strength is solved rather than fixed: a constant
        # loud enough for the noise would be plainly audible on the tone.
        assert watermark_strength(tone(48_000)) < watermark_strength(white(48_000)) / 5

    def test_a_longer_asset_of_the_same_material_is_marked_more_gently(self) -> None:
        # Same interference, more processing gain, so less mark is needed.
        assert watermark_strength(white(480_000)) < watermark_strength(white(48_000))

    def test_is_clamped_at_both_ends(self) -> None:
        assert watermark_strength(white(4_800, amplitude=0.9)) == STRENGTH_RANGE[1]
        assert watermark_strength(tone(480_000)) == STRENGTH_RANGE[0]

    def test_an_empty_buffer_does_not_divide_by_zero(self) -> None:
        assert watermark_strength(AudioBuffer.from_channels(SR, [])) == STRENGTH_RANGE[0]


class TestDetection:
    @pytest.mark.parametrize(
        "name,audio",
        [
            ("white 3s", white(144_000)),
            ("white 0.4s", white(19_200, amplitude=0.2)),
            ("tone 1s", tone(48_000)),
            ("pink 5s", pink(240_000)),
            ("pink 20s", pink(960_000)),
            ("quiet 2s", white(96_000, amplitude=0.005)),
        ],
    )
    def test_marked_audio_detects(self, name: str, audio: AudioBuffer) -> None:
        result = detect_watermark(embed_watermark(audio))

        assert result.detected, f"{name}: statistic {result.statistic:.2f}"
        assert result.version == WATERMARK_VERSION

    def test_the_shortest_broadband_case_is_at_the_limit_and_stated_as_such(
        self,
    ) -> None:
        # A tenth of a second of full-scale noise is where the scheme runs out:
        # the strength is already at its ceiling, so buying more confidence would
        # mean buying it with audibility. The module docstring says so; this pins
        # the number, so a change that quietly makes it worse is visible.
        result = detect_watermark(embed_watermark(white(4_800, amplitude=0.2)))

        assert 3.5 <= result.statistic <= 6.0

    @pytest.mark.parametrize(
        "audio_format",
        ["flac", "wav", "mp3", "ogg"],
    )
    def test_survives_every_download_format(self, audio_format: str) -> None:
        # The shortest asset the product stores, through the codec that treats it
        # worst — this is the corner the whole band choice exists for.
        marked = embed_watermark(white(19_200, amplitude=0.2))

        recovered = decode(encode(marked, audio_format))  # type: ignore[arg-type]
        # Lossy encoders pad; the detector regenerates its carrier from the length
        # it is given, so the comparison has to be made at the original length.
        trimmed = AudioBuffer.from_channels(
            recovered.sample_rate,
            [channel[: marked.frame_count] for channel in recovered.channels],
        )

        assert detect_watermark(trimmed).detected

    def test_mono_is_marked_too(self) -> None:
        mono = AudioBuffer.from_channels(SR, [white(96_000).channels[0]])

        assert detect_watermark(embed_watermark(mono)).detected

    def test_reports_the_version_that_matched(self) -> None:
        assert detect_watermark(embed_watermark(white(144_000))).version in WATERMARK_KEYS


class TestTheDetectorDoesNotInventMarks:
    @pytest.mark.parametrize(
        "audio",
        [white(144_000), white(4_800), tone(48_000), pink(240_000), white(96_000, amplitude=0.001)],
    )
    def test_unmarked_audio_stays_under_the_threshold(self, audio: AudioBuffer) -> None:
        result = detect_watermark(audio)

        assert not result.detected
        assert result.version is None

    def test_a_different_key_does_not_read_as_a_match(self) -> None:
        marked = embed_watermark(white(144_000))
        # The same scheme with another seed: the shape of a version bump, and the
        # thing that would fire if the statistic were measuring "is this shaped
        # like a carrier" rather than "is this *our* carrier".
        other_key = max(WATERMARK_KEYS.values()) + 1
        WATERMARK_KEYS[99] = other_key
        try:
            assert watermark_statistic(marked, 99) < DETECTION_THRESHOLD
        finally:
            del WATERMARK_KEYS[99]

    @settings(max_examples=100, deadline=None)
    @given(
        frames=st.integers(min_value=4_800, max_value=120_000),
        amplitude=st.floats(min_value=0.001, max_value=0.9),
        # Every seed except the carrier's own. Hypothesis found that one by
        # shrinking, and it is a true positive rather than a false one: noise
        # drawn from the carrier's generator *is* the carrier, and the detector
        # saying so at 31 sigma is the detector working. Excluded rather than
        # accommodated, because no recording is the carrier by accident.
        seed=st.integers(min_value=0, max_value=2**32 - 1).filter(
            lambda value: value not in set(WATERMARK_KEYS.values())
        ),
    )
    def test_unmarked_noise_never_crosses_the_threshold(
        self, frames: int, amplitude: float, seed: int
    ) -> None:
        assert not detect_watermark(white(frames, amplitude, seed)).detected


class TestInaudibility:
    @pytest.mark.parametrize(
        "audio", [white(144_000), tone(48_000), pink(240_000), white(19_200, amplitude=0.2)]
    )
    def test_the_mark_stays_at_least_20_db_under_the_material(
        self, audio: AudioBuffer
    ) -> None:
        marked = embed_watermark(audio)
        delta = added(audio, marked)

        signal_power = float((audio.channels[0].astype(np.float64) ** 2).mean())
        mark_power = float((delta**2).mean())
        assert 10 * np.log10(signal_power / mark_power) >= 20.0

    def test_silence_gets_no_mark(self) -> None:
        # A constant-amplitude carrier would be a hiss in every gap. This is the
        # test that fails if the envelope shaping is dropped for a fixed gain.
        silence = AudioBuffer.from_channels(SR, [np.zeros(48_000, dtype=np.float32)] * 2)

        assert np.abs(added(silence, embed_watermark(silence))).max() == 0.0

    def test_a_quiet_passage_is_marked_proportionally(self) -> None:
        # One buffer, loud for the first half and 100x quieter for the second:
        # the same asset, so the same strength, which isolates the envelope.
        rng = np.random.default_rng(11)
        loud = rng.standard_normal(48_000) * 0.5
        quiet = rng.standard_normal(48_000) * 0.005
        audio = _stereo(np.concatenate([loud, quiet]).astype(np.float32))

        delta = added(audio, embed_watermark(audio))

        # Measured a block clear of the step, because the envelope interpolates
        # across it — that ramp is the point of interpolating rather than
        # holding, and measuring inside it would be measuring the ramp.
        loud_rms = np.sqrt((delta[:47_000] ** 2).mean())
        quiet_rms = np.sqrt((delta[49_000:] ** 2).mean())
        assert quiet_rms < loud_rms / 50

    def test_does_not_change_the_length_or_the_rate(self) -> None:
        audio = pink(240_000)
        marked = embed_watermark(audio)

        assert marked.frame_count == audio.frame_count
        assert marked.sample_rate == audio.sample_rate
        assert marked.channel_count == audio.channel_count


class TestRejections:
    def test_refuses_a_buffer_that_is_not_well_formed(self) -> None:
        with pytest.raises(ValueError):
            embed_watermark(AudioBuffer.from_channels(SR, []))

    def test_refuses_an_unknown_version(self) -> None:
        with pytest.raises(ValueError, match="unknown watermark version"):
            embed_watermark(white(48_000), version=max(WATERMARK_KEYS) + 1)
