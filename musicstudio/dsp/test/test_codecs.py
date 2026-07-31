"""The ``pydub``/``ffmpeg`` fallback boundary of design §5.5.

This environment has no ``ffmpeg`` and no ``avconv``, and none is installable
from its package repositories. So the tests split in two:

* The availability reporting itself is tested unconditionally. It is ordinary
  logic and it is the part everything else depends on — a
  :func:`codec_backend_status` that wrongly reported "available" would turn a
  skip into a confusing failure, and one that wrongly reported "unavailable"
  would silently disable the fallback in production.
* The tests that would actually *run* an encoder skip, with the reason attached,
  in the same way ``test/integration/db-schema.test.ts`` skips when no
  PostgreSQL is reachable. They are real tests that run wherever the binary
  exists, not placeholders.

Nothing important rests on those skips: every format Requirements 13.2 and 13.9
name is covered by the primary ``libsndfile`` path in ``test_formats.py``, with
no binary involved. The fallback is a redundancy, and what is skipped here is the
redundancy rather than the requirement.
"""

from __future__ import annotations

import numpy as np
import pytest

from musicstudio_dsp.audio_buffer import AudioBuffer
from musicstudio_dsp.codecs import (
    FFMPEG_CANDIDATES,
    CodecBackendUnavailableError,
    codec_backend_status,
    decode_via_pydub,
    encode_via_pydub,
    ffmpeg_binary,
    pydub_available,
)
from musicstudio_dsp.formats import encode
from musicstudio_dsp.resample import INTERNAL_SAMPLE_RATE

BACKEND = codec_backend_status()
requires_backend = pytest.mark.skipif(
    not BACKEND.available,
    reason=f"pydub codec fallback unavailable: {BACKEND.reason}",
)


def signal(frames: int = 4_800, channels: int = 2) -> AudioBuffer:
    t = np.arange(frames, dtype=np.float64) / float(INTERNAL_SAMPLE_RATE)
    wave = (0.5 * np.sin(2.0 * np.pi * 440.0 * t)).astype(np.float32)
    return AudioBuffer.from_channels(
        INTERNAL_SAMPLE_RATE, [wave * (1.0 - 0.25 * c) for c in range(channels)]
    )


class TestAvailabilityReporting:
    def test_looks_for_ffmpeg_and_its_fork(self) -> None:
        assert FFMPEG_CANDIDATES == ("ffmpeg", "avconv")

    def test_ffmpeg_binary_is_a_path_or_none(self) -> None:
        found = ffmpeg_binary()

        assert found is None or isinstance(found, str)

    def test_status_agrees_with_the_two_things_it_checks(self) -> None:
        status = codec_backend_status()

        assert status.available == (pydub_available() and ffmpeg_binary() is not None)

    def test_status_always_carries_a_reason(self) -> None:
        # The reason becomes a skip message and an exception message, so an empty
        # one would turn an explained absence into an unexplained one.
        assert codec_backend_status().reason


class TestUnavailableBackend:
    @pytest.mark.skipif(
        BACKEND.available, reason="a codec backend is present, so refusal cannot occur"
    )
    def test_encode_refuses_rather_than_degrading(self) -> None:
        # Requirement 13.3 promises the requested format. Falling back to some
        # other format, or to silence, would break that promise quietly.
        with pytest.raises(CodecBackendUnavailableError) as caught:
            encode_via_pydub(signal(), "mp3")

        assert caught.value.reason == BACKEND.reason

    @pytest.mark.skipif(
        BACKEND.available, reason="a codec backend is present, so refusal cannot occur"
    )
    def test_decode_refuses_rather_than_degrading(self) -> None:
        with pytest.raises(CodecBackendUnavailableError):
            decode_via_pydub(encode(signal(), "wav"))


class TestFallbackEncoding:
    """Runs wherever ``ffmpeg`` exists. Skipped, with the reason, where it does not."""

    @requires_backend
    @pytest.mark.parametrize("audio_format", ["mp3", "ogg", "wav", "flac"])
    def test_encodes_every_download_format(self, audio_format: str) -> None:
        data = encode_via_pydub(signal(), audio_format)  # type: ignore[arg-type]

        assert len(data) > 0

    @requires_backend
    def test_round_trips_shape_through_the_fallback(self) -> None:
        original = signal()

        restored = decode_via_pydub(encode_via_pydub(original, "mp3"))

        assert restored.sample_rate == original.sample_rate
        assert restored.channel_count == original.channel_count
        assert abs(restored.duration_ms - original.duration_ms) <= 50.0
