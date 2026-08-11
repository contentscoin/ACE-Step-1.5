"""The two composed operations of task 3.1 — Requirements 19.4, 19.5, 13.3, 13.10.

These are the functions the Celery tasks delegate to, and they are tested as
plain functions, with no broker anywhere in sight. See
``musicstudio_dsp.worker`` for why that split exists.
"""

from __future__ import annotations

import numpy as np
import pytest

from musicstudio_dsp.audio_buffer import AudioBuffer
from musicstudio_dsp.formats import LOSSLESS_TOLERANCE, decode, encode
from musicstudio_dsp.pipeline import (
    STORAGE_FORMAT,
    convert_for_download,
    describe_audio,
    normalise_for_storage,
)
from musicstudio_dsp.resample import INTERNAL_SAMPLE_RATE
from musicstudio_dsp.watermark import WATERMARK_VERSION, detect_watermark, embed_watermark


def signal(sample_rate: int = INTERNAL_SAMPLE_RATE, frames: int = 24_000, channels: int = 2) -> AudioBuffer:
    t = np.arange(frames, dtype=np.float64) / float(sample_rate)
    wave = (0.5 * np.sin(2.0 * np.pi * 440.0 * t)).astype(np.float32)
    return AudioBuffer.from_channels(sample_rate, [wave * (1.0 - 0.25 * c) for c in range(channels)])


class TestDescribeAudio:
    def test_reports_the_three_fields_of_the_typescript_audio_shape(self) -> None:
        # ``AudioShape`` in services/sound/measurement.ts is exactly these three.
        shape = describe_audio(signal(sample_rate=44_100, frames=44_100))

        assert shape.sample_rate == 44_100
        assert shape.channels == 2
        assert shape.duration_ms == pytest.approx(1_000.0)

    def test_does_not_round_the_duration(self) -> None:
        shape = describe_audio(signal(frames=1))

        assert shape.duration_ms == pytest.approx(1000.0 / INTERNAL_SAMPLE_RATE)


class TestNormaliseForStorage:
    def test_stores_at_48khz_as_24_bit_flac(self) -> None:
        # Requirement 19.4 plus design §5.1's export depth.
        stored = normalise_for_storage(encode(signal(sample_rate=44_100, frames=44_100), "wav"))

        assert stored.audio_format == STORAGE_FORMAT == "flac"
        assert stored.shape.sample_rate == INTERNAL_SAMPLE_RATE
        assert decode(stored.data).sample_rate == INTERNAL_SAMPLE_RATE

    def test_records_the_original_rate_and_the_length_error(self) -> None:
        # Requirement 19.5: the original rate goes into the provenance record and
        # the stored length stays within ±10 ms.
        stored = normalise_for_storage(encode(signal(sample_rate=22_050, frames=22_050), "wav"))

        assert stored.original_sample_rate == 22_050
        assert stored.original_duration_ms == pytest.approx(1_000.0)
        assert abs(stored.length_error_ms) <= 10.0
        assert stored.resampled is True

    def test_marks_already_48khz_audio_as_not_resampled(self) -> None:
        stored = normalise_for_storage(encode(signal(), "wav"))

        assert stored.resampled is False
        assert stored.original_sample_rate == INTERNAL_SAMPLE_RATE

    def test_storing_an_already_48khz_asset_changes_it_only_by_the_mark(self) -> None:
        # This test used to assert bit-losslessness to within a 24-bit step, and
        # Requirement 16.6 made that false: the stored copy now carries the
        # inaudible mark, so it *cannot* equal the engine's output. What is still
        # true — and is the claim worth keeping — is that the mark is the only
        # difference, and that it is bounded by what `watermark.py` promises.
        original = signal()
        engine_bytes = encode(original, "wav")

        stored = normalise_for_storage(engine_bytes)

        restored = decode(stored.data)
        # Marked from the *decoded* engine bytes rather than from `original`: the
        # envelope is computed on what the pipeline actually sees, and a 24-bit
        # step of difference in the input is a step of difference in the mark.
        marked = embed_watermark(decode(engine_bytes))
        for expected, actual, engine_output in zip(
            marked.channels, restored.channels, original.channels
        ):
            # The mark is the whole of the difference, to within a 24-bit step.
            assert np.max(np.abs(expected - actual)) <= LOSSLESS_TOLERANCE
            # And the mark stays under the material it rides on.
            difference = actual.astype(np.float64) - engine_output.astype(np.float64)
            material = float((engine_output.astype(np.float64) ** 2).mean())
            assert 10 * np.log10(material / float((difference**2).mean())) >= 20.0

    def test_the_stored_copy_carries_the_mark_and_reports_its_version(self) -> None:
        stored = normalise_for_storage(encode(signal(frames=96_000), "wav"))

        detection = detect_watermark(decode(stored.data))
        assert detection.detected
        assert detection.version == stored.watermark_version == WATERMARK_VERSION

    def test_the_mark_changes_no_dimension_of_the_audio(self) -> None:
        # `shape` is measured on the marked buffer, so this is what makes that
        # safe rather than merely convenient.
        original = signal(frames=96_000)

        stored = normalise_for_storage(encode(original, "wav"))

        assert stored.shape.sample_rate == original.sample_rate
        assert stored.shape.channels == original.channel_count
        assert stored.shape.duration_ms == pytest.approx(original.duration_ms)

    def test_a_download_is_converted_from_the_marked_copy(self) -> None:
        # The download path does not re-mark; it inherits. A second mark applied
        # per conversion would accumulate, and the fifth download of an asset
        # would be measurably noisier than the first.
        stored = normalise_for_storage(encode(signal(frames=96_000), "wav"))

        converted = convert_for_download(stored.data, "flac")

        assert detect_watermark(converted.audio).detected

    def test_preserves_mono(self) -> None:
        stored = normalise_for_storage(
            encode(signal(sample_rate=16_000, frames=16_000, channels=1), "wav")
        )

        assert stored.shape.channels == 1

    @pytest.mark.parametrize("sample_rate", [8_000, 11_025, 22_050, 44_100, 96_000, 192_000])
    def test_length_error_stays_inside_one_output_sample_period(
        self, sample_rate: int
    ) -> None:
        # Stronger than Requirement 19.5's ±10 ms, and the reason the requirement
        # is met so comfortably: resampling can only round the frame count, so the
        # error is bounded by one period of the *output* rate — 1/48000 s, or
        # 0.0208 ms. That is 480x inside the requirement, and it is a structural
        # bound rather than a measured coincidence, which is why this asserts it
        # for every rate rather than reporting a worst case.
        #
        # It also means `normalise_for_storage` cannot breach the tolerance for any
        # input: the strict guard in `resample.py` exists for a future change of
        # target rate or resampler, not for a reachable input, and it is tested
        # there against a deliberately absurd target rate.
        one_output_period_ms = 1_000.0 / INTERNAL_SAMPLE_RATE

        stored = normalise_for_storage(
            encode(signal(sample_rate=sample_rate, frames=sample_rate * 2), "wav")
        )

        assert abs(stored.length_error_ms) <= one_output_period_ms


class TestConvertForDownload:
    @pytest.mark.parametrize("audio_format", ["mp3", "wav", "flac", "ogg"])
    def test_returns_the_requested_format_at_48khz(self, audio_format: str) -> None:
        stored = normalise_for_storage(encode(signal(sample_rate=22_050, frames=22_050), "wav"))

        report = convert_for_download(stored.data, audio_format)  # type: ignore[arg-type]

        assert report.audio_format == audio_format
        assert report.sample_rate == INTERNAL_SAMPLE_RATE  # Requirement 13.10

    def test_a_lossless_download_matches_the_stored_asset(self) -> None:
        # Requirement 13.3's conversion out of the stored FLAC must not degrade it.
        original = signal()
        stored = normalise_for_storage(encode(original, "wav"))

        report = convert_for_download(stored.data, "wav")

        restored = decode(report.data)
        for expected, actual in zip(decode(stored.data).channels, restored.channels):
            assert np.max(np.abs(expected - actual)) <= LOSSLESS_TOLERANCE
        assert report.lossless is True

    def test_round_trip_through_the_whole_pipeline_keeps_the_length(self) -> None:
        # Engine output at 44.1 kHz, stored, then downloaded as mp3: two length
        # tolerances in series, and the total still has to hold.
        engine_output = encode(signal(sample_rate=44_100, frames=44_100), "wav")

        stored = normalise_for_storage(engine_output)
        downloaded = convert_for_download(stored.data, "mp3")

        assert abs(decode(downloaded.data).duration_ms - 1_000.0) <= 10.0
