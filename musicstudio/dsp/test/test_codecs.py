"""The ``pydub``/``ffmpeg`` fallback boundary of design §5.5.

Two halves, and neither is conditional on the machine any more:

* The availability reporting is ordinary logic and everything else depends on
  it — a :func:`codec_backend_status` that wrongly reported "available" would
  turn a clean refusal into a confusing failure, and one that wrongly reported
  "unavailable" would silently disable the fallback in production.
* The **refusal** path is driven through that seam rather than through the
  environment: the status function is replaced, so "what happens with no
  backend" is tested on a machine that has one. It used to be a
  ``skipif(BACKEND.available)``, which meant the two halves could never both
  run and one of them was always skipped — on every machine, in either
  direction.

What still depends on the machine is the half that actually shells out to a
codec. Task 9.3's acceptance criterion is 실패 0건·**건너뜀 0건**, so CI installs
the ``audio`` extra and an ``ffmpeg`` binary and those tests run there. On a
machine without one they skip with the reason attached, the same way
``test/integration/db-schema.test.ts`` skips without a PostgreSQL.
"""

from __future__ import annotations

import numpy as np
import pytest

from musicstudio_dsp import codecs
from musicstudio_dsp.audio_buffer import AudioBuffer
from musicstudio_dsp.codecs import (
    FFMPEG_CANDIDATES,
    CodecBackendStatus,
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


MISSING = CodecBackendStatus(available=False, reason="no backend, for this test")


@pytest.fixture
def without_backend(monkeypatch: pytest.MonkeyPatch) -> None:
    """Both entry points read the status through this one function."""
    monkeypatch.setattr(codecs, "codec_backend_status", lambda: MISSING)


class TestUnavailableBackend:
    def test_encode_refuses_rather_than_degrading(self, without_backend: None) -> None:
        # Requirement 13.3 promises the requested format. Falling back to some
        # other format, or to silence, would break that promise quietly.
        with pytest.raises(CodecBackendUnavailableError) as caught:
            encode_via_pydub(signal(), "mp3")

        assert caught.value.reason == MISSING.reason

    def test_decode_refuses_rather_than_degrading(self, without_backend: None) -> None:
        with pytest.raises(CodecBackendUnavailableError) as caught:
            decode_via_pydub(encode(signal(), "wav"))

        assert caught.value.reason == MISSING.reason

    def test_the_check_is_made_per_call_rather_than_cached(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # A container can lose its binary between calls, so the status is asked for every
        # time. An import-time constant would answer with the machine's state at start-up
        # and go on answering it after the binary was gone.
        calls = 0

        def counting() -> CodecBackendStatus:
            nonlocal calls
            calls += 1
            return MISSING

        monkeypatch.setattr(codecs, "codec_backend_status", counting)

        for _ in range(2):
            with pytest.raises(CodecBackendUnavailableError):
                encode_via_pydub(signal(), "mp3")

        assert calls == 2


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
