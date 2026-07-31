"""MusicStudio DSP worker package (design §5, §12).

The base pipeline of design §5.1–§5.2 lives here: the PCM buffer shape
(:mod:`musicstudio_dsp.audio_buffer`), 48 kHz normalisation with ``libsoxr`` VHQ
(:mod:`musicstudio_dsp.resample`), container conversion for the four download
formats (:mod:`musicstudio_dsp.formats`), the composed operations
(:mod:`musicstudio_dsp.pipeline`), and the Celery shell over them
(:mod:`musicstudio_dsp.worker`). Effect processing, loudness normalisation,
onset detection and the mixdown chain are added by the tasks that own them.

:mod:`musicstudio_dsp.worker` is the only module that imports Celery, and it is
imported lazily by nothing else, so the pipeline is usable and testable with no
broker in sight.

This package never imports ``acestep``; the engine is reached only through the
``ACE_Engine_Adapter`` HTTP interface (design §1.4.4).
"""

from .audio_buffer import AudioBuffer, from_interleaved, to_interleaved, window_sample_count
from .formats import (
    DOWNLOAD_FORMATS,
    LOSSLESS_FORMATS,
    SFX_DOWNLOAD_FORMATS,
    AudioFormat,
    UnsupportedFormatError,
    convert,
    decode,
    encode,
)
from .pipeline import (
    AssetAudioShape,
    NormalisedAudio,
    convert_for_download,
    describe_audio,
    normalise_for_storage,
)
from .resample import (
    INTERNAL_SAMPLE_RATE,
    LENGTH_TOLERANCE_MS,
    RESAMPLE_QUALITY,
    LengthToleranceExceededError,
    ResampleReport,
    normalise_sample_rate,
    normalise_sample_rate_strict,
    resample,
)

__all__ = [
    "AssetAudioShape",
    "AudioBuffer",
    "AudioFormat",
    "DOWNLOAD_FORMATS",
    "INTERNAL_SAMPLE_RATE",
    "LENGTH_TOLERANCE_MS",
    "LOSSLESS_FORMATS",
    "LengthToleranceExceededError",
    "NormalisedAudio",
    "RESAMPLE_QUALITY",
    "ResampleReport",
    "SFX_DOWNLOAD_FORMATS",
    "UnsupportedFormatError",
    "__version__",
    "convert",
    "convert_for_download",
    "decode",
    "describe_audio",
    "encode",
    "from_interleaved",
    "normalise_for_storage",
    "normalise_sample_rate",
    "normalise_sample_rate_strict",
    "resample",
    "to_interleaved",
    "window_sample_count",
]

__version__ = "0.0.0"
