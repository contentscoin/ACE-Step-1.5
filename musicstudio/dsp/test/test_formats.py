"""Format conversion — Requirements 13.2, 13.3, 13.9, 13.10 and design §5.1.

The task 3.1 acceptance criterion "포맷 변환 무손실 확인" is proven here for the
two formats that can carry it, WAV and FLAC, using nothing but the bundled
``libsndfile``: no ``ffmpeg``, no subprocess, no skip. What "lossless" can mean
for a 24-bit export is spelled out in :mod:`musicstudio_dsp.formats` — one
quantisation step, ``2**-23`` — and the tests below assert that bound rather than
bit-exact float equality, because a 24-bit container cannot represent more.

MP3 and OGG are lossy by construction, so only their *shape* is constrained.
"""

from __future__ import annotations

import io

import numpy as np
import pytest
import soundfile as sf

from musicstudio_dsp.audio_buffer import AudioBuffer
from musicstudio_dsp.formats import (
    DOWNLOAD_FORMATS,
    EXPORT_SUBTYPES,
    LOSSLESS_FORMATS,
    LOSSLESS_TOLERANCE,
    SFX_DOWNLOAD_FORMATS,
    TAG_FIELDS,
    UnsupportedFormatError,
    convert,
    decode,
    encode,
    is_lossless,
    read_tags,
)
from musicstudio_dsp.resample import INTERNAL_SAMPLE_RATE

LOSSY_FORMATS = ("mp3", "ogg")


def signal(sample_rate: int = INTERNAL_SAMPLE_RATE, frames: int = 24_000, channels: int = 2) -> AudioBuffer:
    """A sine at a moderate level. Below full scale so nothing clips on export."""
    t = np.arange(frames, dtype=np.float64) / float(sample_rate)
    wave = (0.5 * np.sin(2.0 * np.pi * 440.0 * t)).astype(np.float32)
    return AudioBuffer.from_channels(sample_rate, [wave * (1.0 - 0.25 * c) for c in range(channels)])


class TestFormatCatalogue:
    def test_offers_mp3_wav_flac_for_every_asset_kind(self) -> None:
        assert DOWNLOAD_FORMATS == ("mp3", "wav", "flac")  # Requirement 13.2

    def test_adds_ogg_for_sfx(self) -> None:
        assert set(SFX_DOWNLOAD_FORMATS) == {"mp3", "wav", "flac", "ogg"}  # Requirement 13.9

    def test_classifies_wav_and_flac_as_lossless(self) -> None:
        assert LOSSLESS_FORMATS == frozenset({"wav", "flac"})  # Requirement 13.4's gate
        assert is_lossless("wav") and is_lossless("flac")
        assert not is_lossless("mp3") and not is_lossless("ogg")

    def test_rejects_an_unsupported_format_with_the_allowed_list(self) -> None:
        with pytest.raises(UnsupportedFormatError) as caught:
            encode(signal(), "aiff")  # type: ignore[arg-type]

        assert caught.value.allowed == SFX_DOWNLOAD_FORMATS
        assert "aiff" in str(caught.value)


class TestExportDepth:
    @pytest.mark.parametrize("audio_format", sorted(LOSSLESS_FORMATS))
    def test_exports_lossless_formats_at_24_bit(self, audio_format: str) -> None:
        # Design §5.1: 32-bit float internally, 24-bit on export.
        data = encode(signal(), audio_format)  # type: ignore[arg-type]

        info = sf.info(io.BytesIO(data))
        assert info.subtype == "PCM_24"
        assert EXPORT_SUBTYPES[audio_format][1] == "PCM_24"  # type: ignore[index]

    @pytest.mark.parametrize("audio_format", SFX_DOWNLOAD_FORMATS)
    def test_writes_the_buffers_sample_rate(self, audio_format: str) -> None:
        data = encode(signal(), audio_format)  # type: ignore[arg-type]

        assert sf.info(io.BytesIO(data)).samplerate == INTERNAL_SAMPLE_RATE

    def test_refuses_to_encode_a_malformed_buffer(self) -> None:
        with pytest.raises(ValueError, match="not well formed"):
            encode(AudioBuffer.from_channels(INTERNAL_SAMPLE_RATE, []), "wav")


class TestLosslessRoundTrip:
    """"포맷 변환 무손실 확인" — genuinely, with no codec binary involved."""

    @pytest.mark.parametrize("audio_format", sorted(LOSSLESS_FORMATS))
    @pytest.mark.parametrize("channels", [1, 2])
    def test_samples_survive_within_one_24_bit_step(
        self, audio_format: str, channels: int
    ) -> None:
        original = signal(channels=channels)

        restored = decode(encode(original, audio_format))  # type: ignore[arg-type]

        assert restored.sample_rate == original.sample_rate
        assert restored.channel_count == original.channel_count
        assert restored.frame_count == original.frame_count
        for expected, actual in zip(original.channels, restored.channels):
            assert np.max(np.abs(expected - actual)) <= LOSSLESS_TOLERANCE

    def test_wav_and_flac_agree_to_within_one_step_but_not_exactly(self) -> None:
        # Measured, not assumed. libsndfile's float<->int24 scaling differs
        # between the WAV and FLAC paths, so the two decode one LSB apart on a
        # large fraction of samples. Both are still lossless to within a step;
        # they are simply not equal to each other, and a test asserting equality
        # would have been asserting something false.
        original = signal()

        from_wav = decode(encode(original, "wav"))
        from_flac = decode(encode(original, "flac"))

        difference = np.abs(from_wav.channels[0] - from_flac.channels[0])
        assert np.max(difference) <= LOSSLESS_TOLERANCE
        assert np.max(difference) > 0  # they really are not identical

    def test_flac_is_smaller_than_wav_for_the_same_audio(self) -> None:
        original = signal()

        assert len(encode(original, "flac")) < len(encode(original, "wav"))

    def test_repeated_lossless_conversion_does_not_accumulate_error(self) -> None:
        # Requirement 13.3 converts on demand, so a stored FLAC may be re-encoded
        # many times over an asset's life. A generational loss would make the
        # tenth download worse than the first.
        original = signal()
        data = encode(original, "flac")

        for _ in range(10):
            data = convert(data, "wav").data
            data = convert(data, "flac").data

        restored = decode(data)
        for expected, actual in zip(original.channels, restored.channels):
            assert np.max(np.abs(expected - actual)) <= LOSSLESS_TOLERANCE

    def test_export_clips_samples_beyond_full_scale(self) -> None:
        # `PcmAudio` deliberately does not clamp, so an inter-sample overshoot
        # stays measurable internally. A 24-bit integer container cannot hold one,
        # and this records that boundary rather than leaving it to be discovered:
        # anything that needs the overshoot must measure before export.
        hot = AudioBuffer.from_channels(INTERNAL_SAMPLE_RATE, [[1.5, -1.5, 0.25]])

        restored = decode(encode(hot, "wav"))

        assert np.max(np.abs(restored.channels[0])) <= 1.0
        assert restored.channels[0][2] == pytest.approx(0.25, abs=LOSSLESS_TOLERANCE)


class TestLossyFormats:
    """MP3 and OGG cannot round-trip samples; their shape still must."""

    @pytest.mark.parametrize("audio_format", LOSSY_FORMATS)
    def test_preserves_rate_channels_and_length_within_10ms(self, audio_format: str) -> None:
        original = signal()

        restored = decode(encode(original, audio_format))  # type: ignore[arg-type]

        assert restored.sample_rate == original.sample_rate
        assert restored.channel_count == original.channel_count
        assert abs(restored.duration_ms - original.duration_ms) <= 10.0

    @pytest.mark.parametrize("audio_format", LOSSY_FORMATS)
    def test_is_recognisably_the_same_signal(self, audio_format: str) -> None:
        # Not a sample comparison — a lossy codec would fail one by definition.
        # The check is that the encoder was actually fed the audio: a comparable
        # RMS means the content survived, which a silent or truncated result
        # would not show.
        original = signal()

        restored = decode(encode(original, audio_format))  # type: ignore[arg-type]

        expected_rms = float(np.sqrt(np.mean(original.channels[0] ** 2)))
        actual_rms = float(np.sqrt(np.mean(restored.channels[0] ** 2)))
        assert actual_rms == pytest.approx(expected_rms, rel=0.05)

    @pytest.mark.parametrize("audio_format", LOSSY_FORMATS)
    def test_is_smaller_than_the_lossless_export(self, audio_format: str) -> None:
        original = signal()

        assert len(encode(original, audio_format)) < len(encode(original, "wav"))  # type: ignore[arg-type]


class TestConvert:
    @pytest.mark.parametrize("audio_format", SFX_DOWNLOAD_FORMATS)
    def test_returns_48khz_whatever_the_source_rate_was(self, audio_format: str) -> None:
        # Requirement 13.10 admits no exception, so the rate normalisation is
        # inside the conversion rather than beside it.
        stored = encode(signal(sample_rate=22_050, frames=22_050), "flac")

        report = convert(stored, audio_format)  # type: ignore[arg-type]

        assert report.sample_rate == INTERNAL_SAMPLE_RATE
        assert sf.info(io.BytesIO(report.data)).samplerate == INTERNAL_SAMPLE_RATE
        assert report.resample.original_sample_rate == 22_050
        assert abs(report.resample.length_error_ms) <= 10.0

    def test_detects_the_source_container_from_its_bytes(self) -> None:
        # A file whose extension lies about its contents still converts correctly,
        # which is what Requirement 19.12's upload validation depends on.
        for source_format in SFX_DOWNLOAD_FORMATS:
            stored = encode(signal(frames=4_800), source_format)

            report = convert(stored, "wav")

            assert report.sample_rate == INTERNAL_SAMPLE_RATE
            assert report.lossless is True

    def test_reports_losslessness_of_the_target_format(self) -> None:
        stored = encode(signal(frames=4_800), "flac")

        assert convert(stored, "flac").lossless is True
        assert convert(stored, "mp3").lossless is False

    def test_rejects_an_unsupported_target_format(self) -> None:
        stored = encode(signal(frames=4_800), "flac")

        with pytest.raises(UnsupportedFormatError):
            convert(stored, "aiff")  # type: ignore[arg-type]


class TestMetadataTags:
    """Requirement 13.7's carrier: the container fields a marker can ride in.

    The wording of the marker belongs to ``domain/disclosure``; what is checked
    here is that whatever the product writes actually arrives, in every format a
    download may be asked for.
    """

    @pytest.mark.parametrize("audio_format", SFX_DOWNLOAD_FORMATS)
    def test_every_download_format_carries_the_comment(self, audio_format: str) -> None:
        marker = "AI generated by MusicStudio"

        encoded = encode(signal(frames=4_800), audio_format, {"comment": marker})

        assert read_tags(encoded)["comment"] == marker

    @pytest.mark.parametrize("audio_format", SFX_DOWNLOAD_FORMATS)
    def test_every_offered_field_survives_every_format(self, audio_format: str) -> None:
        # The list exists because ``software`` does not survive: libsndfile
        # rewrites it and the MP3 writer drops it. A field that is offered has to
        # come back, or Requirement 13.7 is satisfied only on paper.
        tags = {field: f"value for {field}" for field in TAG_FIELDS}

        assert read_tags(encode(signal(frames=4_800), audio_format, tags)) == tags

    def test_an_untagged_file_reports_no_tags(self) -> None:
        assert read_tags(encode(signal(frames=4_800), "flac")) == {}

    def test_rejects_a_field_it_cannot_write_everywhere(self) -> None:
        # Silently ignoring it is the dangerous behaviour: the download succeeds
        # and the marker is simply not in the file.
        with pytest.raises(ValueError, match="unsupported metadata field"):
            encode(signal(frames=4_800), "flac", {"software": "MusicStudio"})

    def test_conversion_tags_the_output_and_does_not_inherit_the_source(self) -> None:
        stored = encode(signal(frames=4_800), "flac", {"comment": "stored copy"})

        untagged = convert(stored, "mp3")
        tagged = convert(stored, "mp3", tags={"comment": "download"})

        assert read_tags(untagged.data) == {}
        assert read_tags(tagged.data)["comment"] == "download"

    def test_tagging_does_not_disturb_the_audio(self) -> None:
        source = signal(frames=4_800)

        plain = decode(encode(source, "flac"))
        tagged = decode(encode(source, "flac", {"comment": "x" * 200}))

        for left, right in zip(plain.channels, tagged.channels):
            assert np.allclose(left, right, atol=LOSSLESS_TOLERANCE)
