"""The Celery application, as a shell over :mod:`musicstudio_dsp.pipeline`.

Design §2.3 and §11.3 put the DSP work in a Celery worker behind a broker. This
module is the whole of that arrangement, and it is deliberately thin: each task
decodes its transport encoding, calls one function from
:mod:`musicstudio_dsp.pipeline`, and encodes the result. No DSP logic lives here.

### Why the shell is this thin

**No broker is reachable from a test environment**, and none should be needed.
A task body containing real behaviour can only be tested by either standing up
Redis or by calling ``.apply()`` and pretending. Both are worse than the
alternative, which is that the behaviour lives in plain functions that the tests
call directly and the tasks contain nothing worth testing. What *is* tested here
is the shell's own contract: that each task is registered, that its transport
encoding round-trips, and that ``.run()`` reaches the pipeline. None of that
touches a connection.

Consequently ``celery_app`` is built but never connected at import time —
constructing a ``Celery`` object performs no I/O, and the broker URL is read from
the environment so an unset variable yields an app that simply has nowhere to
send work rather than one that fails to import.

### Transport encoding

Audio is bytes and the serializer is JSON, so the task boundary carries
base64 text. That is a stopgap and is marked as one: a production topology sends
an object locator and lets the worker read storage, which is the ``{kind:
'stored', objectKey}`` arm of ``MeasurementSubject`` in
``services/sound/measurement.ts``. There is no object store in the product layer
yet, so there is nothing to name; when one arrives, the change is confined to
these shells because the pipeline functions already take bytes.

Pickle is *not* enabled to avoid the base64 overhead. A broker that accepts
pickled payloads executes whatever it is sent, and the worker sits behind a
public API surface (Requirement 17).
"""

from __future__ import annotations

import base64
import os
from typing import Any, Final

from celery import Celery

from .effects import apply_chain, parse_chain
from .formats import AudioFormat, decode, encode
from .pipeline import (
    STORAGE_FORMAT,
    convert_for_download,
    normalise_for_storage,
)

__all__ = [
    "DEFAULT_BROKER_URL",
    "DEFAULT_RESULT_BACKEND",
    "apply_effect_chain_task",
    "celery_app",
    "convert_for_download_task",
    "normalise_for_storage_task",
]

#: Overridden per environment. Design §11.3's topology supplies the real one.
DEFAULT_BROKER_URL: Final[str] = "redis://localhost:6379/0"
DEFAULT_RESULT_BACKEND: Final[str] = "redis://localhost:6379/1"

celery_app = Celery(
    "musicstudio_dsp",
    broker=os.environ.get("MUSICSTUDIO_DSP_BROKER_URL", DEFAULT_BROKER_URL),
    backend=os.environ.get("MUSICSTUDIO_DSP_RESULT_BACKEND", DEFAULT_RESULT_BACKEND),
)

celery_app.conf.update(
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    # One task per process at a time. Part of design §5.5's determinism rule;
    # the other part, a single BLAS thread, cannot be set from here — the
    # thread-pool size is fixed when NumPy loads its backend, which has already
    # happened by the time this module is imported. It belongs in the worker
    # container's environment (`OMP_NUM_THREADS=1` and the vendor-specific
    # equivalents), and design §11.3's topology is where that is declared.
    worker_prefetch_multiplier=1,
    task_acks_late=True,
    timezone="UTC",
    enable_utc=True,
)


@celery_app.task(name="musicstudio_dsp.normalise_for_storage")
def normalise_for_storage_task(
    audio_base64: str, audio_format: AudioFormat = STORAGE_FORMAT
) -> dict[str, Any]:
    """Requirements 19.4, 19.5. Shell over :func:`pipeline.normalise_for_storage`."""
    result = normalise_for_storage(base64.b64decode(audio_base64), audio_format)
    return {
        "audio_base64": base64.b64encode(result.data).decode("ascii"),
        "audio_format": result.audio_format,
        "duration_ms": result.shape.duration_ms,
        "sample_rate": result.shape.sample_rate,
        "channels": result.shape.channels,
        "original_sample_rate": result.original_sample_rate,
        "original_duration_ms": result.original_duration_ms,
        "length_error_ms": result.length_error_ms,
        "resampled": result.resampled,
    }


@celery_app.task(name="musicstudio_dsp.convert_for_download")
def convert_for_download_task(
    audio_base64: str, audio_format: AudioFormat
) -> dict[str, Any]:
    """Requirements 13.3, 13.9, 13.10. Shell over :func:`pipeline.convert_for_download`."""
    result = convert_for_download(base64.b64decode(audio_base64), audio_format)
    return {
        "audio_base64": base64.b64encode(result.data).decode("ascii"),
        "audio_format": result.audio_format,
        "sample_rate": result.sample_rate,
        "channels": result.audio.channel_count,
        "duration_ms": result.audio.duration_ms,
        "lossless": result.lossless,
        "length_error_ms": result.resample.length_error_ms,
    }



@celery_app.task(name="musicstudio_dsp.apply_effect_chain")
def apply_effect_chain_task(
    audio_base64: str, chain_document: str, audio_format: AudioFormat = STORAGE_FORMAT
) -> dict[str, Any]:
    """Requirements 29.12, 29.29–29.32. Shell over :func:`effects.apply_chain`.

    The chain arrives as a JSON *string* rather than as a decoded list, so that the
    task's transport encoding is the same document Requirement 29.24's ``Chain_Printer``
    produces and Requirement 29.33's ``Chain_Parser`` accepts. A pre-decoded list would
    let the JSON serialiser on the queue reshape numbers before
    :func:`effects.validate_chain` ever saw them.

    Requirement 29.28's preview and Requirement 29.14's version write are both the
    product layer's decisions (``services/effects/``): this task returns processed
    audio and says nothing about whether it should be stored.
    """
    result = apply_chain(decode(base64.b64decode(audio_base64)), parse_chain(chain_document))
    return {
        "audio_base64": base64.b64encode(encode(result.audio, audio_format)).decode("ascii"),
        "audio_format": audio_format,
        "sample_rate": result.audio.sample_rate,
        "channels": result.audio.channel_count,
        "frame_count": result.audio.frame_count,
        "duration_ms": result.duration_ms,
        "original_duration_ms": result.original_duration_ms,
        "tail_truncated": result.tail_truncated,
    }
