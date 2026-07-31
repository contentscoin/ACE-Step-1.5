"""The ``pydub``/``ffmpeg`` fallback boundary for format conversion (design §5.5).

Design §5.5 names ``pydub`` the *fallback* for format conversion, and
:mod:`musicstudio_dsp.formats` is the primary path built on ``libsndfile``. This
module is the seam to the fallback, and it exists to make one fact explicit
rather than implicit:

**``pydub`` is not a library dependency, it is a subprocess dependency.** Its
mp3 and ogg paths shell out to an ``ffmpeg`` or ``avconv`` binary. So whether
the fallback works is a question about the *machine*, not about the installed
wheels — and a question that cannot be answered at import time and then
forgotten, because a container can be rebuilt without the binary.

Consequences, all deliberate:

* ``pydub`` is declared in the ``audio`` extra of ``pyproject.toml``, not in the
  default dependency set, alongside the other components that need something
  from outside pip. The default install stays able to run lint, type checks and
  the property harness.
* ``pydub`` is imported lazily. Importing it emits a ``RuntimeWarning`` when no
  ``ffmpeg`` is on ``PATH``, and a module that warns on import would make every
  unrelated test in the suite noisy on a machine without the binary.
* :func:`codec_backend_status` reports availability as data. The tests for the
  fallback skip on it with that string as the reason, the same way
  ``test/integration/db-schema.test.ts`` skips when no PostgreSQL is reachable.
  A skipped test that says why is honest; a test that quietly passes because it
  never reached the encoder is not.

The same missing binary is what blocks the ``ffprobe``-based video probe and the
preview mux that ``services/sound/v2a-ports.ts`` names as integration points.
Those are not implemented here — this module is only the audio codec seam — but
:func:`ffmpeg_binary` is the check they will share.
"""

from __future__ import annotations

import io
import shutil
from dataclasses import dataclass
from importlib.util import find_spec
from typing import Final

import numpy as np

from .audio_buffer import AudioBuffer, to_interleaved
from .formats import AudioFormat, decode

__all__ = [
    "FFMPEG_CANDIDATES",
    "CodecBackendStatus",
    "CodecBackendUnavailableError",
    "codec_backend_status",
    "decode_via_pydub",
    "encode_via_pydub",
    "ffmpeg_binary",
    "pydub_available",
]

#: Checked in order. ``avconv`` is the fork ``pydub`` also accepts.
FFMPEG_CANDIDATES: Final[tuple[str, ...]] = ("ffmpeg", "avconv")


class CodecBackendUnavailableError(RuntimeError):
    """Raised when the ``pydub`` fallback is asked to run without its backend."""

    def __init__(self, reason: str) -> None:
        super().__init__(f"pydub codec fallback unavailable: {reason}")
        self.reason = reason


@dataclass(frozen=True)
class CodecBackendStatus:
    """Whether the fallback can run, and if not, why not."""

    available: bool
    reason: str


def ffmpeg_binary() -> str | None:
    """Path to an ``ffmpeg``-compatible binary, or ``None`` when there is none."""
    for candidate in FFMPEG_CANDIDATES:
        found = shutil.which(candidate)
        if found is not None:
            return found
    return None


def pydub_available() -> bool:
    """True when the ``pydub`` wheel is importable, regardless of ``ffmpeg``."""
    return find_spec("pydub") is not None


def codec_backend_status() -> CodecBackendStatus:
    """Report fallback availability as data, for a caller or a skip reason."""
    if not pydub_available():
        return CodecBackendStatus(
            available=False,
            reason="pydub is not installed (declared in the 'audio' extra)",
        )
    if ffmpeg_binary() is None:
        return CodecBackendStatus(
            available=False,
            reason=(
                "no ffmpeg or avconv binary on PATH; pydub's mp3/ogg codecs are "
                "subprocess-based and cannot run without one"
            ),
        )
    return CodecBackendStatus(available=True, reason="pydub and ffmpeg both present")


def encode_via_pydub(audio: AudioBuffer, audio_format: AudioFormat) -> bytes:
    """Encode through ``pydub``, the design §5.5 fallback.

    Raises :class:`CodecBackendUnavailableError` rather than degrading, because
    a silent degradation here would return audio in a format the caller did not
    ask for and Requirement 13.3 promises the requested one.

    The float buffer is handed to ``pydub`` as 16-bit interleaved PCM, which is
    ``pydub``'s native width. That is a real loss of precision relative to the
    24-bit primary path, and it is the second reason this is a fallback rather
    than an alternative: nothing should reach it while ``libsndfile`` can serve
    the format.
    """
    status = codec_backend_status()
    if not status.available:
        raise CodecBackendUnavailableError(status.reason)

    # Deferred deliberately: importing pydub emits a RuntimeWarning when no
    # ffmpeg is on PATH, and a module-level import would make every unrelated
    # test in the suite noisy on a machine without the binary.
    from pydub import AudioSegment

    interleaved = to_interleaved(audio)
    quantised = np.clip(interleaved, -1.0, 1.0)
    pcm16 = (quantised * 32767.0).astype("<i2")

    segment = AudioSegment(
        data=pcm16.tobytes(),
        sample_width=2,
        frame_rate=audio.sample_rate,
        channels=audio.channel_count,
    )
    target = io.BytesIO()
    segment.export(target, format=audio_format)
    return target.getvalue()


def decode_via_pydub(data: bytes) -> AudioBuffer:
    """Decode through the fallback. Present for symmetry with the encode path.

    Delegates to :func:`musicstudio_dsp.formats.decode` once the bytes are in a
    container ``libsndfile`` reads, which is what ``pydub`` produces after
    ``ffmpeg`` has normalised them. Kept here so the availability check stays in
    one module.
    """
    status = codec_backend_status()
    if not status.available:
        raise CodecBackendUnavailableError(status.reason)

    from pydub import AudioSegment  # deferred for the reason above

    segment = AudioSegment.from_file(io.BytesIO(data))
    wav = io.BytesIO()
    segment.export(wav, format="wav")
    return decode(wav.getvalue())
